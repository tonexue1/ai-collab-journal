import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceEntries} from '../src/trajectory.mjs';
import {analyzeIntervention,createInterventionBasis} from '../src/interventions.mjs';
const event=(seq,type,data)=>({seq,time:1700000000000+seq,type,data});
const human=(seq,text)=>event(seq,'user/message',{source:{kind:'user'},content:[{type:'text',text}]});
const ai=(seq,text)=>event(seq,'assistant/message',{turn:1,step:1,message:{source:{kind:'model'},content:[{type:'text',text}]}});
const ending=(seq,kind,message)=>event(seq,'turn/end',{turn:1,reason:{kind,...(message?{error:{code:'UNKNOWN',message}}:{})}});
const output=(seq,quote)=>({title:'要求继续处理',categories:[{label:'流程推进',evidence:[{seq,quote}]}],before:{text:'前文证据不足，无法确定介入前状态。',evidence:[]},contribution:{text:'要求继续处理。',evidence:[{seq,quote}]},certainty:'unclear'});
const analyze=(events,seq,generate)=>analyzeIntervention(generate,createInterventionBasis(sourceEntries(events),`h${seq}`),`h${seq}`);

for(const kind of ['aborted','blocked','error','max-tokens','interrupted','forked','extension-unknown']){
  test(`the preceding ${kind} termination is included whole before nearby tools can consume the budget`,async()=>{
    const events=[human(1,'检查所有测试。'),ai(2,'我先执行检查。'),event(3,'tool/call',{turn:1,step:1,callId:'large',name:'bash',arguments:'{"command":"check"}'}),event(4,'tool/result',{turn:1,step:1,message:{source:{kind:'tool',callId:'large'},toolCallId:'large',isError:false,content:[{type:'text',text:'日志'.repeat(30000)}]}}),ending(5,kind,kind==='error'?'Synthetic operation failed with unknown cause.':undefined),human(6,'人'.repeat(21000)+'继续处理。')];
    const stop=sourceEntries(events).find(e=>e.seq===5);
    const result=await analyze(events,6,async input=>{
      const evidence=input.evidence.find(e=>e.seq===5);assert.ok(evidence,'native stop must be visible on the first read');
      assert.equal(evidence.offset,0);assert.equal(evidence.text,stop.text);assert.equal(evidence.totalChars,stop.text.length);
      assert.ok(input.anchor.text.length+input.evidence.reduce((n,e)=>n+e.text.length,0)<=24000);
      const value=output(6,'继续处理。');value.before={text:'此前这一轮已停止。',evidence:[{seq:5,quote:stop.text}]};return JSON.stringify(value);
    });
    assert.ok(result.readEvidence.some(e=>e.seq===5&&e.text===stop.text));
  });
}

test('mandatory human and stop evidence exceeding the budget fails before a model call instead of truncating either',async()=>{
  let calls=0;
  await assert.rejects(analyze([human(1,'检查。'),ai(2,'开始检查。'),ending(3,'error','失败说明'.repeat(100)),human(4,'人'.repeat(23995))],4,async()=>{calls++;return JSON.stringify(output(4,'人'));}),error=>error.code==='INTERVENTION_INPUT_LIMIT');
  assert.equal(calls,0);
});

test('consecutive human expressions retain the stopped process while future and unrelated old stops stay excluded',async()=>{
  const events=[human(1,'旧任务。'),ai(2,'旧计划。'),ending(3,'error','旧任务失败'),human(4,'新的检查任务。'),ai(5,'先核对。'),ending(6,'aborted'),human(7,'继续处理。'),human(8,'补充约束：先不要修改。'),ending(9,'error','未来错误不应泄漏')];
  await analyze(events,8,async input=>{
    assert.ok(input.evidence.some(e=>e.seq===6));assert.ok(!input.evidence.some(e=>e.seq===3||e.seq===9));
    assert.ok(!JSON.stringify(input).includes('未来错误不应泄漏'));
    return JSON.stringify(output(8,'先不要修改。'));
  });
});

test('a tool-only new process cannot inherit a previous task termination',async()=>{
  const events=[human(1,'旧任务。'),ai(2,'旧计划。'),ending(3,'aborted'),human(4,'新的检查任务。'),event(5,'tool/call',{callId:'new',name:'bash',arguments:'{"command":"check"}'}),ending(6,'blocked'),human(7,'继续处理。')];
  await analyze(events,7,async input=>{assert.ok(input.evidence.some(e=>e.seq===6));assert.ok(!input.evidence.some(e=>e.seq===3));return JSON.stringify(output(7,'继续处理。'));});
});

test('an immediate stop after a human request retains the preceding AI reply as context alongside the stop',async()=>{
  const events=[human(1,'先解释方案。'),ai(2,'此前提出了两步方案。'),human(3,'按方案继续。'),ending(4,'aborted'),human(5,'继续处理。')];
  await analyze(events,5,async input=>{assert.ok(input.evidence.some(e=>e.seq===2));assert.ok(input.evidence.some(e=>e.seq===4));return JSON.stringify(output(5,'继续处理。'));});
});

test('a complete earlier human phrase that reappears is supplied with source time without assuming current intent',async()=>{
  const old='请先核对测试边界再讨论交付方案。';
  const events=[human(1,old),ai(2,'先核对边界。'),human(3,'现在讨论界面可读性。'),ai(4,'计划调整显示。'),human(5,`我前面说“${old}”，是在提示你考虑验证环节，不是新开任务。`),human(6,old)];
  await analyze(events,5,async input=>{
    const repeated=input.evidence.find(e=>e.seq===1);assert.ok(repeated);assert.equal(repeated.text,old);assert.equal(repeated.time,1700000000001);
    assert.deepEqual(input.repeatedHumanSources.map(e=>e.seq),[1]);assert.equal(input.repeatedHumanSources[0].providedChars,old.length);
    assert.ok(!input.evidence.some(e=>e.seq===6));assert.equal(input.anchor.text,events[4].data.content[0].text);
    const value=output(5,'不是新开任务。');value.title='澄清此前表达的作用';value.contribution.text='说明此前表达是在提示验证环节。';return JSON.stringify(value);
  });
});

test('repeated-human discovery is limited to three sufficiently long complete phrases and respects the shared budget',async()=>{
  const phrases=Array.from({length:5},(_,i)=>`过去的第${i+1}项明确约束必须核对完整。`),events=phrases.map((s,i)=>human(i+1,s));
  events.push(ai(6,'处理当前事项。'),human(7,'背景'.repeat(11500)+phrases.join('；')+'继续处理。'));
  const result=await analyze(events,7,async input=>{
    assert.equal(input.repeatedHumanSources.length,3);assert.deepEqual(input.repeatedHumanSources.map(e=>e.seq),[5,4,3]);
    assert.equal(input.anchor.text,events.at(-1).data.content[0].text);
    assert.ok(input.anchor.text.length+input.evidence.reduce((n,e)=>n+e.text.length,0)<=24000);
    return JSON.stringify(output(7,'继续处理。'));
  });
  assert.ok(result.readEvidence.some(e=>e.seq===3));
});

test('a short acknowledgement or merely partial old phrase does not create a repeated-human source match',async()=>{
  const events=[human(1,'好的'),human(2,'先核对所有边界再决定是否交付。'),ai(3,'当前计划。'),human(4,'好的，这次只提到了“先核对所有边界”。继续处理。')];
  await analyze(events,4,async input=>{assert.deepEqual(input.repeatedHumanSources,[]);return JSON.stringify(output(4,'继续处理。'));});
});
