import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sourceEntries,trajectoryNodes,ANALYSIS_VERSION,SYSTEM } from '../src/trajectory.mjs';

const questions={questions:[{id:'scope',question:'先验证哪部分？'},{id:'next',question:'后续如何处理？'}]};
const answers={answers:[{id:'scope',selected:['短会话','工具失败']},{id:'next',selected:[],custom:'先不要部署'}]};
const call=(seq=2,name='ask_user_question',args=questions,callId='ask-1')=>({seq,time:seq,type:'tool/call',data:{name,callId,arguments:typeof args==='string'?args:JSON.stringify(args)}});
const result=(seq=3,response=answers,callId='ask-1',isError=false)=>({seq,time:seq,type:'tool/result',data:{message:{source:{callId},isError,content:[{type:'text',text:typeof response==='string'?response:JSON.stringify(response)}]}}});
const user=(seq,text)=>({seq,time:seq,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text}]}});
const ai=(seq,text)=>({seq,time:seq,type:'assistant/message',data:{message:{content:[{type:'text',text}]}}});

test('a matched question-tool submission preserves every answer as one independent human expression',()=>{
 for(const name of ['ask_user_question','functions.ask_user_question']){
  const submitted=result();const entries=sourceEntries([user(1,'请开始'),call(2,name),submitted,ai(4,'收到'),user(5,'还有补充')]);
  assert.equal(entries[2].role,'user');
  assert.equal(entries[2].text,'问答控件中的人类答复\n\n问题（AI提问）：先验证哪部分？\n答复：短会话；工具失败\n\n问题（AI提问）：后续如何处理？\n答复：先不要部署');
  assert.deepEqual(entries[2].source,submitted);assert.notEqual(entries[2].source,submitted);
  assert.deepEqual(trajectoryNodes(entries).map(n=>({role:n.role,seqs:n.seqs})),[
   {role:'user',seqs:[1]},{role:'assistant',seqs:[2]},{role:'user',seqs:[3]},{role:'assistant',seqs:[4]},{role:'user',seqs:[5]},
  ]);
 }
});

test('separate question submissions stay separate even when adjacent',()=>{
 const entries=sourceEntries([call(),result(),result(4,{answers:[{id:'scope',selected:[]},{id:'next',custom:'仍未完成'}]})]);
 assert.deepEqual(trajectoryNodes(entries).map(n=>({role:n.role,seqs:n.seqs})),[{role:'assistant',seqs:[2]},{role:'user',seqs:[3]},{role:'user',seqs:[4]}]);
});

test('unmatched, future, duplicate and non-question calls cannot turn tool JSON into a human statement',()=>{
 const cases=[
  [result()],
  [result(),call(4)],
  [call(9),result(3)],
  [call(1),call(2),result(3)],
  [call(1,'bash'),result()],
  [call(1,'other.ask_user_question'),result()],
  [call(1),result(3,answers,'different')],
 ];
 for(const events of cases){
  const projected=sourceEntries(events),original=events.find(e=>e.type==='tool/result');
  const value=projected.find(e=>e.seq===original.seq);assert.equal(value.role,'assistant');
  assert.equal(value.text,original.data.message.content[0].text);assert.deepEqual(value.source,original);
 }
});

test('failed or malformed answers retain their original tool text and never manufacture human input',()=>{
 const badResponses=[
  '{not json',{}, {answers:[]}, {answers:[{id:'missing',selected:['yes']}]},
  {answers:[{id:'scope',selected:'yes'}]}, {answers:[{id:'scope',selected:[3]}]},
  {answers:[{id:'scope',custom:3}]},{answers:[{id:'scope'}]},
  {answers:[{id:'scope',selected:['']}]},
  {answers:[{id:'scope',selected:['仅部分问题']}]},
  {answers:[{id:'scope',selected:['yes']},{id:'scope',custom:'duplicate'}]},
 ];
 for(const response of badResponses){
  const original=result(3,response),value=sourceEntries([call(),original])[1];
  assert.equal(value.role,'assistant');assert.equal(value.text,original.data.message.content[0].text);assert.deepEqual(value.source,original);
 }
 const failed=result(3,answers,'ask-1',true),value=sourceEntries([call(),failed])[1];
 assert.equal(value.role,'assistant');assert.ok(value.text.startsWith(failed.data.message.content[0].text));assert.match(value.text,/工具失败/);
});

