// Real OpenCode executable + a deterministic local model protocol fixture.
// This verifies integration, not the quality or availability of a hosted LLM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runProcess, OpenCode, parseJSON } from '../src/opencode.mjs';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Engine } from '../src/engine.mjs';
import { createServer } from '../src/server.mjs';
import { today, addDays, bounds, monday } from '../src/time.mjs';

const binary = process.env.OPENCODE_TEST_BIN || 'opencode';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'journal integration 中文 '));
const checks = [], requests = [];
let store, app, failureMode = false;
const pass = name => { checks.push(name); console.log(`PASS ${name}`); };
for (const [key, value] of Object.entries({
  XDG_CONFIG_HOME: path.join(root,'config'), XDG_DATA_HOME: path.join(root,'data'),
  XDG_CACHE_HOME: path.join(root,'cache'), XDG_STATE_HOME: path.join(root,'state'),
  OPENCODE_DISABLE_AUTOUPDATE:'true', OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',
  OPENCODE_DISABLE_MODELS_FETCH:'true', OPENCODE_DISABLE_CLAUDE_CODE:'true',
})) { process.env[key] = value; }
// Prevent caller configuration from redirecting a test to a real provider.
for (const key of ['OPENCODE_CONFIG','OPENCODE_CONFIG_CONTENT','OPENCODE_CONFIG_DIR','OPENCODE_AUTO_SHARE']) delete process.env[key];

const fixture = http.createServer(async (req,res) => {
  try {
    const chunks=[];for await (const c of req) chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks).toString());
    const texts=(body.messages||[]).filter(m=>m.role==='user').flatMap(m=>typeof m.content==='string'?[m.content]:(m.content||[]).filter(p=>p.type==='text').map(p=>p.text));
    const material=texts.find(t=>t.includes('{"instructions":'));
    let text='收到；这是协议测试的固定回复。';
    if(material){
      const input=JSON.parse(material.slice(material.indexOf('{"instructions":')).split(/\r?\n/)[0]);
      requests.push({task:input.task,data:input.data,tools:(body.tools||[]).length});
      if(failureMode){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'intentional integration failure',type:'invalid_request_error'}}));}
      if(input.task==='daily-events'){
        const m=input.data.messages.find(m=>m.targetDay&&m.role==='user');
        assert(m,'daily payload must contain the original user message');
        text=JSON.stringify({events:[{title:'指定测试任务范围',category:'方向校准',summary:'协议测试事件',intent:'核对范围',intervention:'明确范围',outcome:'未知',evidence:[{sessionId:m.sessionId,messageIds:[m.id]}]}]});
      }else if(input.task==='daily-summary')text=JSON.stringify({overview:'协议测试日报，非真实模型归纳。',observations:[],questions:['是否需要继续观察？']});
      else if(input.task==='weekly'){
        const events=input.data.reviews.filter(r=>r.events.length).slice(0,2).map(r=>r.events[0].id);
        text=JSON.stringify({overview:'协议测试周总结。',patterns:events.length===2?[{title:'跨日观察',observation:'协议测试模式',eventIds:events}]:[],questions:[]});
      }else throw new Error('Unknown analysis task');
    }
    const base={id:'chatcmpl-fixture',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:body.model};
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
    res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\n');
    res.write('data: '+JSON.stringify({...base,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\n');
    res.end('data: [DONE]\n\n');
  }catch(error){console.error('Fixture error:',error.message);res.writeHead(500);res.end('fixture failure');}
});

