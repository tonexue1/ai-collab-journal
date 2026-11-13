import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal,JournalError } from '../src/service.mjs';
import { apply } from '../src/index.mjs';
import { sourceEntries,fingerprint } from '../src/trajectory.mjs';
import { indexInteractions } from '../src/interactions.mjs';
const raw=(seq,type,data,extra={})=>({seq,time:seq*1000,type,data,...extra});
const human=(seq,text=`人 ${seq}`)=>raw(seq,'user/message',{role:'user',id:'deliberately-shared-id',source:{kind:'user'},content:[{type:'text',text}]},{surfaceOp:'append'});
const ai=(seq,text=`AI ${seq}`,extra={})=>raw(seq,'assistant/message',{turn:1,step:seq,message:{role:'assistant',id:`ai-${seq}`,source:{kind:'model'},content:[{type:'text',text}]}},{surfaceOp:'append',...extra});
const context=(seq)=>raw(seq,'user/message',{role:'user',source:{kind:'compact-checkpoint'},content:[{type:'text',text:'先前失败的历史说明'}]},{surfaceOp:{op:'replace',startSeq:0,endSeq:0}});
const call=(seq,id='call-a')=>raw(seq,'tool/call',{turn:1,step:1,callId:id,name:'read',arguments:'{"file_path":"/synthetic/a"}'});
const result=(seq,id='call-a')=>raw(seq,'tool/result',{turn:1,step:1,message:{role:'tool',id:`result-${seq}`,source:{kind:'tool',callId:id},toolCallId:id,isError:false,content:[{type:'text',text:'工具返回；不表示任务已完成'}]}},{surfaceOp:'append',sourceEventSeqs:[seq-1]});
function index(events){return indexInteractions(sourceEntries(events));}
function harness(events){
 const domain={table(){throw Error('reading interactions must not access stored analysis');},close:async()=>{}};
 const ctx={sessionQuery:{readSession:async id=>({session:{id,origin:'main'},events:structuredClone(events)})}};
 Object.defineProperty(ctx,'llm',{get(){throw Error('reading interactions must not access a model');}});
 return {journal:new Journal(ctx,domain),ctx,domain};
}

test('each human keeps a seq anchor while consecutive requests share the preceding AI process',()=>{
 const events=[context(0),human(1),ai(2),call(3),result(4),human(5),human(6),context(7),ai(8),human(9),ai(10)];
 const before=structuredClone(events),items=index(events);
 assert.deepEqual(items.map(x=>({id:x.id,seq:x.human.seq,isFirst:x.isFirst,before:[x.before.fromSeq,x.before.toSeq,x.before.entryCount,x.before.toolCount],after:[x.after.fromSeq,x.after.toSeq,x.after.entryCount,x.after.toolCount]})),[
  {id:'h1',seq:1,isFirst:true,before:[0,0,1,0],after:[2,4,3,1]},
  {id:'h5',seq:5,isFirst:false,before:[1,4,4,1],after:[null,null,0,0]},
  {id:'h6',seq:6,isFirst:false,before:[1,5,5,1],after:[7,8,2,0]},
  {id:'h9',seq:9,isFirst:false,before:[5,8,4,0],after:[10,10,1,0]},
 ]);
 assert.deepEqual(events,before);assert.equal(items[2].human.text,'人 6');
});

test('before preview is the latest original assistant statement, not tools or historical replacements',()=>{
 const original='仍在调查，尚未验证。'.repeat(80);
 const items=index([human(1),ai(2,original),call(3),result(4),ai(5,'旧回复重写，不是新的回答',{surfaceOp:{op:'replace',startSeq:2,endSeq:2},sourceEventSeqs:[2]}),context(6),human(7)]);
 assert.deepEqual(items[0].before.preview,null);
 assert.deepEqual(items[1].before.preview,{seq:2,time:2000,text:original});
});

test('an all-human prefix stays separate without inventing an AI response',()=>{
 const items=index([human(1,'第一句'),human(2,'补充一句'),human(3,'再补充')]);
 assert.deepEqual(items.map(x=>[x.id,x.before.fromSeq,x.before.toSeq,x.before.preview]),[['h1',null,null,null],['h2',1,1,null],['h3',1,2,null]]);
 assert.deepEqual(index([context(1),ai(2)]),[]);
});

test('a tool-only AI process cannot reuse a natural reply outside its before range',()=>{
 const items=index([human(1),ai(2,'上一项请求的回复'),human(3),call(4),result(5),human(6),human(7)]);
 assert.equal(items[1].before.preview.seq,2);
 assert.deepEqual([items[2].before.fromSeq,items[2].before.toSeq],[3,5]);
 assert.equal(items[2].before.preview,null);
 assert.equal(items[3].before.preview,null);
});

test('reading interactions needs no model or stored report and anchors survive append',async()=>{
 const events=[human(1),ai(2),human(3)],{journal}=harness(events);
 assert.equal(typeof journal.interactions,'function');
 const first=await journal.interactions('session-a');assert.equal(first.id,'session-a');assert.equal(first.revision,fingerprint(sourceEntries(events)));assert.deepEqual(first.items.map(x=>x.id),['h1','h3']);
 events.push(ai(4),human(5));const second=await journal.interactions('session-a');assert.notEqual(second.revision,first.revision);assert.deepEqual(second.items.map(x=>x.id),['h1','h3','h5']);
});

