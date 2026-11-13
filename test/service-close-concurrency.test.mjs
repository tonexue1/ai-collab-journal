import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/service.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

function harness(t,{holdWrites=false}={}){
  const events=[
    {seq:1,time:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'保留每次人的表达'}]}},
    {seq:2,time:2,type:'assistant/message',data:{message:{source:{provider:'fixture',model:'one'},content:[{type:'text',text:'检查过程与失败结果'.repeat(9000)}]}}},
  ];
  const tables={reports:new Map(),versions:new Map(),checkpoints:new Map()},calls=[],order=[],writeGate=deferred(),saveStarted=deferred();
  const state={closed:false,auto:false};
  const domain={
    table:name=>({
      get:id=>structuredClone(tables[name].get(id)),
      put:async(id,value)=>{
        if(name==='checkpoints'){
          saveStarted.resolve();
          if(holdWrites)await writeGate.promise;
          assert.equal(state.closed,false,'no checkpoint write may outlive the domain');
          order.push(`save:${Object.keys(value.cache).length}`);
        }
        tables[name].set(id,structuredClone(value));
      },
      delete:async id=>tables[name].delete(id),
    }),
    close:async()=>{state.closed=true;order.push('domain:close');},
  };
  const ctx={
    sessionQuery:{readSession:async id=>({session:{id},events:structuredClone(events)})},
    llm:{prepareCall:async config=>({config,async *stream(options){
      const gate=deferred();calls.push({...gate,signal:options.signal});
      if(state.auto)gate.resolve();
      // Deliberately ignore cancellation until the test releases this provider.
      await gate.promise;
      const {items}=JSON.parse(options.messages[0].content[0].text);
      yield {type:'text-delta',index:0,text:JSON.stringify({items:items.map(item=>({id:item.id,summary:'原文中的检查尚未验证成功。',details:[]}))})};
      yield {type:'finish',reason:{kind:'stop'}};
    }})},
  };
  const journal=new Journal(ctx,domain);
  t.after(async()=>{state.auto=true;writeGate.resolve();for(const call of calls)call.resolve();if(!state.closed)await journal.close();});
  return {journal,tables,calls,order,state,writeGate,saveStarted};
}

async function startThree(h){
  await h.journal.start('a');await turn();
  assert.equal(h.calls.length,3,'the fixture must have three provider calls in flight');
}
function close(h){
  const pending=h.journal.close();let settled=false;
  pending.then(()=>{settled=true;},()=>{settled=true;});
  return {pending,settled:()=>settled};
}

test('Journal.close retains the active job until all three providers stop, including providers ignoring abort',async t=>{
  const h=harness(t);await startThree(h);
  const closing=close(h);await turn();
  assert.ok(h.calls.every(call=>call.signal.aborted));
  assert.ok(h.journal.active);assert.equal(h.state.closed,false);assert.equal(closing.settled(),false);
  h.calls[0].resolve();h.calls[1].resolve();await turn();
  assert.ok(h.journal.active,'one provider still owns the job');assert.equal(h.state.closed,false);
  h.calls[2].resolve();await closing.pending;
  assert.equal(h.journal.active,null);assert.equal(h.state.closed,true);assert.equal(h.journal.runs.get('a').status,'cancelled');
  assert.deepEqual(h.order,['domain:close']);assert.equal(h.calls.length,3);
});

test('Journal.close waits for both an accepted checkpoint save and the remaining providers',async t=>{
  const h=harness(t,{holdWrites:true});await startThree(h);
  h.calls[0].resolve();await h.saveStarted.promise;
  const closing=close(h);await turn();
  assert.ok(h.journal.active);assert.equal(h.state.closed,false);
  h.writeGate.resolve();await turn();
  assert.equal(Object.keys(h.tables.checkpoints.get('a').cache).length,1);
  assert.ok(h.journal.active,'completed storage does not release still-running providers');assert.equal(closing.settled(),false);
  h.calls[1].resolve();h.calls[2].resolve();await closing.pending;
  assert.equal(h.journal.active,null);assert.equal(h.state.closed,true);
  assert.deepEqual(h.order,['save:1','domain:close']);assert.equal(h.calls.length,3);
  assert.equal(h.tables.reports.has('a'),false,'closing an unfinished job must not publish a result');
});

test('Journal.close drains every already accepted queued save before closing storage',async t=>{
  const h=harness(t,{holdWrites:true});await startThree(h);
  for(const call of h.calls)call.resolve();
  await h.saveStarted.promise;await turn();
  const closing=close(h);await turn();
  assert.equal(closing.settled(),false);assert.ok(h.journal.active);assert.equal(h.state.closed,false);
  h.writeGate.resolve();await closing.pending;await turn();
  assert.deepEqual(h.order,['save:1','save:2','save:3','domain:close']);
  assert.equal(Object.keys(h.tables.checkpoints.get('a').cache).length,3);
  assert.equal(h.journal.active,null);assert.equal(h.calls.length,3,'closing cannot dispatch another model batch');
  assert.equal(h.tables.reports.has('a'),false);
});
