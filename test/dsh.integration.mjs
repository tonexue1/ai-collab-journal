import assert from 'node:assert/strict';
import { createRuntime,delay } from './dsh-runtime.mjs';
import { verifyStorageUpgrade } from './storage-upgrade.mjs';
await verifyStorageUpgrade();

async function verifyScheduleAcrossRestart(runtime) {
  const read = () => runtime.api('getSchedule');
  const write = settings => runtime.api('setSchedule', settings);
  const modelCalls = async () => (await runtime.api('status', {}, 'journal-test')).calls;
  const before = await modelCalls();
  const defaults = await read();
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.time, '21:00');
  assert.equal(defaults.lastRun, null);

  // Keep the configured time several hours in the future even when CI runs
  // late at night in UTC. The host must stay idle during save and restore.
  const timeZone = new Date().getUTCHours() < 18 ? 'UTC' : 'Pacific/Honolulu';
  const scheduled = { enabled: true, time: '23:45', timeZone };
  const saved = await write(scheduled);
  assert.deepEqual(saved, { ...scheduled, lastRun: null });
  assert.deepEqual(await read(), saved);

  for (const invalid of [{ time: '24:10' }, { timeZone: 'Invalid/TimeZone' }]) {
    const rejected = await fetch(`${runtime.base}/api/dsh-collab-journal`, {
      method: 'POST',
      headers: { cookie: runtime.cookie, origin: runtime.base, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'setSchedule', ...scheduled, ...invalid }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).ok, false);
    assert.deepEqual(await read(), saved, 'a refused edit must preserve the last saved schedule');
  }
  assert.equal(await modelCalls(), before, 'saving a future schedule must not call the model');

  await runtime.stop();
  await runtime.start();
  assert.deepEqual(await read(), saved, 'the new host must restore the saved local time and zone');
  assert.equal(await modelCalls(), 0, 'a restored future schedule must not run early');

  const disabled = { ...scheduled, enabled: false };
  assert.deepEqual(await write(disabled), { ...disabled, lastRun: null });
  assert.deepEqual(await read(), { ...disabled, lastRun: null });
  assert.equal(await modelCalls(), 0);
}

