import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeTrajectory,trajectoryPlan,ANALYSIS_VERSION,SYSTEM } from '../src/trajectory.mjs';
const entry=(seq,role,text,type=role==='user'?'user/message':'tool/result')=>({seq,time:seq,role,type,text,source:{seq}});
const good=({items})=>JSON.stringify({items:items.map(i=>({id:i.id,summary:'原文已经查看，未验证结果。',details:[]}))});

test('short records pack only within their original node and every escaped source character is recoverable',async()=>{
 const entries=[entry(1,'user','第一条人的表达'),...Array.from({length:80},(_,i)=>entry(i+2,i===9?'context':'assistant',`记录 ${i}：引号"和反斜线\\\n换行及表情😀。`)),entry(82,'user','补充一'),entry(83,'user','补充二'),entry(84,'assistant','巨量证据😀\\\n"'.repeat(900)+'末尾失败：部署未执行')];
 const original=structuredClone(entries),batches=[];
 const nodes=await analyzeTrajectory(async input=>{if(!input.items[0].fragments)batches.push(input.items);return good(input);},entries);
 const items=batches.flat(),parts=items.flatMap(i=>{assert.ok(i.text.length<=2400,'includes source markers and JSON escaping');return JSON.parse(i.text);});
 assert.ok(items.length<entries.length,'short records share a bounded fragment');
 const reconstructed=new Map(),offsets=new Map(),nodeBySeq=new Map(nodes.flatMap(n=>n.seqs.map(seq=>[seq,n.id])));
 for(const item of items){const sources=JSON.parse(item.text);assert.equal(new Set(sources.map(p=>nodeBySeq.get(p.seq))).size,1,'a fragment cannot cross a human boundary');}
 for(const p of parts){
  const e=entries.find(e=>e.seq===p.seq);assert.equal(p.type,e.type);assert.equal(p.role,e.role);assert.equal(p.offset,offsets.get(p.seq)??0);
  assert.ok(!/[\uD800-\uDBFF]$/.test(p.text)&&!(/^[\uDC00-\uDFFF]/.test(p.text)),'do not split surrogate pairs');
  reconstructed.set(p.seq,(reconstructed.get(p.seq)??'')+p.text);offsets.set(p.seq,p.offset+p.text.length);
 }
 assert.deepEqual([...reconstructed],entries.map(e=>[e.seq,e.text]));assert.deepEqual(entries,original);
 assert.deepEqual(nodes.filter(n=>n.role==='user').map(n=>n.seqs),[[1],[82],[83]]);
 assert.match(reconstructed.get(84),/末尾失败：部署未执行$/);
 assert.equal(trajectoryPlan(entries).fragmentCount,items.length);
});

test('packing changes the checkpoint algorithm version without changing the factual instruction',()=>{
 assert.notEqual(ANALYSIS_VERSION,createHash('sha256').update('trajectory-v4\0').update(SYSTEM).digest('hex'));
});
