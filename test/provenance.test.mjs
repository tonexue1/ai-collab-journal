import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvenanceIndex } from '../src/provenance.mjs';
import { sourceEntries, fingerprint } from '../src/trajectory.mjs';
import { chainedChecksFixture,historicalCheckpointFixture,replacedResultFixture,quotedPanelFixture,returnedContentFixture } from './evidence-fixture.mjs';
const from=fixture=>sourceEntries(fixture.events);
const at=(entries,seq)=>entries.find(e=>e.seq===seq);

test('unique earlier calls link both ways while retaining source kind and original turn',()=>{
 const fixture=chainedChecksFixture(),entries=from(fixture),index=createProvenanceIndex(entries);
 assert.deepEqual([...index.keys()],entries.map(e=>e.seq));
 assert.deepEqual(index.get(fixture.facts.callSeq),{turn:1,resultSeqs:[fixture.facts.resultSeq]});
 assert.deepEqual(index.get(fixture.facts.resultSeq),{sourceKind:'tool',turn:1,callSeq:fixture.facts.callSeq,sourceEventSeqs:[fixture.facts.callSeq]});
 assert.deepEqual(index.get(1),{sourceKind:'user'});
});

test('a source cutoff excludes future records and every future result link',()=>{
 const fixture=chainedChecksFixture(),entries=from(fixture),cutoff=fixture.facts.resultSeq;
 const index=createProvenanceIndex(entries,{beforeSeq:cutoff});
 assert.ok([...index.keys()].every(seq=>seq<cutoff));assert.equal(index.has(cutoff),false);
 assert.deepEqual(index.get(fixture.facts.callSeq),{turn:1});
 const after=createProvenanceIndex(entries,{beforeSeq:cutoff+1});
 assert.deepEqual(after.get(fixture.facts.callSeq).resultSeqs,[cutoff]);
});

test('duplicate earlier call IDs are ambiguous, while a later duplicate cannot change earlier history',()=>{
 const fixture=chainedChecksFixture(),entries=from(fixture),call=at(entries,fixture.facts.callSeq),result=at(entries,fixture.facts.resultSeq);
 const duplicate=structuredClone(call);duplicate.seq=3;duplicate.source.seq=3;
 const afterDuplicate=structuredClone(result);afterDuplicate.seq=4;afterDuplicate.source.seq=4;
 const ambiguous=createProvenanceIndex([entries[0],call,duplicate,afterDuplicate]);
 assert.equal(ambiguous.get(afterDuplicate.seq).callSeq,undefined);assert.equal(ambiguous.get(call.seq).resultSeqs,undefined);
 const later=structuredClone(call);later.seq=10;later.source.seq=10;
 const laterResult=structuredClone(result);laterResult.seq=11;laterResult.source.seq=11;
 const index=createProvenanceIndex([...entries,later,laterResult]);
 assert.equal(index.get(result.seq).callSeq,call.seq);assert.deepEqual(index.get(call.seq).resultSeqs,[result.seq]);assert.equal(index.get(11).callSeq,undefined);
 const before=createProvenanceIndex([...entries,later,laterResult],{beforeSeq:10});assert.equal(before.get(result.seq).callSeq,call.seq);
});

test('unmatched, future, conflicting or malformed call identities are never guessed',()=>{
 const fixture=chainedChecksFixture(),entries=from(fixture),call=at(entries,fixture.facts.callSeq),result=at(entries,fixture.facts.resultSeq);
 assert.equal(createProvenanceIndex([result]).get(result.seq).callSeq,undefined);
 const future=structuredClone(call);future.seq=20;future.source.seq=20;
 assert.equal(createProvenanceIndex([result,future]).get(result.seq).callSeq,undefined);
 for(const edit of [m=>{m.source.callId='other';},m=>{m.toolCallId='other';},m=>{m.source.callId=123;},m=>{m.source.callId='';}]){
  const invalid=structuredClone(result);edit(invalid.source.data.message);
  assert.equal(createProvenanceIndex([call,invalid]).get(result.seq).callSeq,undefined);
 }
});

test('returned tool errors and nonzero shell exits do not produce an inferred success status',()=>{
 for(const failure of [false,true]){
  const fixture=chainedChecksFixture({failure}),entries=from(fixture),result=at(entries,fixture.facts.resultSeq);
  for(const isError of [false,true]){
   result.source.data.message.isError=isError;
   const record=createProvenanceIndex(entries).get(result.seq);
   assert.equal(record.callSeq,fixture.facts.callSeq);
   assert.deepEqual(Object.keys(record).sort(),['callSeq','sourceEventSeqs','sourceKind','turn']);
  }
 }
});

