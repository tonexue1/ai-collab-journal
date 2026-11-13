import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutput, OutputValidationError, analyzeTrajectory } from '../src/trajectory.mjs';

const item = {id:'n1.0.0',summary:'已检查接口，尚未修改代码。',details:[]};
const encode = (...items) => JSON.stringify({items});
const expected = [{id:item.id}];

test('format compatibility preserves text, order and original IDs', () => {
  for (const details of [undefined, null, [], '', '  尚未验证。  ']) {
    const result=validateOutput('```JSON\n'+encode({...item,summary:'  已检查\n接口。  ',details})+'\n```',expected);
    assert.deepEqual(result,[{id:item.id,summary:'已检查 接口。',details:details?.trim?.()?['尚未验证。']:[]}]);
  }
  assert.deepEqual(validateOutput(encode({...item,id:'b'},item),[...expected,{id:'b'}]).map(x=>x.id),[item.id,'b']);
});

test('each invalid field has a specific, private-content-free diagnostic', () => {
  const cases=[
    ['private JSON secret', 'INVALID_JSON', '$'],
    ['null','INVALID_ITEMS','items'],
    [encode(null),'INVALID_ITEM','items[0]'],
    [encode({...item,id:'private secret'}),'UNKNOWN_ID','items[0].id'],
    [encode({...item,summary:null}),'INVALID_SUMMARY','items[0].summary'],
    [encode({...item,summary:' '}),'INVALID_SUMMARY','items[0].summary'],
    [encode({...item,summary:'私'.repeat(181)}),'SUMMARY_LENGTH','items[0].summary'],
    [encode({...item,details:{secret:'private secret'}}),'INVALID_DETAILS','items[0].details'],
    [encode({...item,details:['a','b','c','d']}),'DETAIL_COUNT','items[0].details'],
    [encode({...item,details:[42]}),'INVALID_DETAIL','items[0].details[0]'],
    [encode({...item,details:['私'.repeat(241)]}),'DETAIL_LENGTH','items[0].details[0]'],
    [encode(), 'MISSING_ID','items'],
  ];
  for(const [text,code,path] of cases) assert.throws(()=>validateOutput(text,expected), error=>{
    assert.ok(error instanceof OutputValidationError);
    assert.ok(error.issues.some(x=>x.code===code&&x.path===path),JSON.stringify(error.issues));
    assert.doesNotMatch(JSON.stringify(error)+error.message,/private secret|私/);
    return true;
  });
  assert.throws(()=>validateOutput(encode(item,item),[...expected,{id:'b'}]), e=>e.issues.some(x=>x.code==='DUPLICATE_ID'));
});

const entries = [
  {seq:0,time:1,type:'user/message',role:'user',text:'检查接口'},
  {seq:1,time:2,type:'assistant/message',role:'assistant',text:'调查'.repeat(1300)},
];
const good = items => encode(...items.map(x=>({id:x.id,summary:'已调查，尚未验证。',details:[]})));

test('both fragment and merge failures are repaired using the same evidence and exact IDs', async () => {
  const inputs=[],stages=[];
  const nodes=await analyzeTrajectory(async input=>{
    inputs.push(structuredClone(input));
    for(const i of input.items){assert.equal(i.nodeId,undefined);assert.equal(i.seq,undefined);assert.ok(!i.fragments?.some(f=>f.id));}
    if(!input.correction)return encode(...input.items.map(x=>({id:x.id,summary:'长'.repeat(181),details:[]})));
    assert.equal(input.correction.issues[0].code,'SUMMARY_LENGTH');
    assert.deepEqual(input.correction.expectedIds,input.items.map(x=>x.id));
    return good(input.items);
  },entries,s=>stages.push(s));
  assert.equal(nodes.length,2);
  assert.equal(inputs.length,4);
  assert.deepEqual(inputs[0].items,inputs[1].items);
  assert.deepEqual(inputs[2].items,inputs[3].items);
  assert.ok(stages.some(s=>s.includes('合并轨迹')&&s.includes('格式纠正')));
});

test('persistent bad IDs fail after two repair attempts, never become a guessed match', async () => {
  let calls=0;
  await assert.rejects(analyzeTrajectory(async input=>{calls++;return encode(...input.items.map(x=>({...item,id:'wrong'})));},entries),e=>{
    assert.equal(e.code,'MODEL_OUTPUT_INVALID');assert.equal(e.attempts,3);
    assert.ok(e.issues.some(x=>x.code==='UNKNOWN_ID'));return true;
  });
  assert.equal(calls,3);
});

test('provider errors and cancellation are not retried as format errors', async () => {
  let calls=0;
  await assert.rejects(analyzeTrajectory(async()=>{calls++;throw Error('provider unavailable');},entries),/provider unavailable/);
  assert.equal(calls,1);
  const abort=new AbortController();calls=0;
  await assert.rejects(analyzeTrajectory(async()=>{calls++;abort.abort(Error('stopped'));return 'bad JSON';},entries,()=>{},abort.signal),/stopped/);
  assert.equal(calls,1);
});
