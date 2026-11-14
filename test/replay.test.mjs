import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/index.mjs';
import { journalSpec } from '../src/domain.mjs';

async function fixture(t,{rules='Use ES modules.'}={}) {
  const repo = await mkdtemp(join(tmpdir(), 'journal-replay-test-'));
  t.after(() => rm(repo, {recursive:true, force:true}));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding:'utf8'}).trim();
  git('init','-q');
  const file = join(repo, 'src', 'app.js');
  await mkdir(join(repo,'src'));
  await writeFile(file, 'export const value = "before";\n');
  await writeFile(join(repo,'AGENTS.md'), rules);
  await writeFile(join(repo,'stable.js'), 'export const stable = true;');
  await writeFile(join(repo,'obsolete.js'), 'export const obsolete = true;');
  await writeFile(join(repo,'.env'), 'SAMPLE=private');
  if(process.platform!=='win32')await symlink(file,join(repo,'link.js'));
  git('add','.');
  const commit = title => {git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm',title);return git('rev-parse','HEAD');};
  const base = commit('Start project');
  await rm(join(repo,'obsolete.js'));
  await writeFile(join(repo,'new-solution.js'), 'export const answer = true;');
  await writeFile(file,'export const value = "REFERENCE_ONLY";\n');
  const reference = commit('Approved delivery');
  await writeFile(file,'UNCOMMITTED_WORK');
  const humans = [{seq:1,time:10,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Improve the value'}]}},
    {seq:2,time:12,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'CORRECTION_ONLY'}]}},
    {seq:3,time:40,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Extra input'}]}}];
  const log = {session:{id:'one',cwd:repo},events:[...humans,{seq:4,type:'request/header',data:{header:{config:{provider:'fixture',model:'one'}}}}]};
  const tables = new Map(), calls=[], mode={};
  const domain = {table(name){if(!tables.has(name))tables.set(name,new Map());const map=tables.get(name);return {get:key=>map.get(key),entries:()=>map.entries(),put:async(key,val)=>{map.set(key,journalSpec.tables[name].valueSchema.parse(val));}};},close:async()=>{}};
  let handler, dispose;
  const ctx = {storageDomain:{open:async()=>domain},sessionQuery:{readSession:async()=>structuredClone(log)},workspaceRegistry:{list:()=>[{path:repo,sessionIds:['one']}]},
    llm:{prepareCall:async config=>({config,async *stream(opts){
      const input=JSON.parse(opts.messages[0].content[0].text);calls.push({input,sessionId:opts.sessionId});
      if(mode.hold && input.kind==='replay-code'){await new Promise(resolve=>opts.signal.addEventListener('abort',resolve,{once:true}));opts.signal.throwIfAborted();}
      if(mode.fail && input.kind==='replay-code')throw new Error('provider unavailable');
      const output=input.kind==='replay-author'?{text:'修改同一模块时先列出已有对外行为，再核对兼容性。'}:input.kind==='replay-rule'?{id:mode.skip?'none':'preserve-behavior',reason:'CORRECTION_ONLY'}:
        {files:[{path:mode.escape?'../escape.js':'src/app.js',text:'export const value = "new";\n'}]};
      yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}};
    }})},effect(fn){const end=fn();if(typeof end==='function')dispose=end;},connection:{fetch:{register(endpoint){handler=endpoint;}}}};
  await apply(ctx);
  const api=async(action,data={})=>{const res=await handler.fetch(new Request('http://localhost/api',{method:'POST',body:JSON.stringify({action,id:'one',...data})}));const json=await res.json();if(!json.ok)throw Object.assign(Error(json.error),{status:res.status});return json.value;};
  const setup=()=>api('replayConfigure',{base,reference,paths:['src/app.js'],extraSeqs:[3]});
  const done=async()=>{for(let i=0;i<300;i++){const state=await api('replayState');if(state.run?.status!=='running')return state;await new Promise(r=>setTimeout(r,10));}throw Error('replay timed out');};
  t.after(()=>dispose?.());
  return {api,setup,done,base,reference,calls,mode,log,file,repo,domain};
}

