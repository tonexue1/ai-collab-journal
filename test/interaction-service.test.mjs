import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/service.mjs';
import { apply } from '../src/index.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const human=(seq,time=`2026-11-04T0${seq}:00:00Z`)=>({seq,time:Date.parse(time),type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:`请处理任务 ${seq}`} ]}});
const ai=(seq)=>({seq,time:Date.parse('2026-11-04T06:00:00Z'),type:'assistant/message',data:{message:{source:{provider:'fixture',model:'one'},content:[{type:'text',text:'仅在计划，尚未完成。'}]}}});
function harness(){
 const events=[human(1,'2026-11-03T10:00:00Z'),ai(2),human(3),ai(4),human(5),ai(6)],tables=Object.fromEntries(['reports','versions','checkpoints','interaction_sources','interaction_versions','interaction_latest'].map(n=>[n,new Map()]));
 const writes=[],calls=[],state={failSeq:null,invalidSeq:null,hold:false,closed:false,holdWrites:false,failSourceWrite:false};const writeGate=deferred(),writeStarted=deferred();
 const domain={table:n=>({get:k=>structuredClone(tables[n].get(k)),put:async(k,v)=>{if(state.holdWrites){writeStarted.resolve();await writeGate.promise;}assert.equal(state.closed,false,'writes must finish before close');if(n==='interaction_sources'&&state.failSourceWrite)throw Error('fixture storage unavailable');writes.push([n,k]);tables[n].set(k,structuredClone(v));},delete:async k=>tables[n].delete(k)}),close:async()=>{state.closed=true;}};
 const ctx={sessionQuery:{readSession:async id=>({session:{id},events:structuredClone(events)})},llm:{prepareCall:async config=>({config,async *stream(options){
  const input=JSON.parse(options.messages[0].content[0].text),gate=deferred();calls.push({seq:input.anchor.seq,...gate,signal:options.signal});if(state.hold)await gate.promise;if(input.anchor.seq===state.failSeq)throw Error('fixture provider unavailable');
  const evidence=[{seq:input.anchor.seq,quote:input.anchor.text}],result={title:`处理任务 ${input.anchor.seq}`,categories:[{label:'新任务',evidence}],before:{text:'前文证据不足，无法确定介入前状态。',evidence:[]},contribution:{text:'提出下一项任务。',evidence},certainty:'unclear'};
  if(input.anchor.seq===state.invalidSeq)result.categories[0].evidence[0].quote='这段话不在原文中';
  yield {type:'text-delta',index:0,text:JSON.stringify(result)};yield {type:'finish',reason:{kind:'stop'}};
 }})}};
 return{journal:new Journal(ctx,domain),ctx,domain,tables,events,writes,calls,state,writeGate,writeStarted};
}
async function run(h,options={}){assert.equal(typeof h.journal.startInteractions,'function');await h.journal.startInteractions('a',options);const pending=h.journal.active?.pending;if(pending)await pending;return h.journal.runs.get('a');}
async function until(condition){for(let i=0;i<100&&!condition();i++)await tick();assert.ok(condition(),'expected asynchronous stage must become observable');}

