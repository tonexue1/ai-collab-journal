import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../src/service.mjs';
import {apply} from '../src/index.mjs';
import {interventionBasisHash} from '../src/interventions.mjs';
import {protectDaySummaryInput} from '../src/day-summary.mjs';

const options={date:'2026-11-14',timeZone:'Asia/Shanghai'};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const human=(seq,time,text)=>({seq,time:Date.parse(time),type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}});
const ai=(seq,time)=>({seq,time:Date.parse(time),type:'assistant/message',data:{message:{source:{provider:'fixture',model:'one'},content:[{type:'text',text:'仍在讨论，尚未完成。'}]}}});
function harness(){
  const logs=new Map([
    ['a',[human(1,'2026-11-13T15:59:00Z','昨天的任务'),ai(2,'2026-11-13T16:00:00Z'),human(3,'2026-11-13T16:01:00Z','请先讨论\n今天不要写入。')]],
    ['b',[human(1,'2026-11-14T02:00:00Z','这次失败了，保留旧结果。'),ai(2,'2026-11-14T02:01:00Z')]],
    ['archive',[human(1,'2026-11-14T03:00:00Z','归档会话的表达'),ai(2,'2026-11-14T03:01:00Z')]],
  ]),tables=new Map(),calls=[],writes=[],gate=deferred(),writeGate=deferred(),state={hold:false,holdWrites:false,failed:false,invalid:false,closed:false};
  const domain={table:name=>({get:key=>structuredClone(tables.get(name)?.get(key)),put:async(key,value)=>{if(state.holdWrites)await writeGate.promise;assert.equal(state.closed,false);if(!tables.has(name))tables.set(name,new Map());tables.get(name).set(key,structuredClone(value));writes.push([name,key]);}}),close:async()=>{state.closed=true;}};
  const ctx={workspaceRegistry:{list:()=>[{id:'w1',title:'重名',sessionIds:['a']},{id:'w2',title:'重名',sessionIds:['b','archive']}],archivedSessionIds:['archive']},sessionQuery:{listSessions:async()=>[...logs.keys()].map(id=>({header:{id,origin:'main'}})).concat({header:{id:'child',origin:'subagent'}}),readSession:async id=>{const events=logs.get(id);if(!events)throw Error('unreadable');return{session:{id,origin:'main'},events:structuredClone(events)};}},llm:{prepareCall:async config=>({config,async *stream(request){
    const input=JSON.parse(request.messages[0].content[0].text);calls.push({input,signal:request.signal,system:request.system});if(state.hold)await gate.promise;if(state.failed)throw Error('fixture model unavailable');
    yield {type:'text-delta',index:0,text:state.invalid?'{"items":[]}':JSON.stringify({items:[{id:'day',summary:'今天讨论了项目约定，并反馈一次失败；约定尚未写入。',details:[]}]})};yield {type:'finish',reason:{kind:'stop'}};
  }})}};
  return {journal:new Journal(ctx,domain),ctx,domain,logs,tables,calls,writes,state,gate,writeGate};
}
async function finish(h,scope=options){assert.equal(typeof h.journal.generateDaySummary,'function');await h.journal.generateDaySummary(scope);await h.journal.dailyActive?.pending;return h.journal.daySummary(scope);}
async function until(condition){for(let i=0;i<100&&!condition();i++)await tick();assert.ok(condition(),'expected asynchronous stage becomes observable');}