test('favorites freeze human expressions, need no Git snapshot, and never dispatch a model',async t=>{
  const h=await fixture(t);
  const saved=await h.api('replayFavorite');
  h.log.events[0].data.content[0].text='changed later';
  assert.equal(saved.favorite,true);
  assert.equal(saved.scene,null);
  assert.deepEqual((await h.api('replayFavorites')).ids,['one']);
  assert.equal((await h.api('replayState')).humans[0].text,'Improve the value');
  assert.equal(h.calls.length,0);
  await h.api('replayUnfavorite');
  assert.deepEqual((await h.api('replayFavorites')).ids,[]);
});

test('two isolated runs receive original task, chosen extra and identical source, never held-back corrections or approved code',async t=>{
  const h=await fixture(t);
  await h.api('replayFavorite');
  const {commits}=await h.api('replayCommits');
  assert.ok(commits.some(c=>c.sha===h.base)); assert.ok(commits.some(c=>c.sha===h.reference));
  const {paths}=await h.api('replayPaths',{base:h.base,reference:h.reference});
  assert.ok(paths.includes('src/app.js'));assert.ok(!paths.includes('.env'));assert.ok(!paths.includes('link.js'));
  const state=await h.setup();assert.equal(state.scene.referencePaths[0].text,'export const value = "REFERENCE_ONLY";\n');
  await h.api('replayStart');
  const {run}=await h.done();assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(run.modelCalls,4);
  const [researcher,author,baseline,candidate]=h.calls;assert.ok(JSON.stringify(researcher.input).includes('CORRECTION_ONLY'));
  assert.deepEqual(Object.keys(author.input).sort(),['category','kind']);
  assert.doesNotMatch(JSON.stringify(author.input),/CORRECTION_ONLY|Improve the value|REFERENCE_ONLY|Extra input|before|ES modules/);
  assert.equal(run.rule.text,'修改同一模块时先列出已有对外行为，再核对兼容性。');
  for(const {input} of [baseline,candidate]){
    assert.deepEqual(input.requests.map(r=>r.text),['Improve the value','Extra input']);
    assert.equal(input.files[0].text,'export const value = "before";\n');
    assert.doesNotMatch(JSON.stringify(input),/CORRECTION_ONLY|REFERENCE_ONLY|UNCOMMITTED_WORK/);
  }
  assert.notEqual(baseline.sessionId,candidate.sessionId);
  assert.equal(baseline.input.rules,'Use ES modules.');assert.ok(candidate.input.rules.includes(run.rule.text));
  assert.equal(run.candidate.files[0].text,'export const value = "new";\n');
  assert.equal(await readFile(h.file,'utf8'),'UNCOMMITTED_WORK');
  assert.equal(await readFile(join(h.repo,'AGENTS.md'),'utf8'),'Use ES modules.');
  await h.api('replayReview',{runId:run.runId,choice:'reference',note:'I prefer the original'});
  h.mode.fail=true;await h.api('replayStart');
  const next=await h.done();assert.equal(next.run.status,'failed');assert.equal(next.previous.review.note,'I prefer the original');
  assert.deepEqual(next.previous.scene.referencePaths,run.scene.referencePaths);
});

test('only files known at the start can be selected, including files later deleted', async t => {
  const h = await fixture(t);
  await h.api('replayFavorite');
  const versions = {base:h.base, reference:h.reference};
  const {paths} = await h.api('replayPaths', versions);
  assert.ok(paths.includes('obsolete.js'));
  assert.ok(!paths.includes('new-solution.js'), 'reference-only path appeared among replay inputs');
  await assert.rejects(h.api('replayConfigure',{...versions, paths:['new-solution.js'], extraSeqs:[]}));
  const {scene} = await h.api('replayConfigure',{...versions, paths:['obsolete.js'], extraSeqs:[]});
  assert.deepEqual(scene.referencePaths,[{path:'obsolete.js', text:null}]);
});

