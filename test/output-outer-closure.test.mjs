import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput } from '../src/output.mjs';
const items=Array.from({length:4},(_,i)=>({id:`n18.${21+i}`,summary:`片段${i+1}：执行失败，结果尚未验证。`,details:['保留失败状态。','没有执行部署。']}));
const encode=value=>JSON.stringify(value);
const incomplete=value=>encode(value).slice(0,-2);
const expected=items.map(({id})=>({id}));
const reject=text=>assert.throws(()=>validateOutput(text,expected),error=>error.code==='MODEL_OUTPUT_INVALID');

test('only the absent outer items-array and root-object closures are completed without changing any item',()=>{
 const complete=encode({items}),raw=complete.slice(0,-2);
 assert.ok(raw.endsWith('}'));assert.equal(raw+']}',complete);
 assert.deepEqual(validateOutput(raw,expected),validateOutput(complete,expected));
 // Content that resembles delimiters is still an ordinary complete string.
 const escaped=items.map((item,i)=>({...item,summary:`失败 ${i}：括号 ]} 与引号 "、反斜线 \\ 都属于原文。`}));
 assert.deepEqual(validateOutput(incomplete({items:escaped}),expected),escaped);
 const one=[items[0]];assert.deepEqual(validateOutput(incomplete({items:one}),one),one);
});

test('incomplete strings, escapes, inner containers, trailing commas and other missing closures remain failures',()=>{
 const raw=incomplete({items});
 for(const text of [raw.slice(0,-1),raw+',',raw.slice(0,-3),raw.slice(0,-7)+'\\',raw.replace('"summary":','"summary" '),raw+']',raw+'}',encode({items}).slice(0,-1),'\{"items":[{"id":"n18.21","summary":"未闭合字符串}'])reject(text);
});

test('outer closure completion cannot supply missing items, required fields or permissive details conversions',()=>{
 const bad=[
  {items:items.slice(0,-1)},
  {items:[...items,{id:'extra',summary:'额外内容',details:[]}]},
  {items:items.map((x,i)=>i?x:{id:x.id,summary:x.summary})},
  {items:items.map((x,i)=>i?x:{id:x.id,details:x.details})},
  {items:items.map((x,i)=>i?x:{summary:x.summary,details:x.details})},
  {items:items.map((x,i)=>i?x:{...x,details:null})},
  {items:items.map((x,i)=>i?x:{...x,details:'完整JSON的字符串细节兼容不适用于修补'})},
  {other:'额外根字段',items},
 ];
 for(const value of bad)reject(incomplete(value));
});

test('all original field and exact-ID checks still apply after the two closing characters',()=>{
 const mutations=[x=>({...x,id:'wrong'}),x=>({...x,id:items[1].id}),x=>({...x,summary:'私'.repeat(181)}),x=>({...x,summary:''}),x=>({...x,summary:3}),x=>({...x,details:['私'.repeat(241)]}),x=>({...x,details:['1','2','3','4']}),x=>({...x,details:[null]})];
 for(const mutate of mutations)reject(incomplete({items:items.map((x,i)=>i?x:mutate(x))}));
});
