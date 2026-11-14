import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceEntries } from '../src/trajectory.mjs';
import { historicalCheckpointFixture,replacedResultFixture } from './evidence-fixture.mjs';
const api=await import('../src/interventions.mjs').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
const entry=(seq,role,text,type=role==='user'?'user/message':'assistant/message')=>({seq,time:1700000000000+seq,role,type,text,source:{seq,type,data:role==='user'?{source:{kind:'user'}}:{turn:1,message:{source:{kind:'model'}}}}});
const history=()=>[entry(1,'user','先只检查，不要改动。'),entry(2,'assistant','我准备直接修改配置。'),entry(3,'user','先停下，先解释修改原因。'),entry(4,'assistant','这是介入以后的动作，不得提供。')];
const citation=(seq,quote)=>({seq,quote});
const good=()=>({title:'暂停修改，要求先解释原因',categories:[{label:'方向纠正',evidence:[citation(3,'先停下，先解释修改原因。')]}],before:{text:'AI 表示准备直接修改配置。',evidence:[citation(2,'我准备直接修改配置。')]},contribution:{text:'要求停止修改并先解释原因。',evidence:[citation(3,'先停下，先解释修改原因。')]},certainty:'supported'});
const basisFor=entries=>api.createInterventionBasis(entries,'h3');

test('basis freezes the complete historical prefix but excludes later results and append invalidation',()=>{
  assert.equal(typeof api.createInterventionBasis,'function','intervention basis implementation is missing');
  const original=history(),basis=basisFor(original);
  assert.deepEqual(basis.entries.map(e=>e.seq),[1,2,3]);
  assert.equal(basis.humanSeq,3);assert.equal(basis.anchorId,'h3');
  assert.equal(basis.basisHash,basisFor([...original,entry(5,'user','later')]).basisHash);
  original[0].text='changed';original[0].source.data.source.kind='changed';
  assert.equal(basis.entries[0].text,'先只检查，不要改动。');
  assert.equal(basis.entries[0].source.data.source.kind,'user');
  assert.notEqual(basis.basisHash,basisFor(original).basisHash);
  assert.throws(()=>api.createInterventionBasis(history(),'h2'),/人的表达/);
});

test('listing can compute the same basis identity without cloning the complete source for every anchor',t=>{
  assert.equal(typeof api.interventionBasisHash,'function','lightweight intervention identity is missing');
  const entries=history(),expected=basisFor(entries).basisHash;
  t.mock.method(globalThis,'structuredClone',()=>{throw Error('listing must not clone entire source prefixes');});
  assert.equal(api.interventionBasisHash(entries,'h3'),expected);
  assert.equal(api.interventionBasisHash([...entries,entry(5,'user','later')],'h3'),expected);
  entries[0].text='changed history';assert.notEqual(api.interventionBasisHash(entries,'h3'),expected);
});

test('first semantic read provides human in full, prior request and AI evidence with verifiable offsets',async()=>{
  assert.equal(typeof api.analyzeIntervention,'function','semantic intervention analysis is missing');
  let calls=0;const inputs=[];
  const result=await api.analyzeIntervention(async input=>{inputs.push(structuredClone(input));return JSON.stringify(good());},basisFor(history()),'h3',undefined,{onCall:()=>calls++});
  assert.equal(calls,1);assert.deepEqual(result.result,good());
  assert.equal(inputs[0].anchor.text,'先停下，先解释修改原因。');
  assert.deepEqual(inputs[0].evidence.map(e=>e.seq),[1,2]);
  assert.ok(!JSON.stringify(inputs).includes('介入以后的动作'));
  for(const read of result.readEvidence){const source=history().find(e=>e.seq===read.seq);assert.equal(read.text,source.text.slice(read.offset,read.offset+read.text.length));assert.equal(read.totalChars,source.text.length);}
  assert.equal(result.coverage.complete,true);assert.equal(result.coverage.rounds,1);
});

test('semantic retrieval reads requested earlier evidence without leaking later records',async()=>{
  const entries=[entry(0,'assistant','更早的约束：必须保留蓝色入口。'),...history()];let calls=0;
  const output=good();output.before={text:'此前要求保留蓝色入口。',evidence:[citation(0,'必须保留蓝色入口')]};
  const result=await api.analyzeIntervention(async input=>{
    calls++;if(calls===1){assert.ok(!input.evidence.some(e=>e.seq===0));return JSON.stringify({need:{seqs:[0]}});}
    assert.ok(input.evidence.some(e=>e.seq===0));return JSON.stringify(output);
  },basisFor(entries),'h3');
  assert.equal(calls,2);assert.equal(result.coverage.rounds,2);assert.equal(result.result.before.text,'此前要求保留蓝色入口。');
});

