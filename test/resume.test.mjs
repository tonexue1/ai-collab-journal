import test from 'node:test';
import assert from 'node:assert/strict';
import * as trajectory from '../src/trajectory.mjs';

const entry=(seq,role,text)=>({seq,time:1000+seq,type:role==='user'?'user/message':'tool/result',role,text,source:{seq}});
const evidence=[entry(1,'user','请检查所有记录'),entry(2,'assistant','A'.repeat(9600)+'最终失败，部署未执行')];
const answer=({items})=>JSON.stringify({items:items.map(i=>({id:i.id,summary:i.text?JSON.parse(i.text).map(s=>s.text).join('').slice(-80):i.fragments.map(f=>f.summary).join(' ').slice(-170),details:[]}))});
// Exercise the serial baseline here; concurrency and durable write races have
// dedicated tests using the production default of three workers.
const analyze=(generate,entries,options,signal)=>trajectory.analyzeTrajectory(generate,entries,()=>{},signal,{concurrency:1,...options});

test('planned calls include fragment batches and every merge without invoking a model',()=>{
  assert.equal(typeof trajectory.trajectoryPlan,'function');
  // The 2400-character limit now includes source provenance and JSON escaping.
  assert.deepEqual(trajectory.trajectoryPlan([entry(1,'user','x'.repeat(862*2400))]),{fragmentCount:890,nodeCount:1,totalCalls:521});
  assert.deepEqual(trajectory.trajectoryPlan(evidence),{fragmentCount:6,nodeCount:2,totalCalls:4});
  assert.deepEqual(trajectory.trajectoryPlan([]),{fragmentCount:0,nodeCount:0,totalCalls:0});
});

test('restart reuses saved fragment and merge batches and preserves final failure evidence',async()=>{
  let persisted={},calls=0;const progress=[];
  await assert.rejects(analyze(async input=>{if(++calls===4)throw Error('offline');return answer(input);},evidence,{cache:{},save:async cache=>{persisted=structuredClone(cache);}}),/offline/);
  assert.equal(Object.keys(persisted).length,3,'each completed batch, including the first merge, is saved');
  let resumedCalls=0;
  const nodes=await analyze(async input=>{resumedCalls++;return answer(input);},evidence,{cache:structuredClone(persisted),save:async cache=>{persisted=structuredClone(cache);},onProgress:p=>progress.push(p)});
  assert.equal(resumedCalls,1);assert.deepEqual(nodes.map(n=>n.role),['user','assistant']);assert.deepEqual(nodes[1].seqs,[2]);
  assert.match(nodes[1].summary,/最终失败，部署未执行/);
  assert.deepEqual(progress.at(-1),{completedCalls:4,totalCalls:4,reusedCalls:3,fragmentCount:6,nodeCount:2});
});

test('stopping after a durable batch resumes from that batch rather than losing all work',async()=>{
  const controller=new AbortController();let persisted={};
  await assert.rejects(analyze(async input=>answer(input),evidence,{cache:{},save:async cache=>{persisted=structuredClone(cache);controller.abort(Error('stop'));}},controller.signal),/stop/);
  assert.equal(Object.keys(persisted).length,1);
  let calls=0;
  const nodes=await analyze(async input=>{calls++;return answer(input);},evidence,{cache:structuredClone(persisted),save:async()=>{}});
  assert.equal(calls,3);assert.match(nodes[1].summary,/最终失败/);
});

test('changed source cannot reuse an earlier batch with the same IDs',async()=>{
  let saved={};
  const first=[entry(1,'user','部署失败')];
  await analyze(async input=>answer(input),first,{cache:{},save:async cache=>{saved=structuredClone(cache);}});
  let calls=0;
  const nodes=await analyze(async input=>{calls++;return answer(input);},[entry(1,'user','部署状态未知')],{cache:saved,save:async()=>{}});
  assert.equal(calls,1);assert.equal(nodes[0].summary,'部署状态未知');
});

test('invalid saved output is regenerated without bypassing normal validation',async()=>{
  let saved={};const entries=[entry(1,'user','保持失败')];
  await analyze(async input=>answer(input),entries,{cache:{},save:async cache=>{saved=structuredClone(cache);}});
  const key=Object.keys(saved)[0];assert.ok(key);
  saved[key][0].id='wrong-id';saved[key][0].summary='伪造成功';
  let calls=0;
  const nodes=await analyze(async input=>{calls++;return answer(input);},entries,{cache:saved,save:async()=>{}});
  assert.equal(calls,1);assert.equal(nodes[0].summary,'保持失败');
});

test('failed model outputs never become saved checkpoints and retain bounded correction attempts',async()=>{
  let saves=0,calls=0;const cache={};
  await assert.rejects(analyze(async()=>{calls++;return '{bad';},[entry(1,'user','private')],{cache,save:async()=>{saves++;}}),error=>error.code==='MODEL_OUTPUT_INVALID'&&error.attempts===3);
  assert.equal(calls,3);assert.equal(saves,0);assert.deepEqual(cache,{});
});

test('checkpoint storage failures stop before another model batch and do not count as format repairs',async()=>{
  let calls=0;
  await assert.rejects(analyze(async input=>{calls++;return answer(input);},evidence,{cache:{},save:async()=>{throw Error('disk unavailable');}}),/disk unavailable/);
  assert.equal(calls,1);
});

test('a completed checkpoint can be replayed with no model calls and a stable analysis version',async()=>{
  let saved={};
  const original=await analyze(async input=>answer(input),evidence,{cache:{},save:async cache=>{saved=structuredClone(cache);}});
  assert.ok(typeof trajectory.ANALYSIS_VERSION==='string'&&trajectory.ANALYSIS_VERSION.length>0);
  const replay=await analyze(async()=>{throw Error('must not call model');},evidence,{cache:structuredClone(saved),save:async()=>{throw Error('unchanged replay must not write');}});
  assert.deepEqual(replay,original);
});

test('different merge positions remain separate checkpoint tasks even when their summaries match',async()=>{
  let saved={},calls=0;const entries=[entry(1,'user','x'.repeat(24000))];
  await analyze(async({items})=>{calls++;return JSON.stringify({items:items.map(i=>({id:i.id,summary:'同样摘要',details:[]}))});},entries,{cache:{},save:async cache=>{saved=structuredClone(cache);}});
  // Eleven provenance-bearing fragments: three batches, three merges, one final merge.
  assert.equal(calls,7);assert.equal(Object.keys(saved).length,7);
});