test('day analysis independently persists results with one shared source, then skips fresh anchors',async()=>{
 const h=harness(),r=await run(h,{date:'2026-11-04',timeZone:'UTC'});assert.equal(r.mode,'interactions');assert.equal(r.status,'completed');assert.equal(r.total,2);assert.equal(r.completed,2);assert.equal(r.modelCalls,2);assert.deepEqual(r.errors,[]);
 assert.equal(h.tables.interaction_sources.size,1);assert.equal(h.writes.filter(([n])=>n==='interaction_sources').length,1);assert.equal(h.tables.interaction_versions.size,2);assert.equal(h.tables.interaction_latest.size,2);
 const listing=await h.journal.interactions('a',{date:'2026-11-04',timeZone:'UTC'});assert.deepEqual(listing.items.map(i=>[i.id,i.analysis.stale]),[['h3',false],['h5',false]]);assert.equal(listing.analysisRun.status,'completed');
 for(const v of h.tables.interaction_versions.values()){assert.equal(Object.hasOwn(v,'entries'),false,'versions reference shared source, not copied prefixes');assert.ok(v.sourceSnapshotId);}
 const calls=h.calls.length;const again=await run(h,{date:'2026-11-04',timeZone:'UTC'});assert.equal(again.total,0);assert.equal(h.calls.length,calls);assert.equal(h.tables.interaction_versions.size,2);
});
test('forced rerun creates immutable result versions without rewriting shared source',async()=>{
 const h=harness();await run(h,{interactionId:'h3'});const first=(await h.journal.interactions('a')).items.find(i=>i.id==='h3').analysis;
 await run(h,{interactionId:'h3',force:true});const second=(await h.journal.interactions('a')).items.find(i=>i.id==='h3').analysis;
 assert.notEqual(second.resultId,first.resultId);assert.equal(h.tables.interaction_versions.size,2);assert.equal(h.writes.filter(([n])=>n==='interaction_sources').length,1);
 const old=await h.journal.interactionEvidence('a',first.resultId);assert.equal(old.resultId,first.resultId);assert.ok(old.entries.some(e=>e.seq===3));assert.ok(old.entries.every(e=>e.seq<=3));assert.equal(h.tables.reports.size,0);
});
test('later append keeps existing classifications fresh; changed dependency marks stale without deleting evidence',async()=>{
 const h=harness();await run(h,{interactionId:'h3'});const original=(await h.journal.interactions('a')).items.find(i=>i.id==='h3'),frozen=await h.journal.interactionEvidence('a',original.analysis.resultId);
 h.events.push(human(7));let items=(await h.journal.interactions('a')).items;assert.equal(items.find(i=>i.id==='h3').basisHash,original.basisHash);assert.equal(items.find(i=>i.id==='h3').analysis.stale,false);assert.equal(items.find(i=>i.id==='h7').analysis,null);
 h.events[0].data.content[0].text='历史请求被更正';items=(await h.journal.interactions('a')).items;assert.equal(items.find(i=>i.id==='h3').analysis.stale,true);assert.notEqual(items.find(i=>i.id==='h3').basisHash,original.basisHash);assert.deepEqual(await h.journal.interactionEvidence('a',original.analysis.resultId),frozen);
});
test('one failed anchor preserves its old result while the rest of the requested batch still completes',async()=>{
 const h=harness();await run(h,{interactionId:'h3'});const old=(await h.journal.interactions('a')).items.find(i=>i.id==='h3').analysis;h.state.failSeq=3;
 const r=await run(h,{force:true});assert.equal(r.status,'failed');assert.equal(r.total,3);assert.equal(r.completed,2);assert.deepEqual(r.errors.map(e=>e.interactionId),['h3']);assert.equal(h.tables.interaction_latest.size,3);
 const items=(await h.journal.interactions('a')).items;assert.equal(items.find(i=>i.id==='h3').analysis.resultId,old.resultId);assert.ok(items.find(i=>i.id==='h1').analysis);assert.ok(items.find(i=>i.id==='h5').analysis);
});
test('interaction jobs use at most two providers and exclude concurrent full-trajectory work',async()=>{
 const h=harness();h.state.hold=true;assert.equal(typeof h.journal.startInteractions,'function');await h.journal.startInteractions('a');await until(()=>h.calls.length===2);
 await assert.rejects(h.journal.start('a'),e=>e.status===409);await assert.rejects(h.journal.startInteractions('other'),e=>e.status===409);assert.equal(h.calls.length,2);
 await assert.rejects(h.journal.startInteractions('a',{interactionId:'h3'}),e=>e.status===409);await assert.rejects(h.journal.startInteractions('a',{date:'2026-11-04',timeZone:'UTC'}),e=>e.status===409);
 assert.equal((await h.journal.startInteractions('a')).startedAt,h.journal.runs.get('a').startedAt,'only same-mode same-scope duplicate reuses a job');
 h.calls[0].resolve();await until(()=>h.calls.length===3);assert.equal(h.calls.filter(c=>!c.signal.aborted).length,3);h.state.hold=false;for(const c of h.calls)c.resolve();await h.journal.active.pending;
 assert.equal(h.journal.runs.get('a').status,'completed');assert.equal(h.tables.interaction_latest.size,3);
});
test('close cancels pending dispatch and waits for providers before closing storage',async()=>{
 const h=harness();h.state.hold=true;assert.equal(typeof h.journal.startInteractions,'function');await h.journal.startInteractions('a');await until(()=>h.calls.length===2);const close=h.journal.close();await tick();assert.equal(h.state.closed,false);assert.ok(h.calls.every(c=>c.signal.aborted));
 for(const c of h.calls)c.resolve();await close;assert.equal(h.state.closed,true);assert.equal(h.journal.active,null);assert.equal(h.calls.length,2);assert.equal(h.journal.runs.get('a').status,'cancelled');assert.equal(h.tables.interaction_latest.size,0);
});
test('close waits for already accepted source/version writes',async()=>{
 const h=harness();h.state.holdWrites=true;assert.equal(typeof h.journal.startInteractions,'function');await h.journal.startInteractions('a',{interactionId:'h3'});await h.writeStarted.promise;const closing=h.journal.close();await tick();assert.equal(h.state.closed,false);h.writeGate.resolve();await closing;assert.equal(h.state.closed,true);assert.equal(h.journal.active,null);
});
test('HTTP analysis exposes frozen evidence only for its own session and validates unknown anchors',async()=>{
 const h=harness();assert.equal(typeof h.journal.startInteractions,'function');await assert.rejects(h.journal.startInteractions('a',{interactionId:'h999'}),e=>e.status===404);
 await run(h,{interactionId:'h3'});const resultId=(await h.journal.interactions('a')).items.find(i=>i.id==='h3').analysis.resultId;
 await assert.rejects(h.journal.interactionEvidence('other',resultId),e=>e.status===404);await assert.rejects(h.journal.interactionEvidence('a',resultId,6),e=>e.status===404);
 const domain={...h.domain,table:name=>name==='schedule'?{get:()=>null}:h.domain.table(name)};
 let endpoint;await apply({...h.ctx,storageDomain:{open:async()=>domain},effect:f=>f(),connection:{fetch:{register:r=>{endpoint=r;return()=>{};}}}});
 const res=await endpoint.fetch(new Request('http://localhost/api',{method:'POST',body:JSON.stringify({action:'interactionEvidence',id:'a',resultId})}));assert.equal(res.status,200);const x=await res.json();assert.ok(x.value.entries.some(e=>e.seq===3));assert.ok(x.value.entries.every(e=>e.seq<=3));
});
test('frozen evidence exposes only actually read entry metadata as well as text',async()=>{
 const h=harness();await run(h,{interactionId:'h5'});const resultId=(await h.journal.interactions('a')).items.find(i=>i.id==='h5').analysis.resultId;
 const context=await h.journal.interactionEvidence('a',resultId),returned=new Set(context.entries.map(e=>e.seq));
 assert.ok(!returned.has(1),'older unread request must not be part of default evidence');
 assert.ok(Object.keys(context.provenance).every(seq=>returned.has(Number(seq))),'do not return a full-session provenance index for a small evidence view');
});
test('each failed result retains field-level diagnosis, exact call accounting, route and build',async()=>{
 const h=harness();h.state.invalidSeq=3;const r=await run(h);assert.equal(r.errors.length,1);const d=r.errors[0].diagnostic;
 assert.ok(d,'an item-level failure needs a durable-in-run diagnostic');assert.equal(d.modelCalls,3);assert.equal(d.attempts,3);assert.ok(d.issues.some(i=>i.code==='QUOTE_NOT_READ'));assert.deepEqual(d.route,{provider:'fixture',model:'one'});assert.ok(d.pluginBuild.id);assert.ok(d.elapsedMs>=0);assert.equal(r.diagnostic.modelCalls,5);assert.equal(r.diagnostic.status,'failed');
});
test('a shared-source storage failure stops before models and exposes a terminal diagnostic',async()=>{
 const h=harness();h.state.failSourceWrite=true;const r=await run(h);assert.equal(r.status,'failed');assert.match(r.error,/storage unavailable/);assert.equal(r.modelCalls,0);assert.equal(h.tables.interaction_latest.size,0);assert.equal(r.diagnostic.status,'failed');assert.equal(r.diagnostic.stage,'保存共享原文快照');assert.deepEqual(r.diagnostic.route,{provider:'fixture',model:'one'});
});

