import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/service.mjs';
function harness(){
 const events=[{seq:1,time:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'保留每次表达'}]}},{seq:2,time:2,type:'assistant/message',data:{message:{source:{provider:'fixture',model:'one'},content:[{type:'text',text:'过程'.repeat(7000)}]}}}];
 const tables={reports:new Map(),versions:new Map(),checkpoints:new Map()};
 let firstDurable;const durable=new Promise(resolve=>{firstDurable=resolve;});
 const domain={table:n=>({get:k=>structuredClone(tables[n].get(k)),put:async(k,v)=>{tables[n].set(k,structuredClone(v));if(n==='checkpoints')firstDurable();},delete:async k=>tables[n].delete(k)}),close:async()=>{}};
 let calls=0,failAt=2;
 const ctx={sessionQuery:{readSession:async()=>({session:{id:'a'},events:structuredClone(events)})},llm:{prepareCall:async config=>({config,async *stream(options){calls++;if(calls===failAt){await durable;throw Error('transport interrupted');}const {items}=JSON.parse(options.messages[0].content[0].text);yield {type:'text-delta',index:0,text:JSON.stringify({items:items.map(x=>({id:x.id,summary:'事实摘要',details:[]}))})};yield {type:'finish',reason:{kind:'stop'}};}})}};
 return {events,tables,domain,ctx,calls:()=>calls,allow:()=>{failAt=-1;}};
}
async function execute(j){await j.start('a');await j.active.pending;return j.detail('a');}
test('a failed batch survives closing the host and is reused after reopening',async()=>{
 const h=harness(),first=new Journal(h.ctx,h.domain);const failed=await execute(first);
 assert.equal(failed.run.status,'failed');assert.ok(failed.checkpoint,'completed batch must be persisted');assert.equal(failed.checkpoint.completedCalls,1);assert.equal(failed.report,null);
 await first.close();h.allow();const next=new Journal(h.ctx,h.domain),finished=await execute(next);
 assert.equal(finished.run.status,'completed');assert.equal(finished.run.reusedCalls,1);assert.equal(finished.report.nodes.length,2);assert.equal(finished.checkpoint,null);
 const before=h.calls();await execute(next);assert.ok(h.calls()-before>finished.run.modelCalls,'successful manual rerun must start fresh');
});
test('changed source or route cannot reuse an earlier checkpoint',async()=>{
 for(const change of [h=>{h.events[0].data.content[0].text+='新';},h=>{h.events[1].data.message.source.model='two';}]){
  const h=harness();await execute(new Journal(h.ctx,h.domain));change(h);h.allow();const d=await execute(new Journal(h.ctx,h.domain));assert.equal(d.run.status,'completed');assert.equal(d.run.reusedCalls,0);
 }
});
test('long parsing has no whole-job ten-minute deadline, individual calls retain their timeout',async t=>{
 const original=AbortSignal.timeout;const deadlines=[];
 t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return original(ms);});
 const h=harness();h.allow();const d=await execute(new Journal(h.ctx,h.domain));assert.equal(d.run.status,'completed');assert.ok(deadlines.every(ms=>ms===90000));
});
test('checkpoint cleanup failure does not relabel a published report as failed or reuse it on reparse',async()=>{
 const h=harness();h.allow();const table=h.domain.table;
 h.domain.table=n=>n==='checkpoints'?{...table(n),delete:async()=>{throw Error('cleanup unavailable');}}:table(n);
 const j=new Journal(h.ctx,h.domain),d=await execute(j);assert.equal(d.run.status,'completed');assert.ok(d.report);assert.equal(d.checkpoint,null);
 const again=await execute(j);assert.equal(again.run.reusedCalls,0);
});
