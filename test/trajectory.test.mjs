import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceEntries,trajectoryNodes,analyzeTrajectory,validateOutput,fingerprint,routeFrom } from '../src/trajectory.mjs';
import { Journal } from '../src/service.mjs';
import { journalSpec } from '../src/domain.mjs';
const user=(text,source='user')=>({type:'user/message',data:{content:[{type:'text',text}],source:{kind:source}}});
const ai=text=>({type:'assistant/message',data:{message:{content:[{type:'text',text}],source:{kind:'model',provider:'fixture',model:'test'}}}});
const events=(...es)=>es.map((e,seq)=>({...e,seq,time:1000+seq}));
const generate=async({items})=>JSON.stringify({items:items.map(i=>({id:i.id,summary:(i.text||i.fragments.map(f=>f.summary).join('')).slice(-170),details:[]}))});
test('native domain declaration loads',()=>assert.equal(journalSpec.name,'dsh_collab_journal'));
test('human boundaries stay separate; injected context is not counted as human',()=>{
  const entries=sourceEntries(events(user('目标'),ai('调查'),user('skill','skill'),ai('结果'),user('纠正'),user('补充')));
  const nodes=trajectoryNodes(entries);
  assert.deepEqual(nodes.map(n=>n.role),['user','assistant','user','user']);assert.deepEqual(nodes[1].seqs,[1,2,3]);
});
test('tool result failure and interrupted replies remain visible',()=>{
  const entries=sourceEntries(events(user('执行'),{...ai('未完成'),data:{...ai('未完成').data,interrupted:true}},{type:'tool/result',data:{message:{content:[{type:'text',text:'权限不足'}],isError:true},error:{reason:'access denied'}}},{type:'turn/end',data:{reason:{kind:'aborted'}}}));
  assert.match(entries[1].text,/中断/);assert.match(entries[2].text,/工具失败/);assert.match(entries[3].text,/aborted/);
});
test('long tools include their tail and are folded into one AI node',async()=>{
  const entries=sourceEntries(events(user('看全部'),ai('开始'),{type:'tool/result',data:{message:{content:[{type:'text',text:'x'.repeat(15000)+'最终失败'}]}}}));
  let inputs='';const nodes=await analyzeTrajectory(async input=>{inputs+=JSON.stringify(input);return generate(input);},entries);
  assert.match(inputs,/最终失败/);assert.equal(nodes.length,2);assert.match(nodes[1].summary,/最终失败/);
});
test('unknown, duplicate, omitted IDs and invalid JSON are rejected',()=>{
  const items=[{id:'a'},{id:'b'}];for(const output of ['nope','{"items":[]}',JSON.stringify({items:[{id:'a',summary:'x',details:[]},{id:'a',summary:'y',details:[]}]})])assert.throws(()=>validateOutput(output,items));
});
test('route comes from last DSH request and source changes invalidate evidence',()=>{
  const es=events(ai('result'),{type:'request/header',data:{header:{config:{provider:'new',model:'configured'}}}});
  assert.deepEqual(routeFrom(es),{provider:'new',model:'configured'});assert.notEqual(fingerprint(sourceEntries(es)),fingerprint(sourceEntries(events(ai('changed')))));
});
function harness(){
  const logs=new Map([['a',{session:{id:'a',createdAt:1,cwd:'/one'},events:events(user('目标'),ai('完成'))}],['b',{session:{id:'b',createdAt:2,cwd:'/two'},events:events(user('另一个'))}],['child',{session:{id:'child',origin:'subagent',createdAt:3},events:[]}]]);
  const tables={reports:new Map(),versions:new Map(),checkpoints:new Map()};const domain={table:n=>({get:k=>tables[n].get(k),put:async(k,v)=>tables[n].set(k,structuredClone(v)),delete:async k=>tables[n].delete(k)}),close:async()=>{}};
  let fail=false,calls=0,response=generate;
  const ctx={sessionQuery:{listSessions:async()=>[...logs.values()].map(l=>({header:l.session})),readSession:async id=>{if(!logs.has(id))throw Error('notfound');return structuredClone(logs.get(id));}},workspaceRegistry:{list:()=>[{id:'w1',title:'same',path:'/one',sessionIds:['a','child']},{id:'w2',title:'same',path:'/two',sessionIds:['b']}],archivedSessionIds:['b']},llm:{prepareCall:async config=>({config,async *stream(options){calls++;assert.equal(options.purpose,'collab-journal');assert.equal(options.tools,undefined);if(fail)throw Error('fixture failure');yield {type:'text-delta',index:0,text:await response(JSON.parse(options.messages[0].content[0].text))};yield {type:'finish',reason:{kind:'stop'}};}})}};
  return {journal:new Journal(ctx,domain),logs,tables,setFail:()=>{fail=true;},setResponse:f=>{response=f;},calls:()=>calls};
}
test('catalogue respects native workspace IDs, archive and subagent classification',async()=>{
  const h=harness(),result=await h.journal.catalog();assert.equal(result.workspaces.length,2);assert.deepEqual(result.workspaces[0].sessions.map(s=>s.id),['a']);assert.equal(result.workspaces[1].sessions[0].archived,true);assert.equal(h.calls(),0);
});
test('manual parsing, deduplication, failed rerun and immutable original evidence',async()=>{
  const h=harness();await h.journal.start('a');const pending=h.journal.active.pending;await h.journal.start('a');await assert.rejects(h.journal.start('b'),/另一个/);await pending;
  const original=await h.journal.detail('a');assert.equal(original.report.nodes.length,2);assert.equal(original.run.status,'completed');
  h.logs.get('a').events.push(...events(user('new')).map(e=>({...e,seq:2,time:3000})));assert.equal((await h.journal.detail('a')).report.stale,true);
  h.setFail();await h.journal.start('a');await h.journal.active.pending;const failed=await h.journal.detail('a');assert.equal(failed.run.status,'failed');assert.equal(failed.report.snapshotId,original.report.snapshotId);
  const context=await h.journal.context('a',original.report.snapshotId,'n1');assert.equal(context.entries[0].text,'目标');assert.ok(!context.entries.some(e=>e.text==='new'));
});
test('no model route is an explicit failure, not a fake summary',async()=>{
  const h=harness();await h.journal.start('b');await h.journal.active.pending;assert.equal((await h.journal.detail('b')).run.status,'failed');assert.equal(h.tables.reports.size,0);
});
test('exhausted format repairs keep the stage, diagnostics and previous report',async t=>{
  const logs=[];t.mock.method(console,'warn',(...args)=>logs.push(args.join(' ')));
  const h=harness();await h.journal.start('a');await h.journal.active.pending;
  const original=h.tables.reports.get('a');
  h.setResponse(async({items})=>JSON.stringify({items:items.map(i=>({id:i.id,summary:'私'.repeat(181),details:[]}))}));
  await h.journal.start('a');await h.journal.active.pending;
  const {run,report}=await h.journal.detail('a');
  assert.equal(run.status,'failed');assert.match(run.stage,/整理片段.*格式纠正 2\/2/);
  assert.equal(run.diagnostic.attempts,3);assert.equal(run.diagnostic.modelCalls,3);
  assert.deepEqual(run.diagnostic.route,{provider:'fixture',model:'test'});
  assert.equal(run.diagnostic.issues[0].code,'SUMMARY_LENGTH');
  assert.match(run.error,/items\[0\].summary.*181/);
  assert.equal(report.snapshotId,original.snapshotId);assert.deepEqual(h.tables.reports.get('a'),original);
  assert.equal(logs.length,1);assert.doesNotMatch(logs[0],/私/);assert.match(logs[0],/OutputValidationError/);
});
