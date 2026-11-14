// Publish one read cycle only after every response has settled. Closing the
// active task disposes its React effect, so it must never abort a sibling read.
export async function pollReader({request,activeRun,id,date,timeZone,signal,publish}) {
  const selected=activeRun.id===id;
  const batch={detail:null,interactions:null,detailError:null,interactionError:null,run:activeRun};
  const [detail,interactions]=await Promise.allSettled([
    request('detail',{id:activeRun.id},signal),
    ...(selected?[request('interactions',{id,timeZone,...date?{date}:{}},signal)]:[]),
  ]);
  if(signal.aborted)return;
  if(detail.status==='fulfilled')batch.detail=detail.value;else batch.detailError=detail.reason;
  if(interactions?.status==='fulfilled')batch.interactions=interactions.value;
  else if(interactions)batch.interactionError=interactions.reason;
  const detailRun=batch.detail?.run,interactionRun=batch.interactions?.analysisRun;
  const latestRun=[activeRun,detailRun,interactionRun].filter(Boolean).reduce((latest,run)=>run.startedAt>=latest.startedAt?run:latest);
  if(selected&&latestRun.mode==='interactions'){
    // These reads are not a transaction. A completed detail can accompany an
    // earlier running list snapshot. Keep polling until the cards themselves
    // contain the terminal result; a transient card-read error also retries.
    if(interactionRun?.startedAt===latestRun.startedAt)batch.run=interactionRun;
    else batch.run={...latestRun,status:'running'};
  }else if(detailRun?.startedAt===latestRun.startedAt)batch.run=detailRun;
  // A restarted host has no live task. Its successful reads still deliver the
  // persisted cards/report; callers can then release the obsolete task banner.
  batch.idle=detail.status==='fulfilled'&&!detailRun&&(!selected||interactions?.status==='fulfilled'&&!interactionRun);
  publish(batch);
}
