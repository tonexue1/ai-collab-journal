import test from 'node:test';
import assert from 'node:assert/strict';
import {modelGenerator} from '../src/model.mjs';
import {SYSTEM} from '../src/trajectory.mjs';
test('native model generator uses an explicit auxiliary system while preserving its default and DSH route',async()=>{
  const observed=[];const llm={prepareCall:async config=>({config,async *stream(options){observed.push(options);yield {type:'text-delta',index:0,text:'{}'};yield {type:'finish',reason:{kind:'stop'}};}})};
  const signal=new AbortController().signal,route={provider:'fixture',model:'registered'};
  await modelGenerator(llm,route,'session',{system:'Intervention contract'})({example:1},signal);
  await modelGenerator(llm,route,'session')({example:2},signal);
  assert.equal(observed[0].system,'Intervention contract');assert.equal(observed[1].system,SYSTEM);
  assert.equal(observed[0].provider,'fixture');assert.equal(observed[0].model,'registered');assert.equal(observed[0].sessionId,'session');
});
