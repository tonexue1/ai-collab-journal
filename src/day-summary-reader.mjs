// Session navigation can return historical tasks. Only newly observed work
// can invalidate a summary, once its last write has settled.
export function createInteractionChangeObserver() {
  const latestBySession = new Map();
  return (run, fromAction = false) => {
    if (run?.mode !== 'interactions') return false;
    const latest = latestBySession.get(run.id);
    if (latest && run.startedAt < latest.startedAt) return false;
    const sameJob = latest?.startedAt === run.startedAt;
    if (sameJob && latest.settled) return false;
    const settled = run.status !== 'running';
    if (settled && !sameJob && !fromAction) return false;
    latestBySession.set(run.id, { startedAt: run.startedAt, settled });
    return settled && run.completed > 0;
  };
}

function pause(signal){
  return new Promise((resolve,reject)=>{
    if(signal.aborted){reject(signal.reason);return;}
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},1500);
    signal.addEventListener('abort',abort,{once:true});
  });
}
/** Read-only polling: navigating to a date never starts or restarts a model job. */
export async function observeDaySummary({request,scope,signal,publish,onError,initialRunning=false,wait=pause}){
  let running=initialRunning;
  while(!signal.aborted){
    try {
      const value=await request('daySummary',scope,signal);
      if(signal.aborted)return;
      running=value.run?.status==='running';
      publish(value);
    }catch(error){
      if(signal.aborted)return;
      onError(error);
    }
    if(!running||signal.aborted)return;
    try {await wait(signal);}catch(error){if(!signal.aborted)onError(error);return;}
  }
}