test('consecutive human interventions still initially see the most recent AI process',async()=>{
  const entries=history().slice(0,3);entries.push(entry(4,'user','补充一点：不要重启服务。'));
  const output=good();output.categories=[{label:'上下文补充',evidence:[citation(4,'不要重启服务。')]}];output.contribution={text:'补充不重启服务的约束。',evidence:[citation(4,'不要重启服务。')]};
  let calls=0;
  const result=await api.analyzeIntervention(async input=>{calls++;assert.ok(input.evidence.some(e=>e.seq===2));assert.ok(input.evidence.some(e=>e.seq===3));return JSON.stringify(output);},api.createInterventionBasis(entries,'h4'),'h4');
  assert.equal(calls,1);assert.equal(result.result.before.evidence[0].seq,2);
});

test('literal search can read a middle passage in a long older source with explicit partial coverage',async()=>{
  const older=entry(0,'assistant','开头'.repeat(5000)+'定位词：蓝色入口必须保留。'+'结尾'.repeat(5000));let calls=0;
  const output=good();output.before={text:'此前记录要求保留蓝色入口。',evidence:[citation(0,'蓝色入口必须保留。')]};
  const result=await api.analyzeIntervention(async input=>{calls++;return calls===1?JSON.stringify({need:{query:'蓝色入口'}}):JSON.stringify(output);},basisFor([older,...history()]),'h3');
  const read=result.readEvidence.find(e=>e.seq===0);
  assert.ok(read.offset>0);assert.ok(read.text.includes('蓝色入口必须保留。'));assert.equal(read.totalChars,older.text.length);
  assert.equal(result.coverage.complete,false);assert.ok(result.coverage.readChars<=24000);
});

test('citations cannot reference unread text, future messages or fabricated quotes; repair is bounded',async()=>{
  for(const [change,path] of [
    [x=>x.contribution.evidence=[citation(4,'这是介入以后的动作，不得提供。')],'contribution.evidence'],
    [x=>x.before.evidence=[citation(2,'配置已经修改成功')],'before.evidence'],
    [x=>x.contribution.evidence=[citation(1,'先只检查，不要改动。')],'contribution.evidence'],
    [x=>x.categories.push({label:'未判定',evidence:[citation(3,'先停下')]}),'categories'],
  ]){
    let calls=0;const output=good();change(output);
    await assert.rejects(api.analyzeIntervention(async()=>{calls++;return JSON.stringify(output);},basisFor(history()),'h3'),error=>{
      assert.equal(error.code,'MODEL_OUTPUT_INVALID');assert.equal(error.attempts,3);assert.ok(error.issues.some(i=>i.path.startsWith(path)));assert.ok(!error.message.includes('配置已经修改成功'));return true;
    });assert.equal(calls,3);
  }
});

test('quotes tolerate whitespace normalization but cannot bridge an unread gap',async()=>{
  const entries=history();entries[1].text='我准备\n  直接修改配置。';
  const output=good();output.before.evidence=[citation(2,'我准备 直接修改配置。')];
  assert.equal((await api.analyzeIntervention(async()=>JSON.stringify(output),basisFor(entries),'h3')).result.before.evidence[0].quote,'我准备 直接修改配置。');
  entries[1].text='已读开头'+ '中'.repeat(12000)+'已读结尾';
  output.before.evidence=[citation(2,'已读开头已读结尾')];
  await assert.rejects(api.analyzeIntervention(async()=>JSON.stringify(output),basisFor(entries),'h3'),error=>error.issues.some(i=>i.code==='QUOTE_NOT_READ'));
});

test('missing before evidence permits only explicit unknown or genuinely first-task wording',async()=>{
  const output=good();output.before={text:'AI 没有解决任何问题。',evidence:[]};
  await assert.rejects(api.analyzeIntervention(async()=>JSON.stringify(output),basisFor(history()),'h3'),error=>error.issues.some(i=>i.path==='before.evidence'));
  output.before={text:'前文证据不足，无法确定介入前状态。',evidence:[]};output.certainty='unclear';
  assert.equal((await api.analyzeIntervention(async()=>JSON.stringify(output),basisFor(history()),'h3')).result.certainty,'unclear');
  const first=[entry(3,'user','开始新任务。')],initial={title:'开始新任务',categories:[{label:'新任务',evidence:[citation(3,'开始新任务。')]}],before:{text:'首次提出任务，之前没有可用交互记录。',evidence:[]},contribution:{text:'提出新任务。',evidence:[citation(3,'开始新任务。')]},certainty:'supported'};
  assert.equal((await api.analyzeIntervention(async()=>JSON.stringify(initial),basisFor(first),'h3')).result.categories[0].label,'新任务');
});

test('long human input fails explicitly before any model call and is not truncated',async()=>{
  let calls=0;const entries=history();entries[2].text='人'.repeat(24001);
  await assert.rejects(api.analyzeIntervention(async()=>{calls++;return '{}';},basisFor(entries),'h3'),error=>error.code==='INTERVENTION_INPUT_LIMIT');
  assert.equal(calls,0);
});