test('ambiguous or malformed question definitions keep the answer as a tool record',()=>{
 const badRequests=['invalid',{questions:[]},{questions:[{id:'scope',question:7}]},{questions:[{id:'scope',question:'一'},{id:'scope',question:'二'}]}];
 for(const request of badRequests){const original=result();const value=sourceEntries([call(2,'ask_user_question',request),original])[1];assert.equal(value.role,'assistant');assert.equal(value.text,original.data.message.content[0].text);}
});

test('the new human boundaries invalidate checkpoints made by the previous parser',()=>{
 for(const tag of ['trajectory-v2\0','trajectory-v3\0'])assert.notEqual(ANALYSIS_VERSION,createHash('sha256').update(tag).update(SYSTEM).digest('hex'));
});


test('a submitted empty selection remains a human expression without inferring intent',()=>{
 for(const answer of [{id:'scope',selected:[]},{id:'scope',custom:'  '},{id:'scope',selected:[],custom:''}]){
  const original=result(3,{answers:[answer]}),value=sourceEntries([call(2,'ask_user_question',{questions:[questions.questions[0]]}),original])[1];
  assert.equal(value.role,'user');assert.match(value.text,/未选择选项、未填写其他答复/);assert.deepEqual(value.source,original);
 }
});

test('pending question results and non-boolean failure flags are never treated as submissions',()=>{
 for(const pending of [true,'true']){
  const original=result(3,{...answers,pending}),value=sourceEntries([call(),original])[1];assert.equal(value.role,'assistant');assert.equal(value.text,original.data.message.content[0].text);
 }
 for(const isError of [undefined,null,0,'false']){
  const original=result();original.data.message.isError=isError;
  assert.equal(sourceEntries([call(),original])[1].role,'assistant');
 }
});

test('a multi-question submission retains both a filled answer and an empty answer',()=>{
 const original=result(3,{answers:[{id:'scope',selected:['工具失败']},{id:'next',selected:[]}]}),value=sourceEntries([call(),original])[1];
 assert.equal(value.role,'user');assert.match(value.text,/答复：工具失败/);assert.match(value.text,/后续如何处理？\n答复：〔未选择选项、未填写其他答复〕/);assert.deepEqual(value.source,original);
});

const late=(seq=5,body={},source={})=>({seq,time:seq,type:'user/message',data:{source:{kind:'user-question-reply',callId:'ask-1',outcome:'answered',...source},content:[{type:'text',text:JSON.stringify({kind:'answer_to_pending_question',tool:'ask_user_question',callId:'ask-1',questions:questions.questions,answers:answers.answers,...body})}]}});

test('a late native answer to a continued question is a separate human expression',()=>{
 const submitted=late();const entries=sourceEntries([user(1,'请开始'),call(),result(3,{pending:true}),ai(4,'问题仍等待答复'),submitted,ai(6,'已收到答复')]);
 assert.equal(entries[2].role,'assistant');assert.equal(entries[4].role,'user');
 assert.match(entries[4].text,/短会话；工具失败/);assert.match(entries[4].text,/先不要部署/);assert.deepEqual(entries[4].source,submitted);
 assert.deepEqual(trajectoryNodes(entries).map(n=>({role:n.role,seqs:n.seqs})),[{role:'user',seqs:[1]},{role:'assistant',seqs:[2,3,4]},{role:'user',seqs:[5]},{role:'assistant',seqs:[6]}]);
});

test('late replies need a matching earlier call, answered provenance, and consistent body identities',()=>{
 const bad=[
  late(5,{}, {outcome:'continued'}),late(5,{}, {outcome:undefined}),late(5,{}, {kind:'runtime-context'}),
  late(5,{}, {callId:'other'}),late(5,{callId:'other'}),late(5,{kind:'something_else'}),late(5,{tool:'bash'}),
  late(5,{questions:[{id:'other',question:'伪造问题'}]}),late(5,{questions:[{id:'scope',question:'被替换的问题'},questions.questions[1]]}),
  late(5,{answers:[{id:'scope',selected:['工具失败']}]}),late(5,{pending:true}),
 ];
 for(const original of bad){const value=sourceEntries([call(),original])[1];assert.equal(value.role,'context');assert.equal(value.text,original.data.content[0].text);assert.deepEqual(value.source,original);}
 for(const prefix of [[],[call(2,'bash')],[call(2),call(3)],[call(9)]]){
  const original=late();const value=sourceEntries([...prefix,original]).at(-1);assert.equal(value.role,'context');assert.equal(value.text,original.data.content[0].text);
 }
});
