import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTrajectory,trajectoryPlan } from '../src/trajectory.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const evidence=[{seq:1,time:1,type:'user/message',role:'user',text:'保留顺序'},{seq:2,time:2,type:'tool/result',role:'assistant',text:'abcdefghijklmnopqrstuvwxyz'.repeat(2400)+'最终失败'}];
const answer=({items})=>JSON.stringify({items:items.map(i=>({id:i.id,summary:i.fragments?i.fragments.map(f=>f.summary).join('|').slice(-175):i.text.slice(-80),details:[]}))});
function controlled(){const waiting=[];return {waiting,generate:(input,signal)=>{const gate=deferred();waiting.push({...gate,input,signal});return gate.promise;}};}
async function needsThree(t,run,control,controller){
 await tick();const count=control.waiting.length;
 if(count!==3){controller.abort(Error('cleanup'));for(const w of control.waiting)w.resolve(answer(w.input));await assert.rejects(run);assert.equal(count,3,'three independent first-stage batches must start together');}
 return count===3;
}

test('default concurrency is three and serial comparison has identical ordered output at every merge level',async()=>{
 let active=0,max=0,mergeActive=0,maxMerge=0,calls=0;
 const nodes=await analyzeTrajectory(async input=>{const index=calls++,merge=!!input.items[0].fragments;active++;max=Math.max(max,active);if(merge){mergeActive++;maxMerge=Math.max(maxMerge,mergeActive);}
  // Complete each third batch first, making completion order differ from input.
  for(let n=0;n<3-index%3;n++)await tick();
  active--;if(merge)mergeActive--;return answer(input);
 },evidence);
 const serial=await analyzeTrajectory(async input=>answer(input),evidence,()=>{},undefined,{concurrency:1});
 assert.equal(max,3);assert.equal(maxMerge,3);assert.deepEqual(nodes,serial);assert.equal(calls,trajectoryPlan(evidence).totalCalls);assert.match(nodes[1].summary,/最终失败/);
});

test('out-of-order successes serialize checkpoint writes using the latest durable cache',async()=>{
 const cache={},snapshots=[];let saveActive=0,maxSave=0,modelActive=0,maxModel=0,index=0;
 await analyzeTrajectory(async input=>{const order=index++;modelActive++;maxModel=Math.max(maxModel,modelActive);for(let i=0;i<3-order%3;i++)await tick();modelActive--;return answer(input);},evidence,()=>{},undefined,{cache,save:async snapshot=>{saveActive++;maxSave=Math.max(maxSave,saveActive);await tick();snapshots.push(structuredClone(snapshot));saveActive--;}});
 assert.equal(maxModel,3);assert.equal(maxSave,1);assert.equal(snapshots.length,trajectoryPlan(evidence).totalCalls);
 for(let i=0;i<snapshots.length;i++){assert.equal(Object.keys(snapshots[i]).length,i+1);if(i)for(const [key,value]of Object.entries(snapshots[i-1]))assert.deepEqual(snapshots[i][key],value);}
 assert.deepEqual(cache,snapshots.at(-1));
 let modelCalls=0;const replay=await analyzeTrajectory(async()=>{modelCalls++;throw Error('cached');},evidence,()=>{},undefined,{cache:structuredClone(cache)});assert.equal(modelCalls,0);assert.equal(replay.length,2);
});

test('first model failure aborts peers, stops new claims, drains ignored aborts, and retains its exact stage',async t=>{
 const controller=new AbortController(),control=controlled(),failure=Error('first transport failure');let settled=false,lastStage;
 const run=analyzeTrajectory(control.generate,evidence,s=>{lastStage=s;},controller.signal);run.then(()=>{settled=true;},()=>{settled=true;});
 if(!await needsThree(t,run,control,controller))return;
 const failedStage='整理片段 4 / '+trajectoryPlan(evidence).fragmentCount;
 control.waiting[0].reject(failure);await tick();
 assert.equal(control.waiting.length,3);assert.ok(control.waiting.every(w=>w.signal.aborted));assert.equal(settled,false,'must await peers even when they ignore abort');
 for(const w of control.waiting.slice(1))w.resolve(answer(w.input));
 await assert.rejects(run,error=>error===failure&&error.analysisStage===failedStage);assert.equal(lastStage,failedStage);assert.equal(control.waiting.length,3);
});

test('external cancellation aborts every worker and returns only after they exit',async t=>{
 const controller=new AbortController(),control=controlled(),reason=Error('user cancelled');let settled=false;
 const run=analyzeTrajectory(control.generate,evidence,()=>{},controller.signal);run.then(()=>{settled=true;},()=>{settled=true;});
 if(!await needsThree(t,run,control,controller))return;
 controller.abort(reason);await tick();assert.ok(control.waiting.every(w=>w.signal.aborted));assert.equal(settled,false);
 for(const w of control.waiting)w.resolve(answer(w.input));await assert.rejects(run,error=>error===reason);assert.equal(control.waiting.length,3);
});

