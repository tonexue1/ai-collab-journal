import assert from 'node:assert/strict';
import { createRuntime } from './dsh-runtime.mjs';
const runtime=await createRuntime();
try{
  await runtime.start();
  const catalogue=await runtime.api('catalog');const groups=catalogue.workspaces.filter(w=>w.sessions.length);
  assert.equal(groups.length,2);assert.equal(groups[0].title,groups[1].title);assert.notEqual(groups[0].id,groups[1].id);
  assert.deepEqual(groups.flatMap(w=>w.sessions.map(s=>s.id)).sort(),['journal-test-a','journal-test-b']);
  assert.equal((await runtime.api('status',{},'journal-test')).calls,0);
  await runtime.api('parse',{id:'journal-test-a'});let detail=await runtime.settled('journal-test-a');
  assert.equal(detail.run.status,'completed',JSON.stringify(detail.run));assert.equal(detail.report.nodes.filter(n=>n.role==='user').length,2);assert.equal(detail.report.nodes.length,4);
  assert.equal((await runtime.api('status',{},'journal-test')).seenTail,true);
  const snapshotId=detail.report.snapshotId;
  const context=await runtime.api('context',{id:'journal-test-a',snapshotId,nodeId:'n2'});assert.ok(context.entries.some(e=>e.text.includes('TAIL_EVIDENCE')));assert.ok(context.entries.some(e=>e.role==='context'));
  await runtime.api('append',{},'journal-test');assert.equal((await runtime.api('detail',{id:'journal-test-a'})).report.stale,true);
  await runtime.api('fail',{value:true},'journal-test');await runtime.api('parse',{id:'journal-test-a'});detail=await runtime.settled('journal-test-a');
  assert.equal(detail.run.status,'failed');assert.equal(detail.report.snapshotId,snapshotId);
  const unauth=await fetch(`${runtime.base}/api/dsh-collab-journal`,{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"catalog"}'});assert.ok([401,403].includes(unauth.status));
  await runtime.stop();await runtime.start();
  assert.equal((await runtime.api('status',{},'journal-test')).live,false,'reads must support cold persisted sessions');
  detail=await runtime.api('detail',{id:'journal-test-a'});assert.equal(detail.report.snapshotId,snapshotId);assert.equal(detail.report.stale,true);
  await runtime.api('parse',{id:'journal-test-a'});detail=await runtime.settled('journal-test-a');assert.equal(detail.run.status,'completed');assert.equal(detail.report.nodes.filter(n=>n.role==='user').length,3);
  assert.equal((await runtime.api('context',{id:'journal-test-a',snapshotId,nodeId:'n1'})).snapshotId,snapshotId);
  console.log('DSH 0.2.2-rc.1: package install, native workspace/session/LLM/storage, cold restart, stale evidence, failed rerun, immutable context and authentication passed.');
}catch(error){console.error(runtime.log);throw error;}finally{await runtime.stop();}