test('compact context preserves its historical replacement range instead of becoming a current action',()=>{
 const fixture=historicalCheckpointFixture(),entries=from(fixture),index=createProvenanceIndex(entries),record=index.get(fixture.facts.checkpointSeq);
 assert.equal(record.sourceKind,'compact-checkpoint');assert.equal(record.turn,undefined);
 assert.deepEqual(record.replaces,fixture.facts.replacedRange);assert.deepEqual(record.sourceEventSeqs,[1,2,3,4]);
 assert.equal(at(entries,fixture.facts.checkpointSeq).role,'context');
});

test('replayed results keep their original call and turn while remaining separate observed records',()=>{
 const fixture=replacedResultFixture(),entries=from(fixture),index=createProvenanceIndex(entries);
 const replay=entries.find(e=>e.source.surfaceOp?.op==='replace'),originalSeq=replay.source.surfaceOp.startSeq;
 const original=at(entries,originalSeq),call=entries.find(e=>e.type==='tool/call'&&e.source.data.callId===replay.source.data.message.source.callId);
 assert.equal(index.get(replay.seq).callSeq,call.seq);assert.equal(index.get(replay.seq).turn,replay.source.data.turn);
 assert.deepEqual(index.get(replay.seq).replaces,{startSeq:originalSeq,endSeq:originalSeq});assert.deepEqual(index.get(replay.seq).sourceEventSeqs,[originalSeq]);
 assert.ok(index.has(original.seq)&&index.has(replay.seq));assert.deepEqual(index.get(call.seq).resultSeqs,[original.seq,replay.seq]);
 const beforeReplay=createProvenanceIndex(entries,{beforeSeq:replay.seq});assert.deepEqual(beforeReplay.get(call.seq).resultSeqs,[original.seq]);
});

test('cutoff also filters source-event references and refuses a replacement range crossing that cutoff',()=>{
 const fixture=historicalCheckpointFixture(),entries=from(fixture),entry=at(entries,fixture.facts.checkpointSeq);
 entry.source.sourceEventSeqs=[1,2,99,'3',null];entry.source.surfaceOp={op:'replace',startSeq:1,endSeq:99};
 const record=createProvenanceIndex(entries,{beforeSeq:12}).get(entry.seq);
 assert.deepEqual(record.sourceEventSeqs,[1,2]);assert.equal(record.replaces,undefined);
});

test('indexing does not mutate raw evidence, roles, order or source fingerprints',()=>{
 for(const factory of [chainedChecksFixture,historicalCheckpointFixture,replacedResultFixture,quotedPanelFixture,returnedContentFixture]){
  const entries=from(factory()),before=structuredClone(entries),hash=fingerprint(entries);
  const index=createProvenanceIndex(entries);
  assert.deepEqual(entries,before);assert.equal(fingerprint(entries),hash);assert.deepEqual([...index.keys()],entries.map(e=>e.seq));
  for(const value of index.values()){if(value.sourceEventSeqs)value.sourceEventSeqs.push(99999);if(value.replaces)value.replaces.startSeq=99999;}
  assert.deepEqual(entries,before);
 }
});

test('a result arriving after the next human message cannot influence the evidence before that intervention',()=>{
 const fixture=chainedChecksFixture(),events=structuredClone(fixture.events);
 events.find(e=>e.type==='tool/result').seq=4;events.find(e=>e.type==='assistant/message').seq=5;
 events.splice(2,0,{seq:3,time:1700000003000,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'先停一下，刚才做到哪里了？'}]}});
 const entries=sourceEntries(events),before=createProvenanceIndex(entries,{beforeSeq:3});
 assert.deepEqual([...before.keys()],[1,2]);assert.equal(before.get(2).resultSeqs,undefined);assert.equal(before.has(3),false);assert.equal(before.has(4),false);
 assert.deepEqual(createProvenanceIndex(entries).get(2).resultSeqs,[4]);
});

test('a zero cutoff is empty and invalid cutoffs cannot silently broaden the observation window',()=>{
 const entries=from(chainedChecksFixture());assert.equal(createProvenanceIndex(entries,{beforeSeq:0}).size,0);
 for(const beforeSeq of [NaN,-1,1.5,'3',null])assert.throws(()=>createProvenanceIndex(entries,{beforeSeq}),RangeError);
});

test('historical source links and replacements cannot point to the same record or a future record',()=>{
 const entries=from(historicalCheckpointFixture()),entry=entries.find(e=>e.source.surfaceOp?.op==='replace');
 entry.source.sourceEventSeqs=[1,2,entry.seq,entry.seq+1];
 for(const endSeq of [entry.seq,entry.seq+1]){
  entry.source.surfaceOp={op:'replace',startSeq:1,endSeq};
  const value=createProvenanceIndex(entries,{beforeSeq:100}).get(entry.seq);
  assert.deepEqual(value.sourceEventSeqs,[1,2]);assert.equal(value.replaces,undefined);
 }
});