test('a first model failure still drains and commits a previously accepted checkpoint save',async t=>{
 const controller=new AbortController(),control=controlled(),saveGate=deferred();let persisted={},saveStarted=false,settled=false;
 const run=analyzeTrajectory(control.generate,evidence,()=>{},controller.signal,{save:async snapshot=>{saveStarted=true;await saveGate.promise;persisted=structuredClone(snapshot);}});run.then(()=>{settled=true;},()=>{settled=true;});
 if(!await needsThree(t,run,control,controller))return;
 control.waiting[0].resolve(answer(control.waiting[0].input));await tick();assert.ok(saveStarted);
 const failure=Error('second request failed');control.waiting[1].reject(failure);control.waiting[2].resolve(answer(control.waiting[2].input));await tick();assert.equal(settled,false);assert.deepEqual(persisted,{});
 saveGate.resolve();await assert.rejects(run,error=>error===failure);assert.equal(Object.keys(persisted).length,1);
 let calls=0,reused=0;await analyzeTrajectory(async input=>{calls++;return answer(input);},evidence,()=>{},undefined,{cache:persisted,onProgress:p=>{reused=p.reusedCalls;}});assert.equal(reused,1);assert.equal(calls,trajectoryPlan(evidence).totalCalls-1);
});

test('a failed checkpoint save poisons queued writes and stops workers without publishing unsaved cache',async()=>{
 const cache={},failure=Error('disk full'),gate=deferred();let writes=0,models=0;const progress=[];
 const run=analyzeTrajectory(async input=>{models++;return answer(input);},evidence,()=>{},undefined,{cache,onProgress:p=>progress.push(p),save:async()=>{writes++;await gate.promise;throw failure;}});
 await tick();const initialModels=models;gate.resolve();await assert.rejects(run,error=>error===failure);
 assert.equal(initialModels,3);assert.equal(models,3);assert.equal(writes,1);assert.deepEqual(cache,{});assert.equal(progress.at(-1).completedCalls,0);
});

test('cancellation drains all already accepted queued saves before returning, without claiming more work',async()=>{
 const controller=new AbortController(),gate=deferred(),reason=Error('pause during checkpoint');let models=0,writes=0,settled=false,persisted={};const cache={};
 const run=analyzeTrajectory(async input=>{models++;return answer(input);},evidence,()=>{},controller.signal,{cache,save:async snapshot=>{writes++;if(writes===1)await gate.promise;persisted=structuredClone(snapshot);}});run.then(()=>{settled=true;},()=>{settled=true;});
 await tick();assert.equal(models,3);assert.equal(writes,1);controller.abort(reason);await tick();assert.equal(settled,false);gate.resolve();
 await assert.rejects(run,error=>error===reason);assert.equal(models,3);assert.equal(writes,3);assert.equal(Object.keys(persisted).length,3);assert.deepEqual(cache,persisted);
});

test('a later save failure preserves previous commits and prevents all following queued writes',async()=>{
 const cache={},failure=Error('third write failed');let writes=0,persisted={};
 await assert.rejects(analyzeTrajectory(async input=>{await tick();return answer(input);},evidence,()=>{},undefined,{cache,save:async snapshot=>{writes++;await tick();if(writes===3)throw failure;persisted=structuredClone(snapshot);}}),error=>error===failure);
 assert.equal(writes,3);assert.equal(Object.keys(persisted).length,2);assert.deepEqual(cache,persisted);
});

test('format correction stays within its worker and the first terminal diagnostic survives peer cancellation',async()=>{
 let target,calls=0,active=0,max=0;const stages=[];
 await assert.rejects(analyzeTrajectory(async(input,signal)=>{
  target??=input.items[0].id;calls++;active++;max=Math.max(max,active);
  try {
   if(input.items[0].id===target){await tick();return '{invalid';}
   await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }finally{active--;}
 },evidence,s=>stages.push(s)),error=>error.code==='MODEL_OUTPUT_INVALID'&&error.attempts===3&&error.analysisStage===`整理片段 4 / ${trajectoryPlan(evidence).fragmentCount} · 格式纠正 2/2`);
 assert.equal(max,3);assert.equal(active,0);assert.equal(calls,5);assert.match(stages.at(-1),/整理片段 4.*格式纠正 2\/2/);
});

test('merge groups preserve every fragment position and never overlap different nodes',async()=>{
 const entries=[...evidence.slice(0,1),{...evidence[1],text:'a'.repeat(18000)},{seq:3,time:3,type:'user/message',role:'user',text:'第二次表达'},{seq:4,time:4,type:'tool/result',role:'assistant',text:'b'.repeat(18000)}],activeNodes=new Map(),firstIds=new Map();
 const nodes=await analyzeTrajectory(async({items})=>{
  const merge=!!items[0].fragments,node=items[0].id;
  if(merge){assert.ok(activeNodes.size===0||activeNodes.has(node),'different nodes must not merge concurrently');activeNodes.set(node,(activeNodes.get(node)??0)+1);}
  else for(const item of items){const key=item.id.split('.')[0];firstIds.set(key,[...(firstIds.get(key)??[]),item.id]);}
  for(let i=0;i<1+(items[0].text?.length??items[0].fragments[0].summary.length)%3;i++)await tick();
  if(merge){activeNodes.set(node,activeNodes.get(node)-1);if(!activeNodes.get(node))activeNodes.delete(node);}
  return JSON.stringify({items:items.map(i=>({id:i.id,summary:i.fragments?i.fragments.map(f=>f.summary).join('>'):i.id,details:[]}))});
 },entries);
 for(const n of nodes)assert.equal(n.summary,firstIds.get(n.id).join('>'));
});
