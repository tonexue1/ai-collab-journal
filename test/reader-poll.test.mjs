import test from 'node:test';
import assert from 'node:assert/strict';
import { pollReader } from '../src/reader-poll.mjs';

function gate(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const running={id:'short',mode:'interactions',status:'running',startedAt:10,completed:4,total:5};
const completed={...running,status:'completed',completed:5};
function controlled(){
  const detail=gate(),interactions=gate(),controller=new AbortController(),published=[];
  const request=(action,params,signal)=>{
    const value=action==='detail'?detail:interactions;
    signal.addEventListener('abort',()=>value.reject(signal.reason),{once:true});
    return value.promise;
  };
  return {detail,interactions,controller,published,request};
}

test('completed detail cannot cancel the still-pending final interaction cards',async()=>{
  const h=controlled();
  const pending=pollReader({...h,activeRun:running,id:'short',timeZone:'Asia/Shanghai',signal:h.controller.signal,publish:batch=>{
    h.published.push(batch);if(batch.run?.status!=='running')h.controller.abort(new Error('React effect cleanup'));
  }});
  h.detail.resolve({id:'short',run:completed});
  await h.detail.promise;await Promise.resolve();
  assert.equal(h.published.length,0,'no task state is published before both reads settle');
  const cards={analysisRun:completed,items:[{id:'h54',analysis:{resultId:'last-result'}}]};
  h.interactions.resolve(cards);await pending;
  assert.equal(h.published.length,1);assert.equal(h.published[0].interactions,cards);
  assert.equal(h.published[0].run.status,'completed');
});

test('completed interaction cards cannot cancel the pending full-reader detail',async()=>{
  const h=controlled();
  const pending=pollReader({...h,activeRun:running,id:'short',signal:h.controller.signal,publish:batch=>{
    h.published.push(batch);if(batch.run?.status!=='running')h.controller.abort(new Error('React effect cleanup'));
  }});
  h.interactions.resolve({analysisRun:completed,items:[{id:'h54'}]});
  await h.interactions.promise;await Promise.resolve();
  assert.equal(h.published.length,0);
  const detail={id:'short',run:completed,report:{snapshotId:'existing'}};
  h.detail.resolve(detail);await pending;
  assert.equal(h.published.length,1);assert.equal(h.published[0].detail,detail);
});

test('an older running card snapshot keeps polling despite completed detail',async()=>{
  const h=controlled();
  const pending=pollReader({...h,activeRun:running,id:'short',signal:h.controller.signal,publish:batch=>h.published.push(batch)});
  h.interactions.resolve({analysisRun:running,items:[{id:'h54',analysis:null}]});
  await h.interactions.promise;
  h.detail.resolve({id:'short',run:completed});await pending;
  assert.equal(h.published.length,1);assert.equal(h.published[0].run.status,'running');
});

test('a failed final card read preserves active polling and exposes its error',async()=>{
  const h=controlled(),failure=new Error('temporary connection failure');
  const pending=pollReader({...h,activeRun:running,id:'short',signal:h.controller.signal,publish:batch=>h.published.push(batch)});
  h.detail.resolve({id:'short',run:completed});h.interactions.reject(failure);await pending;
  assert.equal(h.published.length,1);assert.equal(h.published[0].run.status,'running');
  assert.equal(h.published[0].interactionError,failure);
});

test('switching away cancels both reads without publishing into the new selection',async()=>{
  const h=controlled();
  const pending=pollReader({...h,activeRun:running,id:'short',signal:h.controller.signal,publish:batch=>h.published.push(batch)});
  h.controller.abort(new Error('selection changed'));await pending;
  assert.equal(h.published.length,0);
});

test('an unselected task completes without requesting another session’s cards',async()=>{
  const calls=[],published=[];
  await pollReader({activeRun:running,id:'other',signal:new AbortController().signal,request:async(action,params)=>{calls.push([action,params]);return {id:'short',run:completed};},publish:batch=>published.push(batch)});
  assert.deepEqual(calls,[['detail',{id:'short'}]]);assert.equal(published.length,1);
  assert.equal(published[0].interactions,null);assert.equal(published[0].run.status,'completed');
});

test('a newer interaction task observed while a full parse ends stays active',async()=>{
  const published=[],old={id:'short',status:'running',startedAt:5},newer={...running,startedAt:10};
  await pollReader({activeRun:old,id:'short',signal:new AbortController().signal,request:async action=>action==='detail'?{id:'short',run:{...old,status:'completed'}}:{analysisRun:newer,items:[]},publish:batch=>published.push(batch)});
  assert.equal(published[0].run,newer);
});

test('a restarted host delivers saved cards and releases only the obsolete task',async()=>{
  const published=[],cards={analysisRun:null,items:[{id:'h54',analysis:{resultId:'saved'}}]};
  await pollReader({activeRun:running,id:'short',signal:new AbortController().signal,request:async action=>action==='detail'?{id:'short',run:null}:cards,publish:batch=>published.push(batch)});
  assert.equal(published[0].idle,true);assert.equal(published[0].interactions,cards);
});
