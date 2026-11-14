import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/service.mjs';
import { apply } from '../src/index.mjs';
const human=(seq,time,text=`表达 ${seq}`)=>({seq,time:typeof time==='string'?Date.parse(time):time,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}});
const ai=(seq,time)=>({seq,time:Date.parse(time),type:'assistant/message',data:{message:{source:{provider:'fixture',model:'one'},content:[{type:'text',text:'尚未完成'}]}}});
function harness(){
 const logs=new Map([
  ['a',[human(1,'2026-11-03T15:59:00Z'),ai(2,'2026-11-03T15:59:30Z'),human(3,'2026-11-03T16:01:00Z'),ai(4,'2026-11-03T16:02:00Z')]],
  ['b',[human(1,'2026-11-03T16:03:00Z')]],['empty',[ai(1,'2026-11-04T10:00:00Z')]],['unknown',[human(1,NaN)]],
 ]);
 const tables=new Map(),domain={table:n=>({get:k=>tables.get(n)?.get(k),put:async(k,v)=>{if(!tables.has(n))tables.set(n,new Map());tables.get(n).set(k,v);}}),close:async()=>{}};
 const ctx={workspaceRegistry:{list:()=>[{id:'w',title:'同名',path:'/synthetic',sessionIds:['a','b','empty','unknown','broken']}],archivedSessionIds:['b']},sessionQuery:{listSessions:async()=>[...logs.keys(),'broken'].map(id=>({header:{id,origin:'main',createdAt:1}})).concat({header:{id:'child',origin:'subagent'}}),readSession:async id=>{if(!logs.has(id))throw Error('unreadable');return{session:{id,origin:'main'},events:structuredClone(logs.get(id))};}}};
 Object.defineProperty(ctx,'llm',{get(){throw Error('date reads must not use models');}});
 return{journal:new Journal(ctx,domain),ctx,domain,logs};
}
test('dates use actual human times, repeat a session across dates, and retain unreadable/unknown records',async()=>{
 const {journal}=harness();assert.equal(typeof journal.days,'function');
 const x=await journal.days({timeZone:'Asia/Shanghai'});
 assert.equal(x.timeZone,'Asia/Shanghai');assert.equal(x.unknownTimeCount,1);assert.deepEqual(x.errors.map(e=>e.id),['broken']);
 assert.deepEqual(x.days.map(d=>({date:d.date,h:d.humanCount,s:d.sessionCount,ids:d.sessions.map(s=>s.id)})),[{date:'2026-11-04',h:1,s:1,ids:['a']},{date:'2026-11-03',h:1,s:1,ids:['a']}]);
 assert.equal(x.days[0].sessions[0].firstHumanAt,Date.parse('2026-11-03T16:01:00Z'));assert.equal(x.days[0].sessions[0].workspaceId,'w');
});
test('archive and workspace filters count unique sessions within each day',async()=>{
 const {journal}=harness();assert.equal(typeof journal.days,'function');
 const x=await journal.days({timeZone:'Asia/Shanghai',includeArchived:true,workspaceId:'w'});assert.equal(x.days[0].humanCount,2);assert.equal(x.days[0].sessionCount,2);assert.deepEqual(x.days[0].sessions.map(s=>[s.id,s.archived]),[['b',true],['a',false]]);
 const empty=await journal.days({timeZone:'Asia/Shanghai',workspaceId:'elsewhere'});assert.deepEqual(empty.days,[]);assert.deepEqual(empty.errors,[]);assert.equal(empty.unknownTimeCount,0);
});
test('archive totals count human-bearing sessions and distinguish hidden archive from empty archive',async()=>{
 const {journal,ctx}=harness();ctx.workspaceRegistry.archivedSessionIds.push('empty');
 const hidden=await journal.days({timeZone:'Asia/Shanghai'});
 assert.deepEqual(hidden.totals,{sessionCount:2,humanCount:3,archivedSessionCount:1,hiddenArchivedSessionCount:1});
 assert.deepEqual([hidden.days[0].archivedSessionCount,hidden.days[0].hiddenArchivedSessionCount],[1,1]);
 const shown=await journal.days({timeZone:'Asia/Shanghai',includeArchived:true});assert.deepEqual(shown.totals,{sessionCount:3,humanCount:4,archivedSessionCount:1,hiddenArchivedSessionCount:0});assert.deepEqual([shown.days[0].archivedSessionCount,shown.days[0].hiddenArchivedSessionCount],[1,0]);
});
test('timezone changes day membership, and invalid zones or dates fail explicitly',async()=>{
 const {journal}=harness();assert.equal(typeof journal.days,'function');
 const utc=await journal.days({timeZone:'UTC'});assert.equal(utc.days.length,1);assert.equal(utc.days[0].humanCount,2);
 await assert.rejects(journal.days({timeZone:'invented/timezone'}),e=>e.status===400);
 await assert.rejects(journal.interactions('a',{date:'2026-02-30',timeZone:'Asia/Shanghai'}),e=>e.status===400);
});
test('day filtering is applied after complete boundaries, so before context crosses midnight',async()=>{
 const {journal}=harness(),x=await journal.interactions('a',{date:'2026-11-04',timeZone:'Asia/Shanghai'});
 assert.deepEqual(x.items.map(i=>i.id),['h3']);assert.equal(x.timeZone,'Asia/Shanghai');assert.equal(x.items[0].before.fromSeq,1);assert.equal(x.items[0].before.preview.seq,2);
 const context=await journal.interactionContext('a','h3',x.revision,'before');assert.deepEqual(context.entries.map(e=>e.seq),[1,2,3]);
});
test('DST overlap and skipped hours group by local calendar date without changing native order',async()=>{
 const {journal,logs}=harness();logs.set('a',[human(1,'2026-11-01T05:30:00Z'),human(2,'2026-11-01T06:30:00Z'),human(3,'2026-11-02T04:30:00Z'),human(4,'2026-11-02T05:30:00Z')]);
 const x=await journal.interactions('a',{date:'2026-11-01',timeZone:'America/New_York'});assert.deepEqual(x.items.map(i=>i.id),['h1','h2','h3']);
 logs.set('a',[human(1,'2026-03-08T06:59:00Z'),human(2,'2026-03-08T07:01:00Z')]);const spring=await journal.interactions('a',{date:'2026-03-08',timeZone:'America/New_York'});assert.deepEqual(spring.items.map(i=>i.id),['h1','h2']);
});
test('global days HTTP action requires no session id and never calls a model',async()=>{
 const h=harness();let endpoint;await apply({...h.ctx,storageDomain:{open:async()=>h.domain},effect:f=>f(),connection:{fetch:{register:r=>{endpoint=r;return()=>{};}}}});
 const response=await endpoint.fetch(new Request('http://localhost/api',{method:'POST',body:JSON.stringify({action:'days',timeZone:'Asia/Shanghai'})}));assert.equal(response.status,200);const x=await response.json();assert.equal(x.value.days.length,2);
});
