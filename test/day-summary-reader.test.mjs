import test from 'node:test';
import assert from 'node:assert/strict';
import * as reader from '../src/day-summary-reader.mjs';

const scope={date:'2026-11-14',timeZone:'Asia/Shanghai',includeArchived:false};
const running={summary:{text:'已有总结'},run:{status:'running'}};
const completed={summary:{text:'更新后的总结'},run:{status:'completed'}};

test('saved interactions cause one summary refresh per observed job, including partial and immediate completions',()=>{
  const shouldRefresh=reader.createInteractionChangeObserver();
  const job={id:'session-a',mode:'interactions',startedAt:100,completed:0,status:'running'};
  assert.equal(shouldRefresh({...job,startedAt:90,completed:1,status:'completed'}),false,'browsing past results');
  assert.equal(shouldRefresh(job),false);
  assert.equal(shouldRefresh({...job,completed:1}),false,'keep polling until all workers settle');
  const partial={...job,completed:1,status:'failed'};
  assert.equal(shouldRefresh(partial),true);
  assert.equal(shouldRefresh(partial),false,'detail and interaction callbacks may deliver the same result');
  assert.equal(shouldRefresh(job),false);
  assert.equal(shouldRefresh(partial),false,'a late running response cannot rearm a completed job');
  assert.equal(shouldRefresh({...job,startedAt:101,completed:1,status:'completed'},true),true,'an action may return the terminal result before the first poll');
  assert.equal(shouldRefresh(partial,true),false,'out-of-order older action response');
  assert.equal(shouldRefresh({...job,startedAt:102,completed:0,status:'failed'},true),false,'nothing was saved');
  assert.equal(shouldRefresh({...job,id:'session-b',completed:1,status:'cancelled'},true),true,'a cancelled job may have saved results');
  assert.equal(shouldRefresh({...job,mode:'trajectory',completed:1,status:'completed'},true),false);
});

test('day summary polling only reads its own scope and publishes the final saved result before stopping',async()=>{
  assert.equal(typeof reader.observeDaySummary,'function');
  const values=[running,completed],published=[],calls=[];let waits=0;
  await reader.observeDaySummary({scope,signal:new AbortController().signal,request:async(action,params)=>{calls.push([action,params]);return values.shift();},publish:value=>published.push(value),onError:assert.fail,wait:async()=>{waits++;}});
  assert.deepEqual(published,[running,completed]);
  assert.deepEqual(calls,[['daySummary',scope],['daySummary',scope]]);
  assert.equal(waits,1);
});

test('a temporary polling failure leaves the last good summary in place and retries a running job',async()=>{
  assert.equal(typeof reader.observeDaySummary,'function');
  const published=[],errors=[];let call=0;
  await reader.observeDaySummary({scope,signal:new AbortController().signal,request:async()=>{call++;if(call===2)throw Error('temporary read failure');return call===1?running:completed;},publish:value=>published.push(value),onError:error=>errors.push(error.message),wait:async()=>{}});
  assert.deepEqual(published,[running,completed]);assert.deepEqual(errors,['temporary read failure']);assert.equal(call,3);
});

test('an obsolete date response cannot publish after its request was aborted',async()=>{
  assert.equal(typeof reader.observeDaySummary,'function');
  const controller=new AbortController(),published=[];let resolve;
  const response=new Promise(done=>{resolve=done;});
  const pending=reader.observeDaySummary({scope,signal:controller.signal,request:()=>response,publish:value=>published.push(value),onError:assert.fail,wait:async()=>assert.fail('cancelled scope cannot poll again')});
  controller.abort();resolve(completed);await pending;
  assert.deepEqual(published,[]);
});

test('an initial read failure is visible without launching generation or an unbounded retry loop',async()=>{
  assert.equal(typeof reader.observeDaySummary,'function');
  const errors=[];let calls=0;
  await reader.observeDaySummary({scope,signal:new AbortController().signal,request:async()=>{calls++;throw Error('unavailable');},publish:assert.fail,onError:error=>errors.push(error.message),wait:async()=>assert.fail('idle reads require explicit retry')});
  assert.equal(calls,1);assert.deepEqual(errors,['unavailable']);
});