async function verifyDaySummaries(runtime,pluginBuild){
  const fixture=(action,params={})=>runtime.api(action,params,'journal-test');
  const read=scope=>runtime.api('daySummary',scope);
  const start=scope=>runtime.api('generateDaySummary',scope);
  async function settled(scope,id){
    const deadline=Date.now()+10000;
    do{
      const view=await read(scope);
      assert.equal(view.run?.id,id,'polling a date must return its own job');
      if(view.run.status!=='running')return view;
      await delay(50);
    }while(Date.now()<deadline);
    throw Error(`day summary did not settle: ${scope.date} ${scope.timeZone}`);
  }
  const utc={date:'2025-07-02',timeZone:'UTC',includeArchived:false};
  const yesterday={...utc,date:'2025-07-01'},empty={...utc,date:'2025-07-03'};
  const shanghai={...utc,timeZone:'Asia/Shanghai'},archived={...utc,includeArchived:true};
  const allShanghai={...shanghai,includeArchived:true};
  await fixture('seed-day');
  const before=(await fixture('status')).calls;
  for(const [scope,sessionCount,humanCount] of [[utc,2,2],[yesterday,1,1],[empty,0,0],[shanghai,2,3],[archived,3,3],[allShanghai,3,4]]){
    const view=await read(scope);
    assert.deepEqual(view.scope,scope);assert.deepEqual(view.coverage,{sessionCount,humanCount});
    assert.equal(view.summary,null);assert.equal(view.run,null);assert.equal(view.canGenerate,humanCount>0);
  }
  assert.equal((await fixture('status')).calls,before,'browsing dates, time zones and archive scopes must never generate a summary');

  await fixture('hold',{value:true});
  const job=await start(utc);
  assert.equal(job.mode,'day-summary');assert.equal((await read(utc)).run.status,'running');
  assert.equal((await read(yesterday)).run,null,'a running job belongs only to its date');
  await fixture('hold',{value:false});
  const first=await settled(utc,job.id);
  assert.equal(first.run.status,'completed',JSON.stringify(first.run));assert.equal(first.run.modelCalls,1);
  assert.equal(first.stale,false);assert.equal(first.summary.humanCount,2);assert.equal(first.summary.sessionCount,2);
  assert.equal(first.summary.text,'当天包含 2 次人的表达。\n接口检查仍未完成，执行结果尚未确认。');
  assert.deepEqual(first.summary.sources.map(s=>[s.sessionId,s.humanSeqs]),[['journal-day-a',[4]],['journal-day-b',[2]]]);
  assert.equal(new Set(first.summary.sources.map(s=>s.workspaceId)).size,2,'both native workspaces must contribute, even with identical titles');
  for(const other of [yesterday,shanghai,archived])assert.equal((await read(other)).summary,null,'a saved summary must not appear in another scope');
  const status=await fixture('status');assert.equal(status.calls,before+1);
  const requestHumans=input=>input.sessions.map(s=>[s.sessionId,s.humans.map(h=>h.text)]);
  assert.deepEqual(requestHumans(status.dayInputs.at(-1)),[['journal-day-a',['午夜后：补充上下文。']],['journal-day-b',['接口检查仍未完成。']]]);

  const all=await settled(allShanghai,(await start(allShanghai)).id);
  assert.equal(all.run.status,'completed',JSON.stringify(all.run));assert.equal(all.summary.humanCount,4);
  assert.deepEqual(requestHumans((await fixture('status')).dayInputs.at(-1)),[
    ['journal-day-a',['午夜前：先确认目标。','午夜后：补充上下文。']],['journal-day-b',['接口检查仍未完成。']],['journal-day-archived',['归档事项：这次尝试失败。']],
  ]);
  assert.deepEqual((await read(utc)).summary,first.summary);

  await fixture('append-day');
  const stale=await read(utc);assert.equal(stale.stale,true);assert.equal(stale.coverage.humanCount,3);assert.deepEqual(stale.summary,first.summary);
  assert.equal((await fixture('status')).calls,before+2,'appending a message may mark a summary stale but must not regenerate it');
  await fixture('fail',{value:true});
  const failed=await settled(utc,(await start(utc)).id);
  assert.equal(failed.run.status,'failed');assert.equal(failed.stale,true);assert.deepEqual(failed.summary,first.summary);
  assert.ok(failed.run.error);assert.ok(failed.run.diagnostic.stage);assert.equal(failed.run.diagnostic.modelCalls,1);assert.deepEqual(failed.run.diagnostic.pluginBuild,pluginBuild);
  await fixture('fail',{value:false});
  const updated=await settled(utc,(await start(utc)).id);
  assert.equal(updated.run.status,'completed',JSON.stringify(updated.run));assert.equal(updated.stale,false);
  assert.equal(updated.summary.humanCount,3);assert.notEqual(updated.summary.sourceFingerprint,first.summary.sourceFingerprint);
  assert.deepEqual(requestHumans((await fixture('status')).dayInputs.at(-1)),[['journal-day-a',['午夜后：补充上下文。','追加反馈：验证失败，先暂停。']],['journal-day-b',['接口检查仍未完成。']]]);

  await verifyScheduleAcrossRestart(runtime);
  const cold=await read(utc),coldArchived=await read(allShanghai);
  assert.deepEqual(cold.summary,updated.summary);assert.equal(cold.stale,false);
  assert.deepEqual(coldArchived.summary,all.summary);assert.equal(coldArchived.stale,true);
  assert.equal((await fixture('status')).calls,0,'restoring saved date summaries must not invoke the model');
}