test('scheduled intervention work keeps protected prefixes local, continues earlier safe anchors, and never fabricates redacted evidence', async () => {
  const h = harness(), token = 'synthetic-startup-token-for-scheduler';
  h.events[4].data.content[0].text = `检查 http://127.0.0.1:19001/?token=${token} 后继续暂停`;
  const options = { date: '2026-11-04', timeZone: 'UTC' };
  await h.journal.startInteractions('a', options, { scheduled: true });
  await h.journal.active?.pending;
  const task = h.journal.runs.get('a');
  assert.deepEqual(h.calls.map(call => call.seq), [3]);
  assert.equal(task.status, 'failed'); assert.equal(task.completed, 1);
  assert.equal(task.errors[0].interactionId, 'h5'); assert.equal(task.errors[0].code, 'SCHEDULE_PROTECTED_INPUT');
  assert.equal(task.errors[0].diagnostic.modelCalls, 0); assert.ok(!JSON.stringify(task).includes(token));
  const [safe, guarded] = (await h.journal.interactions('a', options)).items;
  assert.ok(safe.analysis); assert.equal(guarded.analysis, null); assert.ok(guarded.human.text.includes(token));
  await run(h, { interactionId: 'h5' }); // Manual analysis uses its existing explicitly chosen protocol.
  assert.equal(h.calls.length, 2); assert.ok((await h.journal.interactions('a', options)).items[1].analysis);
});

test('a credential copied before its identifying launch URL prevents a scheduled request containing the bare value', async () => {
  const h = harness(), token = 'another-synthetic-startup-credential';
  h.events[1].data.message.content[0].text = `原样复制 ${token}`;
  h.events[5].data.message.content[0].text = `http://[::1]:19001/?token=${token}。`;
  await h.journal.startInteractions('a', { date: '2026-11-04', timeZone: 'UTC' }, { scheduled: true });
  await h.journal.active?.pending;
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.journal.runs.get('a').errors.map(error => error.code), ['SCHEDULE_PROTECTED_INPUT','SCHEDULE_PROTECTED_INPUT']);
});