test('read-only daily summary spans native workspaces and filters actual human dates without model calls',async()=>{
  const h=harness();assert.equal(typeof h.journal.daySummary,'function');const x=await h.journal.daySummary(options);
  assert.deepEqual(x.coverage,{sessionCount:2,humanCount:2});assert.equal(x.summary,null);assert.equal(x.canGenerate,true);assert.equal(h.calls.length,0);
  const archived=await h.journal.daySummary({...options,includeArchived:true});assert.deepEqual(archived.coverage,{sessionCount:3,humanCount:3});
  await assert.rejects(h.journal.daySummary({...options,date:'2026-02-30'}),e=>e.status===400);await assert.rejects(h.journal.daySummary({timeZone:'UTC'}),e=>e.status===400);
});
test('generation preserves all selected human expressions and persists a reloadable summary with distinct native workspaces',async()=>{
  const h=harness(),x=await finish(h);assert.equal(x.run.status,'completed');assert.equal(x.run.modelCalls,1);assert.equal(x.stale,false);assert.equal(x.summary.humanCount,2);
  assert.deepEqual(x.summary.sources.map(s=>s.workspaceId),['w1','w2']);assert.deepEqual(x.summary.sources.map(s=>s.humanSeqs),[[3],[1]]);
  assert.deepEqual(h.calls[0].input.sessions.flatMap(s=>s.humans.map(h=>h.text)),['请先讨论\n今天不要写入。','这次失败了，保留旧结果。']);
  const reopened=new Journal(h.ctx,h.domain),saved=await reopened.daySummary(options);assert.equal(saved.summary.text,x.summary.text);assert.equal(saved.summary.generatedAt,x.summary.generatedAt);assert.equal(saved.run,null);assert.equal(h.calls.length,1);
});
test('existing analysis dates every cited source so yesterday’s success stays separate from today’s pause',async()=>{
  const h=harness(),events=h.logs.get('a');
  events[0]=human(1,'2026-11-13T15:59:00Z','昨天的检查已通过');events[2]=human(3,'2026-11-13T16:01:00Z','今天先暂停');
  const {entries}=await h.journal.source('a'),before={seq:1,quote:'检查已通过'},pause={seq:3,quote:'今天先暂停'};
  const result={title:'暂停本次操作',before:{text:'此前检查通过',evidence:[before]},contribution:{text:'要求暂停',evidence:[pause]},categories:[{label:'流程推进',evidence:[before,pause]}],certainty:'supported'};
  const put=(table,key,value)=>h.domain.table(table).put(key,value);
  await put('interaction_versions','v',{resultId:'v',sessionId:'a',interactionId:'h3',basisHash:interventionBasisHash(entries,'h3'),result});
  await put('interaction_latest','a.h3',{resultId:'v'});
  await finish(h);const anchor=h.calls[0].input.sessions.find(s=>s.sessionId==='a').humans[0],analysis=anchor.analysis;
  assert.equal(anchor.text,'今天先暂停');
  assert.deepEqual(analysis.before.evidence[0],{...before,source:{time:events[0].time,date:'2026-11-13',isSelectedDay:false}});
  assert.deepEqual(analysis.contribution.evidence[0],{...pause,source:{time:events[2].time,date:'2026-11-14',isSelectedDay:true}});
  assert.deepEqual(analysis.categories[0].evidence,[analysis.before.evidence[0],analysis.contribution.evidence[0]]);
  events[0]=human(1,'2026-11-13T15:59:00Z','前文已修改');await finish(h);
  assert.equal(h.calls[1].input.sessions.find(s=>s.sessionId==='a').humans[0].analysis,undefined);
});
test('only changes to selected-day evidence mark a saved daily summary stale',async()=>{
  const h=harness(),first=await finish(h);h.logs.get('a').push(human(4,'2026-11-14T16:01:00Z','明天再讨论'));assert.equal((await h.journal.daySummary(options)).stale,false);
  h.logs.get('a').push(human(5,'2026-11-14T04:00:00Z','新增：仍未完成'));const stale=await h.journal.daySummary(options);assert.equal(stale.stale,true);assert.equal(stale.summary.text,first.summary.text);assert.equal(stale.coverage.humanCount,3);
});
test('daily model input masks local DSH launch credentials throughout the payload while preserving the native evidence',async()=>{
  const h=harness(),events=h.logs.get('a'),credential='synthetic-launch-credential-1234',marker='〔本机 DSH 凭证已隐藏〕';
  const ipv4=`http://127.0.0.1:19401/?tab=journal&token=${credential}&more=2#start`;
  const ipv6='https://[::1]:19401/?token=fixture-v6-2',local='HTTP://LOCALHOST:19401?token=fixture-local-3';
  const ordinary='http://localhost.example/?token=public-example https://example.org/?token=another-example';
  const prose=`请打开 [工作台](${ipv4})，然后检查 ${ipv6}。\n另一个入口 ${local}；不要动其他地址 ${ordinary}`;
  events[2]=human(3,'2026-11-13T16:01:00Z',prose);events.push({seq:4,type:'session/title',data:{title:`启动 ${ipv4}`}});
  const {entries}=await h.journal.source('a'),quote={seq:3,quote:credential};
  const result={title:ipv4,before:{text:'尚未运行',evidence:[]},contribution:{text:'提供本机链接',evidence:[quote]},categories:[{label:'上下文补充',evidence:[quote]}],certainty:'supported'};
  await h.domain.table('interaction_versions').put('v',{resultId:'v',sessionId:'a',interactionId:'h3',basisHash:interventionBasisHash(entries,'h3'),result});
  await h.domain.table('interaction_latest').put('a.h3',{resultId:'v'});
  const generated=await finish(h),input=h.calls[0].input,session=input.sessions.find(s=>s.sessionId==='a'),anchor=session.humans[0];
  assert.equal(generated.run.status,'completed');
  assert.equal(anchor.text,prose.replaceAll(credential,marker).replace('fixture-v6-2',marker).replace('fixture-local-3',marker));
  assert.equal(anchor.analysis.contribution.evidence[0].quote,marker);assert.equal(session.title,`启动 ${ipv4.replace(credential,marker)}`);
  assert.equal(input.redactions,7);assert.equal(generated.inputChars,JSON.stringify(input).length);
  assert.ok(!JSON.stringify(input).includes(credential));assert.ok(!JSON.stringify([...h.tables.get('day_summaries').values()]).includes(credential));
  assert.equal((await h.journal.interactions('a',options)).items[0].human.text,prose);
  assert.equal(h.tables.get('interaction_versions').get('v').result.contribution.evidence[0].quote,credential);
});
test('Chinese feedback directly following a launch credential survives and quoted copies of the credential stay hidden',()=>{
  const credential='fixture-separate-quoted-token',marker='〔本机 DSH 凭证已隐藏〕';
  const text=`http://localhost/?token=${credential}后续仍未完成`;
  const input=protectDaySummaryInput({text,evidence:[{quote:credential}]});
  assert.equal(input.text,`http://localhost/?token=${marker}后续仍未完成`);
  assert.equal(input.evidence[0].quote,marker);assert.equal(input.redactions,2);
});
test('failed generation preserves the previous result and exposes route, stage, calls and build diagnostics',async()=>{
  const h=harness(),first=await finish(h);h.state.failed=true;const failed=await finish(h);assert.equal(failed.run.status,'failed');assert.equal(failed.summary.generatedAt,first.summary.generatedAt);assert.equal(failed.summary.text,first.summary.text);
  const d=failed.run.diagnostic;assert.equal(d.modelCalls,1);assert.equal(d.route.provider,'fixture');assert.ok(d.stage);assert.ok(d.pluginBuild.id);assert.ok(d.elapsedMs>=0);assert.ok(!JSON.stringify(d).includes('请先讨论'));
});
test('a catalogue read outage still exposes a saved summary and marks its freshness unknown',async()=>{
  const h=harness(),first=await finish(h);h.ctx.sessionQuery.listSessions=async()=>{throw Error('fixture catalogue unavailable');};
  const value=await h.journal.daySummary(options);assert.equal(value.summary.text,first.summary.text);assert.equal(value.stale,true);assert.equal(value.canGenerate,false);assert.match(value.reason,/读取/);assert.equal(h.calls.length,1);
});
test('a read spanning model completion publishes the completed run and its new summary together',async()=>{
  const h=harness(),catalogue=deferred(),list=h.ctx.sessionQuery.listSessions;
  h.ctx.sessionQuery.listSessions=async()=>{await catalogue.promise;return list();};
  const polling=h.journal.daySummary(options);h.ctx.sessionQuery.listSessions=list;
  await h.journal.generateDaySummary(options);await h.journal.dailyActive.pending;
  catalogue.resolve();const value=await polling;
  assert.equal(value.run.status,'completed');assert.ok(value.summary?.text);assert.equal(value.stale,false);
});
test('polls during collection and generation share the job’s source reads; terminal reads check the latest evidence',async()=>{
  const h=harness(),read=h.ctx.sessionQuery.readSession,gate=deferred();let reads=0;
  h.ctx.sessionQuery.readSession=async id=>{reads++;await gate.promise;return read(id);};h.state.hold=true;
  await h.journal.generateDaySummary(options);await until(()=>reads===2);
  const early=h.journal.daySummary(options);gate.resolve();assert.equal((await early).run.status,'running');await until(()=>h.calls.length===1);
  for(let i=0;i<3;i++)assert.equal((await h.journal.daySummary(options)).run.status,'running');
  assert.equal(reads,2,'source sessions were each read once across generation and four running polls');
  h.logs.get('a').push(human(4,'2026-11-14T04:00:00Z','生成期间增加的表达'));const pending=h.journal.dailyActive.pending;h.gate.resolve();await pending;
  const terminal=await h.journal.daySummary(options);
  assert.equal(reads,4);assert.equal(terminal.run.status,'completed');assert.equal(terminal.summary.humanCount,2);assert.equal(terminal.coverage.humanCount,3);assert.equal(terminal.stale,true);assert.equal(h.calls.length,1);
});
test('a poll waiting on the active snapshot rechecks live data if the job ends before that poll resumes',async()=>{
  const h=harness(),read=h.ctx.sessionQuery.readSession,release=deferred(),captured=deferred();let reads=0;
  h.logs.clear();h.logs.set('a',[human(1,'2026-11-14T01:00:00Z','先讨论')]);
  h.ctx.sessionQuery.readSession=async id=>{
    const snapshot=await read(id);reads++;
    if(reads===1){captured.resolve();await release.promise;}
    return snapshot;
  };
  await h.journal.generateDaySummary(options);await captured.promise;
  const polling=h.journal.daySummary(options);
  h.logs.get('a').push(ai(2,'2026-11-14T01:01:00Z'),human(3,'2026-11-14T01:03:00Z','确认暂停'));
  release.resolve();const value=await polling;
  assert.equal(value.run.status,'failed','the original input had no route');assert.equal(value.coverage.humanCount,2);
  assert.equal(value.canGenerate,true,'the rescan sees the route added since the snapshot');assert.equal(reads,2);assert.equal(h.calls.length,0);
});
test('close waits for an already accepted daily summary write before storage is closed',async()=>{
  const h=harness();h.state.holdWrites=true;await h.journal.generateDaySummary(options);await until(()=>h.journal.dayRuns.values().next().value.stage==='保存当日总结');
  const closing=h.journal.close();await tick();assert.equal(h.state.closed,false);h.writeGate.resolve();await closing;assert.equal(h.state.closed,true);assert.equal(h.writes.length,1);assert.equal(h.journal.dailyActive,null);
});
test('invalid dates and missing model routes never generate fabricated summaries',async()=>{
  const h=harness();h.logs.clear();h.logs.set('a',[human(1,'2026-11-14T02:00:00Z','提出新任务')]);
  const read=await h.journal.daySummary(options);assert.equal(read.canGenerate,false);assert.match(read.reason,/模型/);const value=await finish(h);assert.equal(value.summary,null);assert.equal(value.run.status,'failed');assert.equal(h.calls.length,0);
  await assert.rejects(h.journal.generateDaySummary({...options,timeZone:'invalid/zone'}),e=>e.status===400);
});
test('daily output uses bounded format correction and keeps field-level diagnostics',async()=>{
  const h=harness();h.state.invalid=true;const x=await finish(h);assert.equal(x.run.status,'failed');assert.equal(h.calls.length,3);assert.equal(x.run.diagnostic.attempts,3);assert.ok(x.run.diagnostic.issues.some(i=>i.code==='ITEM_COUNT'));assert.equal(x.summary,null);
});
test('oversized input is explicitly blocked without dropping text or calling a model',async()=>{
  const h=harness();h.logs.get('a')[2].data.content[0].text='全文'.repeat(30000);const x=await finish(h);assert.equal(x.canGenerate,false);assert.match(x.reason,/预算|上限/);assert.ok(x.inputChars>x.inputLimit);assert.equal(x.run.status,'failed');assert.equal(h.calls.length,0);
});
test('a correction that exceeds the input budget is never sent or counted as a model call',async()=>{
  const h=harness(),base=await h.journal.daySummary(options);
  h.logs.get('a')[2].data.content[0].text+='文'.repeat(base.inputLimit-base.inputChars);
  h.state.invalid=true;const result=await finish(h);
  assert.equal(JSON.stringify(h.calls[0].input).length,result.inputLimit);
  assert.equal(result.run.status,'failed');assert.equal(h.calls.length,1);assert.equal(result.run.modelCalls,1);
  assert.equal(result.run.diagnostic.code,'DAY_SUMMARY_INPUT_LIMIT');assert.ok(result.run.diagnostic.inputChars>result.inputLimit);assert.match(result.run.error,/预算|上限/);
});
test('unreadable sessions block an incomplete day summary while an empty day remains readable',async()=>{
  const h=harness();h.logs.set('broken',null);const x=await finish(h);assert.equal(x.canGenerate,false);assert.match(x.reason,/读取失败/);assert.equal(h.calls.length,0);
  h.logs.delete('broken');const empty=await h.journal.daySummary({...options,date:'2026-11-12'});assert.equal(empty.canGenerate,false);assert.equal(empty.coverage.humanCount,0);assert.equal(empty.summary,null);
});
test('daily jobs claim their lock before reading and are mutually exclusive with existing analyses',async()=>{
  const h=harness();h.state.hold=true;await h.journal.generateDaySummary(options);const duplicate=await h.journal.generateDaySummary(options);assert.equal(duplicate.status,'running');await until(()=>h.calls.length===1);
  await assert.rejects(h.journal.generateDaySummary({...options,date:'2026-11-13'}),e=>e.status===409);await assert.rejects(h.journal.start('a'),e=>e.status===409);await assert.rejects(h.journal.startInteractions('a'),e=>e.status===409);
  h.gate.resolve();await h.journal.dailyActive.pending;assert.equal(h.calls.length,1);h.journal.active={id:'a'};await assert.rejects(h.journal.generateDaySummary(options),e=>e.status===409);
});
test('close cancels model work and waits before closing storage',async()=>{
  const h=harness();h.state.hold=true;await h.journal.generateDaySummary(options);await until(()=>h.calls.length===1);const closing=h.journal.close();await tick();assert.equal(h.state.closed,false);assert.equal(h.calls[0].signal.aborted,true);
  h.gate.resolve();await closing;assert.equal(h.state.closed,true);assert.equal(h.journal.dailyActive,null);assert.equal(h.writes.length,0);
});
test('close drains all in-flight source readers before the daily task releases its slot',async()=>{
  const h=harness(),a=deferred(),b=deferred(),read=h.ctx.sessionQuery.readSession,started=[];
  h.ctx.sessionQuery.readSession=async id=>{started.push(id);await (id==='a'?a:b).promise;return read(id);};
  await h.journal.generateDaySummary(options);await until(()=>started.length===2);const closing=h.journal.close();b.resolve();
  try{await tick();await tick();assert.equal(h.state.closed,false);assert.ok(h.journal.dailyActive);}finally{a.resolve();await closing;}
  assert.equal(h.state.closed,true);assert.equal(h.calls.length,0);
});
test('global day summary HTTP actions require no session ID and validate dates',async()=>{
  const h=harness();let endpoint;await apply({...h.ctx,storageDomain:{open:async()=>h.domain},effect:f=>f(),connection:{fetch:{register:r=>{endpoint=r;return()=>{};}}}});
  const request=body=>endpoint.fetch(new Request('http://localhost/api',{method:'POST',body:JSON.stringify(body)}));
  const read=await request({action:'daySummary',...options});assert.equal(read.status,200);assert.equal((await read.json()).value.coverage.humanCount,2);assert.equal(h.calls.length,0);
  const generated=await request({action:'generateDaySummary',...options});assert.equal(generated.status,200);assert.equal((await generated.json()).value.status,'running');
  const invalid=await request({action:'daySummary',date:'nonsense'});assert.equal(invalid.status,400);
});