test('the human is sent once and remains whole even when previous requests exceed the reading budget',async()=>{
  const entries=history();entries[0].text='前'.repeat(70000);entries[2].text='人'.repeat(20000)+'先停下';
  const output=good();output.categories[0].evidence=[citation(3,'先停下')];output.contribution.evidence=[citation(3,'先停下')];
  output.before={text:'前文证据不足，无法确定介入前状态。',evidence:[]};output.certainty='unclear';
  let input;
  const result=await api.analyzeIntervention(async x=>{input=x;return JSON.stringify(output);},basisFor(entries),'h3');
  assert.equal(input.anchor.text,entries[2].text);
  assert.ok(input.anchor.text.length+input.evidence.reduce((n,e)=>n+e.text.length,0)<=24000);
  assert.ok(!input.evidence.some(e=>e.seq===3));
  assert.equal(result.readEvidence.find(e=>e.seq===3).text,entries[2].text);
  assert.ok(result.readEvidence.some(e=>e.seq===1&&e.text.length<e.totalChars));
  assert.equal(result.coverage.complete,false);assert.equal(result.coverage.budgetExhausted,true);
});

test('format repair preserves the same read evidence and accounts for every call without echoing invalid content',async()=>{
  let calls=0;const inputs=[];
  const result=await api.analyzeIntervention(async input=>{
    inputs.push(input);return inputs.length===1?'PRIVATE_INVALID_OUTPUT':JSON.stringify(good());
  },basisFor(history()),'h3',undefined,{onCall:()=>calls++});
  assert.equal(calls,2);assert.equal(result.coverage.rounds,1);assert.deepEqual(inputs[1].evidence,inputs[0].evidence);
  assert.equal(inputs[1].correction.issues[0].code,'INVALID_JSON');assert.ok(!JSON.stringify(inputs[1]).includes('PRIVATE_INVALID_OUTPUT'));
});

test('requested future or nonexistent sequence is corrected without ever reading it',async()=>{
  let calls=0;
  await assert.rejects(api.analyzeIntervention(async input=>{calls++;assert.ok(!JSON.stringify(input).includes('介入以后的动作'));return JSON.stringify({need:{seqs:[4]}});},basisFor([entry(0,'assistant','更早资料'),...history()]),'h3'),error=>error.issues.some(i=>i.code==='UNKNOWN_SOURCE'));
  assert.equal(calls,3);
});

test('partial Unicode evidence uses source offsets and does not split surrogate pairs',async()=>{
  const entries=history();entries[1].text='a'.repeat(1999)+'😀'+'b'.repeat(9000)+'😀'+'c'.repeat(1999);
  const output=good();output.before={text:'前文证据不足，无法确定介入前状态。',evidence:[]};output.certainty='unclear';
  const result=await api.analyzeIntervention(async()=>JSON.stringify(output),basisFor(entries),'h3');
  for(const part of result.readEvidence.filter(e=>e.seq===2)){
    assert.equal(part.text,entries[1].text.slice(part.offset,part.offset+part.text.length));
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part.text));
  }
});

test('each reading round retains cumulative evidence within budget and final round cannot request further reading',async()=>{
  const entries=[entry(0,'assistant','前'.repeat(60000)),...history()];let calls=0;
  await assert.rejects(api.analyzeIntervention(async input=>{
    calls++;assert.ok(input.evidence.reduce((n,e)=>n+e.text.length,0)<=24000);
    if(calls>=3)assert.equal(input.reading.canReadMore,false);
    return JSON.stringify({need:{seqs:[0]}});
  },basisFor(entries),'h3'),error=>{assert.ok(error.issues.some(i=>i.code==='READ_LIMIT'));return true;});
  assert.equal(calls,5); // Two successful reads, then final attempt + two format repairs.
});

test('cancellation after a read prevents every later model call',async()=>{
  const controller=new AbortController();let calls=0;
  await assert.rejects(api.analyzeIntervention(async()=>{calls++;controller.abort(new Error('paused'));return JSON.stringify({need:{query:'更早'}});},basisFor(history()),'h3',controller.signal),/paused/);
  assert.equal(calls,1);
});

test('historical context and replay provenance persist in supplied evidence without claiming success',async()=>{
  for(const factory of [historicalCheckpointFixture,replacedResultFixture]){
    const entries=sourceEntries(factory().events);const seq=entries.at(-1).seq+1;
    entries.push(entry(seq,'user','先说明这里的历史记录。'));const basis=api.createInterventionBasis(entries,`h${seq}`);
    let input;const output={title:'询问历史记录',categories:[{label:'任务指挥',evidence:[citation(seq,'先说明这里的历史记录。')]}],before:{text:'前文证据不足，无法确定介入前状态。',evidence:[]},contribution:{text:'要求解释历史记录。',evidence:[citation(seq,'先说明这里的历史记录。')]},certainty:'unclear'};
    await api.analyzeIntervention(async x=>{input=x;return JSON.stringify(output);},basis,`h${seq}`);
    const historical=input.evidence.filter(e=>e.provenance?.replaces||e.provenance?.sourceKind==='compact-checkpoint');
    assert.ok(historical.length);for(const item of historical){assert.equal(item.provenance.success,undefined);assert.ok(item.seq<=seq);}
    for(const item of input.evidence.filter(e=>e.provenance?.callSeq!==undefined))assert.ok(item.provenance.callSeq<item.seq);
  }
});