const runtime=await createRuntime();
try{
  await runtime.start();
  const catalogue=await runtime.api('catalog');const groups=catalogue.workspaces.filter(w=>w.sessions.length);
  assert.equal(catalogue.pluginBuild.version,runtime.pluginVersion);assert.match(catalogue.pluginBuild.id,/^[a-f0-9]{12}$/);
  assert.equal(groups.length,2);assert.equal(groups[0].title,groups[1].title);assert.notEqual(groups[0].id,groups[1].id);
  assert.deepEqual(groups.flatMap(w=>w.sessions.map(s=>s.id)).sort(),['journal-test-a','journal-test-b']);
  assert.equal((await runtime.api('status',{},'journal-test')).calls,0);
  const initialDays=await runtime.api('days',{timeZone:'UTC'});
  assert.equal(initialDays.timeZone,'UTC');assert.equal(initialDays.totals.humanCount,3);assert.equal(initialDays.totals.sessionCount,2);assert.deepEqual(initialDays.errors,[]);
  const initialInteractions=await runtime.api('interactions',{id:'journal-test-a'});
  assert.equal(initialInteractions.items.length,2);assert.match(initialInteractions.revision,/^[a-f0-9]{64}$/);
  assert.deepEqual(initialInteractions.items.map(item=>item.human.text),['流量购买的 H5 跳转方式应该收敛。','不是只改安卓，鸿蒙也要统一；先比较缺失的 API。']);
  const firstInteraction=initialInteractions.items[0],secondInteraction=initialInteractions.items[1];
  for(const human of initialInteractions.items.map(i=>i.human)){
    const day=new Date(human.time).toISOString().slice(0,10);
    assert.ok(initialDays.days.find(d=>d.date===day)?.sessions.some(s=>s.id==='journal-test-a'),'day attribution uses each actual human event time, not session creation');
  }
  assert.ok(initialInteractions.items.every(i=>i.analysis===null));
  const contextArgs={id:'journal-test-a',interactionId:secondInteraction.id,revision:initialInteractions.revision};
  const initialBefore=await runtime.api('interactionContext',{...contextArgs,side:'before',limit:100});
  assert.deepEqual(initialBefore.highlight,[secondInteraction.human.seq]);assert.equal(initialBefore.entries.at(-1).seq,secondInteraction.human.seq);
  assert.ok(initialBefore.entries.every(e=>e.seq<=secondInteraction.human.seq));
  assert.ok(initialBefore.entries.some(e=>e.role==='context'));assert.ok(initialBefore.entries.some(e=>e.text.includes('TAIL_EVIDENCE')));
  assert.ok(!initialBefore.entries.some(e=>e.text.includes('FUTURE_RESULT_AFTER_INTERVENTION')));
  const pendingCall=initialBefore.entries.find(e=>e.type==='tool/call'&&e.source.data.callId==='call-future');
  assert.ok(pendingCall);assert.equal(pendingCall.provenance?.resultSeqs,undefined,'later results must not leak into before provenance');
  const seenBefore=[];let pageOffset=0;
  for(;;){
    const page=await runtime.api('interactionContext',{...contextArgs,side:'before',limit:2,offset:pageOffset});
    assert.equal(page.revision,initialInteractions.revision);assert.equal(page.total,initialBefore.total);assert.ok(page.entries.length<=2);
    assert.deepEqual(page.entries.map(e=>e.seq),page.entries.map(e=>e.seq).toSorted((a,b)=>a-b));seenBefore.push(...page.entries);
    if(page.cursorNext===null)break;assert.ok(page.cursorNext>pageOffset);pageOffset=page.cursorNext;
  }
  assert.deepEqual(seenBefore.toSorted((a,b)=>a.seq-b.seq),initialBefore.entries,'pagination must preserve every source record without duplicates');
  const initialAfter=await runtime.api('interactionContext',{...contextArgs,side:'after',limit:100});
  assert.equal(initialAfter.entries[0].seq,secondInteraction.human.seq);assert.ok(initialAfter.entries.every(e=>e.seq>=secondInteraction.human.seq));
  assert.ok(initialAfter.entries.some(e=>e.text.includes('FUTURE_RESULT_AFTER_INTERVENTION')));
  const firstBefore=await runtime.api('interactionContext',{id:'journal-test-a',interactionId:firstInteraction.id,revision:initialInteractions.revision,side:'before'});
  assert.deepEqual(firstBefore.entries.map(e=>e.seq),[firstInteraction.human.seq]);
  assert.equal((await runtime.api('status',{},'journal-test')).calls,0,'interaction index and original context reads must not call the model');
  await runtime.api('hold',{value:true},'journal-test');
  await runtime.api('analyzeInteractions',{id:'journal-test-a'});
  assert.equal((await runtime.api('interactions',{id:'journal-test-a'})).analysisRun.status,'running');
  await runtime.api('hold',{value:false},'journal-test');
  const analyzedRun=(await runtime.settled('journal-test-a')).run;
  assert.equal(analyzedRun.mode,'interactions');assert.equal(analyzedRun.status,'completed',JSON.stringify(analyzedRun));assert.equal(analyzedRun.completed,2);assert.equal(analyzedRun.modelCalls,2);
  const classified=await runtime.api('interactions',{id:'journal-test-a'}),classification=classified.items[1].analysis;
  assert.equal(classified.items[0].analysis.result.categories[0].label,'新任务');
  assert.equal(classification.result.categories[0].label,'方向纠正');assert.equal(classification.stale,false);
  assert.equal(classification.result.contribution.evidence[0].seq,secondInteraction.human.seq);
  assert.equal(classification.result.contribution.evidence[0].quote,secondInteraction.human.text);
  const frozenEvidence=await runtime.api('interactionEvidence',{id:'journal-test-a',resultId:classification.resultId});
  assert.ok(frozenEvidence.entries.some(e=>e.seq===secondInteraction.human.seq));assert.ok(frozenEvidence.entries.every(e=>e.seq<=secondInteraction.human.seq));
  assert.ok(!JSON.stringify(frozenEvidence).includes('FUTURE_RESULT_AFTER_INTERVENTION'));
  assert.equal(frozenEvidence.entries.find(e=>e.seq===pendingCall.seq).provenance?.resultSeqs,undefined);
  for(const read of frozenEvidence.readEvidence){const original=frozenEvidence.entries.find(e=>e.seq===read.seq);assert.ok(original);assert.equal(read.text,original.text.slice(read.offset,read.offset+read.text.length));assert.equal(read.totalChars,original.text.length);}
  assert.ok(frozenEvidence.coverage.readChars<=24000);
  await runtime.api('malformed',{value:1},'journal-test');
  await runtime.api('missing-envelope',{value:1},'journal-test');
  await runtime.api('hold',{value:true},'journal-test');
  await runtime.api('parse',{id:'journal-test-a'});
  assert.equal((await runtime.api('detail',{id:'journal-test-a'})).run.status,'running');
  await runtime.api('hold',{value:false},'journal-test');
  let detail=await runtime.settled('journal-test-a');
  assert.equal(detail.run.status,'completed',JSON.stringify(detail.run));assert.equal(detail.report.nodes.filter(n=>n.role==='user').length,2);assert.equal(detail.report.nodes.length,4);
  assert.equal((await runtime.api('status',{},'journal-test')).seenTail,true);
  assert.equal((await runtime.api('status',{},'journal-test')).repairs,1);
  assert.equal((await runtime.api('status',{},'journal-test')).envelopesEmitted,1);
  const snapshotId=detail.report.snapshotId;
  await runtime.api('malformed',{value:3},'journal-test');
  await runtime.api('parse',{id:'journal-test-a'});detail=await runtime.settled('journal-test-a');
  assert.equal(detail.run.status,'failed');assert.equal(detail.run.diagnostic.code,'MODEL_OUTPUT_INVALID');
  assert.equal(detail.run.diagnostic.attempts,3);assert.ok(detail.run.diagnostic.modelCalls>=3);
  assert.deepEqual(detail.run.diagnostic.pluginBuild,catalogue.pluginBuild);
  assert.match(detail.run.stage,/整理片段/);assert.equal(detail.run.diagnostic.issues[0].code,'SUMMARY_LENGTH');
  assert.equal(detail.report.snapshotId,snapshotId);
  const context=await runtime.api('context',{id:'journal-test-a',snapshotId,nodeId:'n2'});assert.ok(context.entries.some(e=>e.text.includes('TAIL_EVIDENCE')));assert.ok(context.entries.some(e=>e.role==='context'));
  await runtime.api('append',{},'journal-test');assert.equal((await runtime.api('detail',{id:'journal-test-a'})).report.stale,true);
  const staleContext=await fetch(`${runtime.base}/api/dsh-collab-journal`,{method:'POST',headers:{cookie:runtime.cookie,origin:runtime.base,'content-type':'application/json'},body:JSON.stringify({action:'interactionContext',...contextArgs,side:'before'})});
  assert.equal(staleContext.status,409);assert.equal((await staleContext.json()).ok,false);
  const appendedInteractions=await runtime.api('interactions',{id:'journal-test-a'});assert.equal(appendedInteractions.items.length,3);assert.notEqual(appendedInteractions.revision,initialInteractions.revision);
  assert.deepEqual(appendedInteractions.items.slice(0,2).map(item=>item.id),initialInteractions.items.map(item=>item.id));
  const appendedBefore=await runtime.api('interactionContext',{...contextArgs,revision:appendedInteractions.revision,side:'before',limit:100});
  assert.deepEqual(appendedBefore.entries,initialBefore.entries,'append must not rewrite the original before evidence');
  assert.equal(appendedInteractions.items[1].basisHash,classified.items[1].basisHash);assert.equal(appendedInteractions.items[1].analysis.stale,false);assert.equal(appendedInteractions.items[1].analysis.resultId,classification.resultId);assert.equal(appendedInteractions.items[2].analysis,null);
  const callsBeforeSkip=(await runtime.api('status',{},'journal-test')).calls;
  await runtime.api('analyzeInteractions',{id:'journal-test-a',interactionId:secondInteraction.id});
  const skipped=(await runtime.settled('journal-test-a')).run;assert.equal(skipped.status,'completed');assert.equal(skipped.total,0);assert.equal(skipped.modelCalls,0);
  assert.equal((await runtime.api('status',{},'journal-test')).calls,callsBeforeSkip);
  await runtime.api('fail',{value:true},'journal-test');
  await runtime.api('analyzeInteractions',{id:'journal-test-a',interactionId:secondInteraction.id,force:true});
  const failedAnalysis=(await runtime.settled('journal-test-a')).run;assert.equal(failedAnalysis.status,'failed');assert.equal(failedAnalysis.errors[0].interactionId,secondInteraction.id);
  assert.equal((await runtime.api('interactions',{id:'journal-test-a'})).items[1].analysis.resultId,classification.resultId);
  assert.deepEqual(await runtime.api('interactionEvidence',{id:'journal-test-a',resultId:classification.resultId}),frozenEvidence);
  await runtime.api('fail',{value:true},'journal-test');await runtime.api('parse',{id:'journal-test-a'});detail=await runtime.settled('journal-test-a');
  assert.equal(detail.run.status,'failed');assert.equal(detail.report.snapshotId,snapshotId);
  const unauth=await fetch(`${runtime.base}/api/dsh-collab-journal`,{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"catalog"}'});assert.ok([401,403].includes(unauth.status));
  await runtime.stop();await runtime.start();
  assert.equal((await runtime.api('status',{},'journal-test')).live,false,'reads must support cold persisted sessions');
  const coldInteractions=await runtime.api('interactions',{id:'journal-test-a'});assert.deepEqual(coldInteractions,appendedInteractions);
  const coldBefore=await runtime.api('interactionContext',{...contextArgs,revision:coldInteractions.revision,side:'before',limit:100});assert.deepEqual(coldBefore,appendedBefore);
  assert.equal(coldInteractions.items[1].analysis.resultId,classification.resultId);assert.equal(coldInteractions.items[1].analysis.result.categories[0].label,'方向纠正');
  assert.deepEqual(await runtime.api('interactionEvidence',{id:'journal-test-a',resultId:classification.resultId}),frozenEvidence);
  const coldDays=await runtime.api('days',{timeZone:'UTC'});assert.deepEqual(coldDays.errors,[]);assert.equal(coldDays.totals.humanCount,4);
  assert.equal((await runtime.api('status',{},'journal-test')).calls,0,'cold interaction reads must not call the model');
  detail=await runtime.api('detail',{id:'journal-test-a'});assert.equal(detail.report.snapshotId,snapshotId);assert.equal(detail.report.stale,true);
  await runtime.api('parse',{id:'journal-test-a'});detail=await runtime.settled('journal-test-a');assert.equal(detail.run.status,'completed');assert.equal(detail.report.nodes.filter(n=>n.role==='user').length,3);
  assert.equal((await runtime.api('context',{id:'journal-test-a',snapshotId,nodeId:'n1'})).snapshotId,snapshotId);
  await runtime.api('fail-after',{value:1},'journal-test');
  await runtime.api('parse',{id:'journal-test-a'});
  const checkpointDeadline=Date.now()+10000;
  do {detail=await runtime.api('detail',{id:'journal-test-a'});if(detail.checkpoint?.completedCalls===1)break;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<checkpointDeadline);
  assert.equal(detail.checkpoint?.completedCalls,1,'first batch must be durable before concurrent requests fail');
  await runtime.api('release-failure',{},'journal-test');detail=await runtime.settled('journal-test-a');
  assert.equal(detail.run.status,'failed');assert.equal(detail.checkpoint.completedCalls,1);
  const published=detail.report;
  await runtime.stop();await runtime.start();
  detail=await runtime.api('detail',{id:'journal-test-a'});assert.equal(detail.checkpoint.completedCalls,1);assert.deepEqual(detail.report,published);
  await runtime.api('parse',{id:'journal-test-a'});detail=await runtime.settled('journal-test-a');
  assert.equal(detail.run.status,'completed');assert.equal(detail.run.reusedCalls,1);assert.equal(detail.run.modelCalls,detail.plan.totalCalls-1);assert.equal(detail.checkpoint,null);
  await runtime.api('seed-list',{},'journal-test');
  const ungrouped=(await runtime.api('catalog')).workspaces.find(w=>w.id==='__ungrouped__');
  assert.equal(ungrouped.sessions.length,12);assert.equal(ungrouped.sessions.filter(s=>s.archived).length,7);
  const hiddenDays=await runtime.api('days',{timeZone:'UTC'}),allDays=await runtime.api('days',{timeZone:'UTC',includeArchived:true});
  assert.deepEqual(hiddenDays.totals,{sessionCount:7,humanCount:9,archivedSessionCount:7,hiddenArchivedSessionCount:7});
  assert.deepEqual(allDays.totals,{sessionCount:14,humanCount:16,archivedSessionCount:7,hiddenArchivedSessionCount:0});
  await verifyDaySummaries(runtime,catalogue.pluginBuild);
  console.log(`DSH ${runtime.runtimeVersion}: native workspace/session/LLM/storage, dates from human event times, model-free browsing, scoped day summary generation/refresh/persistence, schedule validation and restoration without early model calls, intervention result schema and frozen citations, append reuse, failed rerun preservation, cold restart, before/after pagination, stale revisions, full trajectory regression and authentication passed (deterministic adapter, not semantic model acceptance).`);
}catch(error){console.error(runtime.log);throw error;}finally{await runtime.stop();}