test('before pages start at the nearest context while earlier pages retain original chronological order',async()=>{
 const events=[human(1),...Array.from({length:24},(_,i)=>ai(i+2)),human(26)],{journal}=harness(events);
 assert.equal(typeof journal.interactionContext,'function');const revision=fingerprint(sourceEntries(events));
 const nearest=await journal.interactionContext('a','h26',revision,'before',0,3);
 assert.deepEqual(nearest.entries.map(e=>e.seq),[24,25,26]);assert.deepEqual(nearest.highlight,[26]);assert.equal(nearest.total,26);assert.equal(nearest.cursorNext,3);
 const earlier=await journal.interactionContext('a','h26',revision,'before',nearest.cursorNext,3);
 assert.deepEqual(earlier.entries.map(e=>e.seq),[21,22,23]);assert.equal(earlier.cursorNext,6);
 const first=await journal.interactionContext('a','h26',revision,'before',24,3);assert.deepEqual(first.entries.map(e=>e.seq),[1,2]);assert.equal(first.cursorNext,null);
});

test('after pages start with the human and stop before the next human',async()=>{
 const events=[human(1),ai(2),call(3),result(4),human(5),ai(6)],{journal}=harness(events);
 assert.equal(typeof journal.interactionContext,'function');const revision=fingerprint(sourceEntries(events));
 const page=await journal.interactionContext('a','h1',revision,'after',0,2);assert.deepEqual(page.entries.map(e=>e.seq),[1,2]);assert.equal(page.total,4);assert.equal(page.cursorNext,2);
 const next=await journal.interactionContext('a','h1',revision,'after',2,2);assert.deepEqual(next.entries.map(e=>e.seq),[3,4]);assert.equal(next.cursorNext,null);
});

test('empty surrounding ranges still expose the exact human original',async()=>{
 const events=[human(1,'唯一的人原话')],{journal}=harness(events);assert.equal(typeof journal.interactionContext,'function');const revision=fingerprint(sourceEntries(events));
 for(const side of ['before','after']){const page=await journal.interactionContext('a','h1',revision,side);assert.equal(page.total,1);assert.equal(page.cursorNext,null);assert.deepEqual(page.entries[0].source,events[0]);assert.equal(page.entries[0].text,'唯一的人原话');}
});

test('old revisions are rejected instead of silently opening changed original context',async()=>{
 const events=[human(1),ai(2)],{journal}=harness(events);assert.equal(typeof journal.interactionContext,'function');const revision=fingerprint(sourceEntries(events));events.push(human(3));
 await assert.rejects(journal.interactionContext('a','h1',revision,'before'),error=>error instanceof JournalError&&error.status===409&&error.message==='会话已更新，请刷新后查看');
});

test('before provenance never links to a tool result that occurred after the human intervention',async()=>{
 const events=[human(1),call(2),human(3,'先停下'),result(4)],{journal}=harness(events);assert.equal(typeof journal.interactionContext,'function');const sourceBefore=structuredClone(events),revision=fingerprint(sourceEntries(events));
 const page=await journal.interactionContext('a','h3',revision,'before');const originalCall=page.entries.find(e=>e.seq===2);
 assert.ok(originalCall.provenance);assert.deepEqual(originalCall.provenance.resultSeqs??[],[]);assert.deepEqual(originalCall.source,events[1]);assert.deepEqual(events,sourceBefore);assert.equal(revision,fingerprint(sourceEntries(events)));
});

test('invalid ranges and absent human anchors fail explicitly',async()=>{
 const {journal}=harness([human(1)]);assert.equal(typeof journal.interactionContext,'function');const revision=fingerprint(sourceEntries([human(1)]));
 await assert.rejects(journal.interactionContext('a','h999',revision,'before'),e=>e.status===404);
 for(const [side,offset,limit]of[['both',0,20],['before',-1,20],['before',0,0],['before',1.5,20],['before',0,2.5]])await assert.rejects(journal.interactionContext('a','h1',revision,side,offset,limit),e=>e.status===400);
});

test('HTTP read actions serve the index and reject stale context with 409',async()=>{
 const events=[human(1),ai(2),human(3)],h=harness(events);let endpoint;
 const ctx={...h.ctx,storageDomain:{open:async()=>h.domain},effect(fn){fn();},connection:{fetch:{register(route){endpoint=route;return()=>{};}}}};
 await apply(ctx);
 const request=body=>endpoint.fetch(new Request('http://localhost/api/dsh-collab-journal',{method:'POST',body:JSON.stringify(body)}));
 const listing=await request({action:'interactions',id:'a'});assert.equal(listing.status,200);const payload=await listing.json();assert.deepEqual(payload.value.items.map(x=>x.id),['h1','h3']);
 const reading=await request({action:'interactionContext',id:'a',interactionId:'h3',revision:payload.value.revision,side:'before',limit:2});assert.equal(reading.status,200);assert.deepEqual((await reading.json()).value.entries.map(e=>e.seq),[2,3]);
 events.push(ai(4));const stale=await request({action:'interactionContext',id:'a',interactionId:'h3',revision:payload.value.revision,side:'before'});assert.equal(stale.status,409);assert.equal((await stale.json()).error,'会话已更新，请刷新后查看');
});