test('favorites preserve expressions with missing or invalid timestamps', async t => {
  const h = await fixture(t);
  delete h.log.events[0].time;
  h.log.events[1].time = NaN;
  const {humans} = await h.api('replayFavorite');
  assert.deepEqual(humans.map(({time})=>time),[null,null,40]);
  assert.deepEqual(humans.map(({seq})=>seq),[1,2,3]);
});

test('a previously saved scene containing a reference-only path cannot leak it when restarted', async t => {
  const h = await fixture(t);
  await h.api('replayFavorite');
  await h.setup();
  const table = h.domain.table('replay_cases');
  const record = table.get('one');
  record.scene.sources.push({path:'new-solution.js',text:null});
  record.scene.paths.push('new-solution.js');
  record.scene.referencePaths.push({path:'new-solution.js',text:'export const answer = true;'});
  await table.put('one',record);
  await assert.rejects(h.api('replayStart'), /开工/);
  assert.equal(h.calls.length,0);
});

test('rejects unsupported file access, invented messages and paths emitted beyond the editing scope',async t=>{
  const h=await fixture(t);await h.api('replayFavorite');
  for(const paths of [['../app.js'],['.env'],['AGENTS.md'],['missing.js']]){
    await assert.rejects(h.api('replayConfigure',{base:h.base,reference:h.reference,paths,extraSeqs:[]}));
  }
  await assert.rejects(h.api('replayConfigure',{base:'HEAD',reference:h.reference,paths:['src/app.js'],extraSeqs:[]}));
  await assert.rejects(h.api('replayConfigure',{base:h.base,reference:h.reference,paths:['src/app.js'],extraSeqs:[444]}));
  assert.equal(h.calls.length,0);
  await h.setup();h.mode.escape=true;await h.api('replayStart');assert.equal((await h.done()).run.status,'failed');
  h.mode.skip=true;await h.api('replayStart');const {run}=await h.done();assert.equal(run.status,'skipped');assert.equal(run.modelCalls,1);
});

test('rejects reference as the start, reversed versions and scope without observable reference change',async t=>{
  const h=await fixture(t);await h.api('replayFavorite');
  for(const [base,reference,paths] of [[h.base,h.base,['src/app.js']],[h.reference,h.base,['src/app.js']],[h.base,h.reference,['stable.js']]]){
    await assert.rejects(h.api('replayConfigure',{base,reference,paths,extraSeqs:[]}));
  }
  assert.equal((await h.api('replayState')).scene,null);
  assert.equal(h.calls.length,0);
});

test('discloses the exact frozen base rules before dispatch, refuses known credential formats before model calls',async t=>{
  const h=await fixture(t,{rules:'Stay focused.\nservice key = "sk-abcdefghijklmnopqrstuvwxyz12345678"'});await h.api('replayFavorite');
  const state=await h.setup();
  assert.equal(state.scene.baseRules,'Stay focused.\nservice key = "sk-abcdefghijklmnopqrstuvwxyz12345678"');
  await assert.rejects(h.api('replayStart'),/凭证/);
  assert.equal(h.calls.length,0);
});
test('duplicate starts are rejected, cancellation preserves a reviewed completion and dispatch counters are durable',async t=>{
  const h=await fixture(t);await h.api('replayFavorite');await h.setup();
  await h.api('replayStart');const completed=(await h.done()).run;
  await h.api('replayReview',{runId:completed.runId,choice:'reference',note:'chosen'});
  h.mode.hold=true;
  const [start,duplicate]=await Promise.allSettled([h.api('replayStart'),h.api('replayStart')]);
  assert.equal(start.status,'fulfilled');assert.equal(duplicate.reason?.status,409);
  for(let i=0;i<300&&h.calls.length<7;i++)await new Promise(r=>setTimeout(r,10));
  const saved=h.domain.table('replay_results').get('one');
  assert.equal(saved.run.modelCalls,3);assert.equal(saved.run.stage,'用原有规则生成交付');
  await h.api('replayCancel');
  const after=await h.done();assert.equal(after.run.status,'interrupted');
  assert.equal(after.run.modelCalls,3);assert.equal(after.previous.review.note,'chosen');
});