try {
  fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
  const ocConfig={model:'fixture/reviewer',small_model:'fixture/reviewer',enabled_providers:['fixture'],permission:'deny',share:'disabled',provider:{fixture:{npm:'@ai-sdk/openai-compatible',name:'Local protocol fixture',options:{baseURL:`http://127.0.0.1:${fixture.address().port}/v1`,apiKey:'local-test-only'},models:{reviewer:{name:'Protocol fixture',limit:{context:128000,output:4000}}}}}};
  fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME,'opencode'),{recursive:true});
  fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME,'opencode','opencode.json'),JSON.stringify(ocConfig));
  const projects=[path.join(root,'project A 中文'),path.join(root,'project B')];
  for(const dir of projects){fs.mkdirSync(dir,{recursive:true});await runProcess('git',['init'],{cwd:dir});await runProcess('git',['-c','user.name=Integration','-c','user.email=integration@example.invalid','commit','--allow-empty','-m',path.basename(dir)],{cwd:dir});}
  const command=async(args,cwd=projects[0],input)=>runProcess(binary,args,{cwd,input,timeoutMs:120000});
  const version=(await command(['--version'])).stdout.trim();console.log(`OpenCode ${version} on ${process.platform}`);
  const currentDay=today(), firstDay=addDays(currentDay,-2), secondDay=addDays(currentDay,-1);
  const configFile=path.join(root,'journal-config.json');
  fs.writeFileSync(configFile,JSON.stringify({opencodeCommand:binary,dataDir:path.join(root,'journal'),projects,startDate:firstDay,timeoutMs:120000}));
  process.env.JOURNAL_CONFIG=configFile;
  const config=loadConfig();store=new Store(path.join(config.dataDir,'journal.sqlite'));
  const adapter=new OpenCode(config,store),engine=new Engine(config,store,adapter);
  const diagnosis=await adapter.doctor();assert.equal(diagnosis.model,'fixture/reviewer');assert(!JSON.stringify(diagnosis).includes('local-test-only'));pass('doctor resolves the analysis model without exposing credentials');
  const empty=await adapter.collect();assert.equal(empty.imported,0);assert.equal(empty.scannedProjects.length,2);pass('empty project output is accepted');
  const sessions=[];
  for(const dir of projects){
    const first=await command(['run','--format','json','--title','Integration source'],dir,'测试项目：先梳理购买入口，不要修改容器。');
    const lines=first.stdout.trim().split(/\r?\n/).map(l=>JSON.parse(l));
    const id=lines.find(e=>e.sessionID)?.sessionID;assert(id,'real CLI must create a session');
    await command(['run','--format','json','--session',id],dir,'第二轮：昨天的会话今天继续；只调整入口跳转。');
    let exported=parseJSON((await command(['export',id],dir)).stdout);
    assert.equal(exported.messages.filter(m=>m.info.role==='user').length,2);
    // Time travel only fixture timestamps via official import; never edit user history.
    // Newer OpenCode imports preserve existing messages, so import a new fixture identity.
    const ids=[exported.info.id,...exported.messages.flatMap(m=>[m.info.id,...m.parts.map(p=>p.id)])];
    const remap=new Map(ids.map(id=>[id,id.split('_')[0]+'_'+randomUUID().replaceAll('-','')]));
    exported=JSON.parse(JSON.stringify(exported,(key,value)=>typeof value==='string'?(remap.get(value)||value):value));
    exported.info.time.created=bounds(firstDay).start-86400000*7;
    exported.info.time.updated=bounds(secondDay).start+10000;
    let users=0,index=0;
    for(const m of exported.messages){
      if(m.info.role==='user')users++;
      m.info.time.created=bounds(users<=1?firstDay:secondDay).start+1000+(index++)*100;
      if(m.info.time.completed)m.info.time.completed=m.info.time.created+10;
    }
    const file=path.join(dir,'fixture-session.json');fs.writeFileSync(file,JSON.stringify(exported));
    await command(['import',file],dir);sessions.push(exported.info.id);store.exclude(id);
  }
  pass('native CLI creates, continues, exports and imports sessions');
  const collection=await adapter.collect();
  if(collection.imported!==2){
    console.error('Synthetic collection diagnostics:',JSON.stringify({collection,projects,sessions}));
    for(const dir of projects)console.error('Native session list:',dir,(await command(['session','list','--format','json'],dir)).stdout);
  }
  assert.equal(collection.imported,2);assert.deepEqual(new Set(store.sessions().map(s=>s.id)),new Set(sessions));pass('two independent Git projects are collected');
  const first=await engine.start('daily',firstDay).done;
  const second=await engine.start('daily',secondDay).done;
  assert.equal(first.events.length,2);assert.equal(second.events.length,2);assert.equal(second.coverage.userMessages,2);
  assert(requests.some(r=>r.task==='daily-events'&&r.data.messages.some(m=>!m.targetDay)));
  assert(requests.every(r=>r.tools===0),'review requests must expose no tools');
  pass('default model receives original stdin material; old sessions and cross-day context work');
  config.projects.push(config.runnerDir);
  const withAnalysis=await adapter.collect();assert(withAnalysis.excluded>collection.excluded);assert.equal(withAnalysis.imported,2);
  pass('analysis sessions are excluded from subsequent collection');
  // Exercise the public HTTP contract consumed by the browser.
  app=createServer(config,store,engine);app.listen(0,'127.0.0.1');await once(app,'listening');
  const base=`http://127.0.0.1:${app.address().port}`;
  const api=async(url,options)=>{const r=await fetch(base+url,options);assert(r.ok,await r.clone().text());return r.json();};
  const read=await api('/api/reviews/'+secondDay), event=read.events[0];
  const context=await api(`/api/events/${event.id}/context?full=1`);
  assert(context.messages.some(m=>m.parts.some(p=>p.text?.includes('昨天的会话今天继续'))));
  await api(`/api/events/${event.id}/reflection`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({note:'保留这条人工思考',category:'范围澄清',follow:true})});
  await engine.start('daily',secondDay).done;
  assert.equal((await api('/api/reviews/'+secondDay)).events.find(e=>e.id===event.id).reflection.note,'保留这条人工思考');
  const markdown=await fetch(base+'/api/export/'+secondDay).then(r=>r.text());assert(markdown.includes('保留这条人工思考'));
  pass('HTTP context, reflection, rerun and Markdown export persist');
  await engine.due();assert.equal((await engine.due()).length,0);pass('due is idempotent after completed daily reviews');
  if(monday(firstDay)===monday(secondDay)){
    const week=await engine.start('weekly',monday(firstDay)).done;assert.equal(week.patterns.length,1);pass('weekly analysis references events from two days');
  }
  const before=store.review(secondDay).generatedAt;failureMode=true;
  await assert.rejects(engine.start('daily',secondDay).done);
  assert.equal(store.review(secondDay).generatedAt,before);assert.equal(store.runs()[0].status,'failed');
  pass('native model HTTP failure cannot overwrite an existing daily review');
  const manifest={opencode:version,platform:process.platform,checks,model:'local deterministic protocol fixture (not a real LLM)',generatedAt:new Date().toISOString()};
  if(process.env.INTEGRATION_REPORT)fs.writeFileSync(process.env.INTEGRATION_REPORT,JSON.stringify(manifest,null,2));
  console.log(JSON.stringify(manifest,null,2));
} catch(error) {
  // This environment contains synthetic fixtures only, so CLI diagnostics are safe in CI.
  if(error.stderr)console.error(error.stderr.slice(-4000));
  if(error.stdout)console.error(error.stdout.slice(-4000));
  throw error;
} finally {
  if(app)await new Promise(resolve=>app.close(resolve));
  store?.close();await new Promise(resolve=>fixture.close(resolve));
  if(process.env.KEEP_INTEGRATION_DATA==='1')console.log(`Fixture files: ${root}`);
  else fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
