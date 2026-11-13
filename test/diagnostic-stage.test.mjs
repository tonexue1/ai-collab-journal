import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/service.mjs';

test('a concurrent failure reports its own batch, not the last worker progress', {timeout:3000}, async()=>{
  const events=[
    {seq:1,time:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'保留失败位置'}]}},
    {seq:2,time:2,type:'assistant/message',data:{message:{source:{provider:'fixture',model:'one'},content:[{type:'text',text:'材料'.repeat(16000)}]}}},
  ];
  let started=0,releaseFirst;
  const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
  const ctx={sessionQuery:{readSession:async()=>({session:{id:'a'},events})},llm:{prepareCall:async config=>({config,async *stream(options){
    const index=started++;
    if(index===0){await firstGate;throw Error('first batch failed');}
    releaseFirst();
    await new Promise((resolve,reject)=>{
      if(options.signal.aborted)return reject(options.signal.reason);
      options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
    });
  }})}};
  const tables={reports:new Map(),versions:new Map(),checkpoints:new Map()};
  const domain={table:n=>({get:k=>tables[n].get(k),put:async(k,v)=>tables[n].set(k,v),delete:async k=>tables[n].delete(k)}),close:async()=>{}};
  const journal=new Journal(ctx,domain);
  await journal.start('a');await journal.active.pending;
  const detail=await journal.detail('a');
  assert.ok(started>=2,'at least two workers must have started');
  assert.equal(detail.run.status,'failed');
  assert.equal(detail.run.error,'first batch failed');
  assert.equal(detail.run.stage,`整理片段 4 / ${detail.plan.fragmentCount}`);
  assert.equal(detail.run.diagnostic.stage,detail.run.stage);
});
