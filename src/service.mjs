import { randomUUID } from 'node:crypto';
import { analyzeTrajectory, trajectoryPlan, ANALYSIS_VERSION, fingerprint, routeFrom, sourceEntries, contentText } from './trajectory.mjs';
import { modelGenerator } from './model.mjs';
import { OutputValidationError } from './output.mjs';
import { pluginBuild } from './build-info.mjs';
import { indexInteractions } from './interactions.mjs';
import { createProvenanceIndex } from './provenance.mjs';
import { interactionCalendar } from './days.mjs';
import { createInterventionBasis, interventionBasisHash, analyzeIntervention, INTERVENTION_SYSTEM } from './interventions.mjs';
import { DAY_SUMMARY_INPUT_LIMIT,DAY_SUMMARY_SYSTEM,daySummaryKey,daySummaryFingerprint,protectDaySummaryInput,dateInterventionEvidence,summarizeDay } from './day-summary.mjs';

export class JournalError extends Error {constructor(message,status=400){super(message);this.status=status;}}
function calendar(options){try{return interactionCalendar(options);}catch(error){throw new JournalError(error.message);}}
const sessionTitle=(log,id)=>log.events.findLast(e=>e.type==='session/title')?.data.title||contentText(log.events.find(e=>e.type==='user/message'&&e.data.source?.kind==='user')?.data.content).slice(0,80)||id;
function interventionDiagnostic(error,run,stage,modelCalls,startedAt,status){
  return {code:error?.code||error?.name||status.toUpperCase(),status,stage,route:run.route,modelCalls,elapsedMs:Date.now()-startedAt,pluginBuild,
    ...(error instanceof OutputValidationError?{attempts:error.attempts,issues:structuredClone(error.issues)}:{}),
  };
}
export class Journal {
  constructor(ctx,domain){this.ctx=ctx;this.domain=domain;this.runs=new Map();this.active=null;this.dayRuns=new Map();this.dailyActive=null;this.closed=false;}
  async source(id){
    let log;
    try {log=await this.ctx.sessionQuery.readSession(id);}catch{throw new JournalError('DSH 会话读取失败；请刷新或检查原会话',404);}
    if(log.session.origin==='subagent')throw new JournalError('请从主会话查看协作轨迹');
    return {...log,entries:sourceEntries(log.events)};
  }
  async catalog(){
    const workspaces=this.ctx.workspaceRegistry.list().map(w=>({id:w.id,title:w.title,path:w.path,sessionIds:[...w.sessionIds],sessions:[]}));
    const ungrouped={id:'__ungrouped__',title:'未归入 workspace',path:'',sessionIds:[],sessions:[]};
    const archived=new Set(this.ctx.workspaceRegistry.archivedSessionIds);
    const records=(await this.ctx.sessionQuery.listSessions()).filter(r=>r.header.origin!=='subagent');
    // Bounded readers; one corrupt session is visible as an error, never empties the catalogue.
    let cursor=0;
    await Promise.all(Array.from({length:Math.min(4,records.length)},async()=>{
      while(cursor<records.length){
        const {header}=records[cursor++],id=header.id;
        let row={id,title:id,directory:header.cwd||'',lastActivityAt:header.createdAt,archived:archived.has(id),status:'unparsed',humanCount:0};
        try {
          const log=await this.source(id),report=this.domain.table('reports').get(id);
          row={...row,title:log.events.findLast(e=>e.type==='session/title')?.data.title||contentText(log.events.find(e=>e.type==='user/message'&&e.data.source?.kind==='user')?.data.content).slice(0,80)||id,
            lastActivityAt:log.entries.at(-1)?.time||header.createdAt,humanCount:log.entries.filter(e=>e.role==='user').length,
            status:report?(report.snapshotId===fingerprint(log.entries)?'ready':'stale'):'unparsed'};
        } catch(error){row.error=error.message;row.status='error';}
        (workspaces.find(w=>w.sessionIds.includes(id))||ungrouped).sessions.push(row);
      }
    }));
    if(ungrouped.sessions.length)workspaces.push(ungrouped);
    for(const w of workspaces){delete w.sessionIds;w.sessions.sort((a,b)=>b.lastActivityAt-a.lastActivityAt||a.id.localeCompare(b.id));}
    return {workspaces,activeRun:this.active?this.runs.get(this.active.id):null,pluginBuild};
  }
  async detail(id){
    const log=await this.source(id),stored=this.domain.table('reports').get(id);
    const report=stored?{...stored,entries:undefined,stale:stored.snapshotId!==fingerprint(log.entries)}:null;
    const route=routeFrom(log.events),plan=trajectoryPlan(log.entries),saved=this.domain.table('checkpoints').get(id);
    const checkpoint=this.matchesCheckpoint(saved,fingerprint(log.entries),route,stored)&&Object.keys(saved.cache).length?{completedCalls:Object.keys(saved.cache).length,totalCalls:plan.totalCalls,updatedAt:saved.updatedAt}:null;
    return {id,report,route,plan,checkpoint,humanCount:log.entries.filter(e=>e.role==='user').length,run:this.runs.get(id)||null};
  }
  async days({timeZone,includeArchived=false,workspaceId}={}){
    const dates=calendar({timeZone});
    if(typeof includeArchived!=='boolean'||workspaceId!==undefined&&(typeof workspaceId!=='string'||!workspaceId))throw new JournalError('无效的日期筛选');
    const workspaces=this.ctx.workspaceRegistry.list(),archived=new Set(this.ctx.workspaceRegistry.archivedSessionIds);
    const records=(await this.ctx.sessionQuery.listSessions()).filter(({header})=>header.origin!=='subagent').map(({header})=>({id:header.id,workspaceId:workspaces.find(w=>w.sessionIds.includes(header.id))?.id??'__ungrouped__',archived:archived.has(header.id)})).filter(row=>workspaceId===undefined||row.workspaceId===workspaceId);
    const groups=new Map(),errors=[];let cursor=0,unknownTimeCount=0;
    const totals={sessionCount:0,humanCount:0,archivedSessionCount:0,hiddenArchivedSessionCount:0};
    await Promise.all(Array.from({length:Math.min(4,records.length)},async()=>{
      while(cursor<records.length){
        const row=records[cursor++];
        try {
          const log=await this.source(row.id),title=sessionTitle(log,row.id),perDay=new Map(),humans=log.entries.filter(e=>e.role==='user'),visible=includeArchived||!row.archived;
          if(humans.length){
            if(row.archived){totals.archivedSessionCount++;if(!includeArchived)totals.hiddenArchivedSessionCount++;}
            if(visible){totals.sessionCount++;totals.humanCount+=humans.length;}
          }
          for(const human of humans){
            const date=dates.day(human.time);if(date===null){if(visible)unknownTimeCount++;continue;}
            let item=perDay.get(date);if(!item){item={...row,title,humanCount:0,firstHumanAt:human.time,lastHumanAt:human.time};perDay.set(date,item);}
            item.humanCount++;item.firstHumanAt=Math.min(item.firstHumanAt,human.time);item.lastHumanAt=Math.max(item.lastHumanAt,human.time);
          }
          for(const [date,item] of perDay){if(!groups.has(date))groups.set(date,[]);groups.get(date).push(item);}
        }catch(error){errors.push({id:row.id,error:error.message});}
      }
    }));
    const archivedByDate={};
    const days=[...groups].sort(([a],[b])=>b.localeCompare(a)).map(([date,all])=>{
      const sessions=all.filter(row=>includeArchived||!row.archived).sort((a,b)=>b.lastHumanAt-a.lastHumanAt||a.id.localeCompare(b.id)),archivedSessionCount=all.filter(row=>row.archived).length;
      if(archivedSessionCount)archivedByDate[date]=archivedSessionCount;
      return {date,humanCount:sessions.reduce((sum,s)=>sum+s.humanCount,0),sessionCount:sessions.length,archivedSessionCount,hiddenArchivedSessionCount:includeArchived?0:archivedSessionCount,sessions};
    }).filter(day=>day.sessionCount>0);
    return {timeZone:dates.timeZone,days,totals,archivedByDate,unknownTimeCount,errors:errors.sort((a,b)=>a.id.localeCompare(b.id))};
  }
  async interactions(id,options={}){
    const dates=calendar(options);
    const {entries}=await this.source(id);
    const items=indexInteractions(entries).filter(item=>dates.date===undefined||dates.day(item.human.time)===dates.date).map(item=>{
      const basisHash=interventionBasisHash(entries,item.id),stored=this.storedInteraction(id,item.id);
      return {...item,basisHash,analysis:stored?{resultId:stored.resultId,basisHash:stored.basisHash,generatedAt:stored.generatedAt,result:stored.result,stale:stored.basisHash!==basisHash,route:stored.route}:null};
    });
    const run=this.runs.get(id);
    return {id,revision:fingerprint(entries),timeZone:dates.timeZone,items,analysisRun:run?.mode==='interactions'?structuredClone(run):null};
  }
  dayScope({date,timeZone,includeArchived=false}={}){
    const dates=calendar({date,timeZone});
    if(!dates.date||typeof includeArchived!=='boolean')throw new JournalError('请选择有效的日期与归档范围');
    return {date:dates.date,timeZone:dates.timeZone,includeArchived};
  }
  async collectDaySummary(scope,signal){
    const dates=calendar(scope),workspaces=this.ctx.workspaceRegistry.list(),archived=new Set(this.ctx.workspaceRegistry.archivedSessionIds);
    const records=(await this.ctx.sessionQuery.listSessions()).filter(({header})=>header.origin!=='subagent'&&(scope.includeArchived||!archived.has(header.id)));
    const sessions=[],routes=new Map(),errors=[];let cursor=0,unknownTimeCount=0;
    const readers=await Promise.allSettled(Array.from({length:Math.min(4,records.length)},async()=>{
      while(cursor<records.length){
        signal?.throwIfAborted();const id=records[cursor++].header.id;
        try{
          const log=await this.source(id);signal?.throwIfAborted();
          const humans=log.entries.filter(entry=>entry.role==='user');
          unknownTimeCount+=humans.filter(entry=>dates.day(entry.time)===null).length;
          const selected=humans.filter(entry=>dates.day(entry.time)===scope.date);if(!selected.length)continue;
          const workspace=workspaces.find(w=>w.sessionIds.includes(id));
          let sourceTimes;
          const items=selected.map(entry=>{
            const anchorId=`h${entry.seq}`,stored=this.storedInteraction(id,anchorId);
            let analysis;
            if(stored&&stored.basisHash===interventionBasisHash(log.entries,anchorId)){
              sourceTimes??=new Map(log.entries.map(source=>[source.seq,source.time]));
              analysis=dateInterventionEvidence(stored.result,sourceTimes,dates);
            }
            return {id:anchorId,seq:entry.seq,time:entry.time,text:entry.text,...analysis?{analysis}:{}};
          });
          sessions.push({sessionId:id,title:sessionTitle(log,id),workspaceId:workspace?.id??'__ungrouped__',workspaceTitle:workspace?.title??'未归入 workspace',humans:items});
          const route=routeFrom(log.events);if(route)routes.set(id,route);
        }catch(error){if(signal?.aborted)throw error;errors.push({sessionId:id,error:error.message});}
      }
    }));
    const failedReader=readers.find(result=>result.status==='rejected');if(failedReader)throw failedReader.reason;
    sessions.sort((a,b)=>a.humans[0].time-b.humans[0].time||a.sessionId.localeCompare(b.sessionId));
    const input=protectDaySummaryInput({kind:'day-summary',...scope,sessions}),sourceFingerprint=daySummaryFingerprint(input),inputChars=JSON.stringify(input).length;
    const coverage={sessionCount:sessions.length,humanCount:sessions.reduce((count,s)=>count+s.humans.length,0)},sourceSessionId=sessions.find(s=>routes.has(s.sessionId))?.sessionId??null,route=routes.get(sourceSessionId)??null;
    let reason=null;
    if(errors.length)reason=`${errors.length} 段会话读取失败，无法确认当天全部内容；请先修复读取后再生成总结。`;
    else if(unknownTimeCount)reason=`${unknownTimeCount} 次表达缺少有效时间，无法确认当天范围；请先核对原会话。`;
    else if(!coverage.humanCount)reason='这一天没有人的表达。';
    else if(inputChars>DAY_SUMMARY_INPUT_LIMIT)reason=`当日总结输入 ${inputChars} 字符，超过 ${DAY_SUMMARY_INPUT_LIMIT} 字符预算上限；本次未截断或遗漏表达。`;
    else if(!route)reason='当天会话没有可复用的模型；请先在 DSH 选择模型并完成一次对话。';
    const sources=input.sessions.map(s=>({sessionId:s.sessionId,title:s.title,workspaceId:s.workspaceId,workspaceTitle:s.workspaceTitle,humanSeqs:s.humans.map(h=>h.seq)}));
    return {input,sourceFingerprint,inputChars,coverage,route,sourceSessionId,sources,reason,errors,unknownTimeCount};
  }
  async daySummary(options={}){
    const scope=this.dayScope(options),key=daySummaryKey(scope);let current;
    const active=this.dailyActive?.key===key?this.dailyActive:null;
    try{
      current=await (active?.collection??this.collectDaySummary(scope));
      // Poll the immutable job input while running. If the task ended during
      // this read, compare the saved output with the live source one last time.
      if(active&&this.dailyActive!==active)current=await this.collectDaySummary(scope);
    }
    catch{current={sourceFingerprint:null,coverage:null,reason:'当天会话目录读取失败，暂时无法核对完整范围；已有总结仍可阅读。',inputChars:0,route:null,errors:[{sessionId:'',error:'DSH 会话目录读取失败'}],unknownTimeCount:0};}
    // A poll can span model completion. Read the saved result and run in the
    // same synchronous turn so a terminal response always contains its result.
    const stored=this.domain.table('day_summaries').get(key),summary=stored?(({input,...record})=>record)(stored):null;
    current.coverage??={sessionCount:summary?.sessionCount??0,humanCount:summary?.humanCount??0};
    return {scope,summary,stale:!!summary&&(summary.sourceFingerprint!==current.sourceFingerprint||!!current.errors.length||!!current.unknownTimeCount),run:structuredClone(this.dayRuns.get(key)??null),coverage:current.coverage,canGenerate:!current.reason,reason:current.reason,inputChars:current.inputChars,inputLimit:DAY_SUMMARY_INPUT_LIMIT,route:current.route};
  }
  async generateDaySummary(options={}){
    if(this.closed)throw new JournalError('插件正在卸载',503);
    const scope=this.dayScope(options),key=daySummaryKey(scope);
    if(this.dailyActive){if(this.dailyActive.key===key)return structuredClone(this.dayRuns.get(key));throw new JournalError('已有当日总结正在生成，请稍后再试',409);}
    if(this.active)throw new JournalError('已有解析任务正在处理，请稍后再生成当日总结',409);
    const abort=new AbortController(),run={id:randomUUID(),mode:'day-summary',scope,status:'running',stage:'读取当天的人类表达',startedAt:Date.now(),modelCalls:0};
    this.dayRuns.set(key,run);
    const active={key,abort};this.dailyActive=active;
    active.pending=this.executeDaySummary(scope,active,run);
    return structuredClone(run);
  }
  async executeDaySummary(scope,active,run){
    const signal=active.abort.signal;let current,failedInputChars;
    try{
      active.collection=this.collectDaySummary(scope,signal);
      current=await active.collection;signal.throwIfAborted();
      run.route=current.route;
      if(current.reason)throw new JournalError(current.reason);
      const generate=modelGenerator(this.ctx.llm,current.route,current.sourceSessionId,{system:DAY_SUMMARY_SYSTEM});
      const text=await summarizeDay(generate,current.input,signal,{onCall:()=>run.modelCalls++,onStage:stage=>run.stage=stage});
      signal.throwIfAborted();run.stage='保存当日总结';
      await this.domain.table('day_summaries').put(active.key,{...scope,text,generatedAt:Date.now(),route:current.route,sourceSessionId:current.sourceSessionId,sourceFingerprint:current.sourceFingerprint,...current.coverage,sources:current.sources,input:current.input});
      run.status='completed';run.stage='当日总结已保存';
    }catch(error){
      failedInputChars=error.inputChars;
      run.status=signal.aborted?'cancelled':'failed';run.error=error.message;
      run.diagnostic=interventionDiagnostic(error,run,run.stage,run.modelCalls,run.startedAt,run.status);
    }finally{
      run.finishedAt=Date.now();run.diagnostic??=interventionDiagnostic(null,run,run.stage,run.modelCalls,run.startedAt,run.status);
      if(current)Object.assign(run.diagnostic,{inputChars:failedInputChars??current.inputChars,inputLimit:DAY_SUMMARY_INPUT_LIMIT,coverage:current.coverage,sourceErrors:current.errors,unknownTimeCount:current.unknownTimeCount});
      if(this.dailyActive===active)this.dailyActive=null;
    }
  }
  storedInteraction(id,anchorId){
    const latest=this.domain.table('interaction_latest').get(`${id}.${anchorId}`);
    const result=latest?this.domain.table('interaction_versions').get(latest.resultId):null;
    return result?.sessionId===id&&result.interactionId===anchorId?result:null;
  }
  async startInteractions(id,{date,timeZone,interactionId,force=false}={}){
    if(this.closed)throw new JournalError('插件正在卸载',503);
    if(this.dailyActive)throw new JournalError('正在生成当日总结，请稍后再整理交互',409);
    const dates=calendar({date,timeZone});
    if(typeof force!=='boolean'||interactionId!==undefined&&(typeof interactionId!=='string'||!/^h\d+$/.test(interactionId)))throw new JournalError('无效的介入整理范围');
    const scopeKey=JSON.stringify({date:date??null,timeZone:dates.timeZone,interactionId:interactionId??null,force});
    if(this.active){
      if(this.active.id===id&&this.active.mode==='interactions'&&this.active.scopeKey===scopeKey)return structuredClone(this.runs.get(id));
      throw new JournalError('已有解析任务正在处理，请稍后再试',409);
    }
    const abort=new AbortController(),run={id,mode:'interactions',status:'running',stage:'读取介入前原文',startedAt:Date.now(),scopeDate:date??null,total:0,completed:0,modelCalls:0,errors:[]};
    this.runs.set(id,run);
    let ready,failed;const prepared=new Promise((resolve,reject)=>{ready=resolve;failed=reject;});
    const active={id,mode:'interactions',scopeKey,abort};this.active=active;
    active.pending=this.executeInteractions(id,{dates,interactionId,force},abort,run,ready,failed);
    return prepared;
  }
  async executeInteractions(id,{dates,interactionId,force},abort,run,ready,failed){
    let prepared=false;
    try {
      const signal=abort.signal,log=await this.source(id);signal.throwIfAborted();
      let items=indexInteractions(log.entries).filter(item=>dates.date===undefined||dates.day(item.human.time)===dates.date);
      if(interactionId!==undefined){items=items.filter(item=>item.id===interactionId);if(!items.length)throw new JournalError('这条人的表达不在所选范围内',404);}
      const targets=items.filter(item=>force||this.storedInteraction(id,item.id)?.basisHash!==interventionBasisHash(log.entries,item.id));
      run.total=targets.length;
      const route=routeFrom(log.events);if(targets.length&&!route)throw new JournalError('此会话没有可复用的模型；请先在 DSH 中选择模型并完成一次对话');
      if(route)run.route=route;
      prepared=true;ready(structuredClone(run));
      if(targets.length){
        const snapshotId=fingerprint(log.entries),sourceKey=`${id}.${snapshotId}`,sources=this.domain.table('interaction_sources'),stored=sources.get(sourceKey);
        run.stage='保存共享原文快照';
        if(stored){if(stored.sessionId!==id||stored.snapshotId!==snapshotId||fingerprint(stored.entries)!==snapshotId)throw new Error('已保存的介入原文快照不匹配');}
        else await sources.put(sourceKey,{sessionId:id,snapshotId,entries:log.entries});
        signal.throwIfAborted();
        const generate=modelGenerator(this.ctx.llm,route,id,{system:INTERVENTION_SYSTEM});let cursor=0;
        const worker=async()=>{
          while(cursor<targets.length&&!signal.aborted){
            const item=targets[cursor++],startedAt=Date.now();let stage='整理介入',modelCalls=0;
            try {
              const basis=createInterventionBasis(log.entries,item.id);
              const output=await analyzeIntervention(generate,basis,item.id,signal,{onCall:()=>{modelCalls++;run.modelCalls++;},onStage:value=>{stage=value;run.stage=`${item.id} · ${value}`;}});
              signal.throwIfAborted();stage='保存介入与证据';run.stage=`${item.id} · ${stage}`;
              const result={resultId:randomUUID(),sessionId:id,interactionId:item.id,humanSeq:basis.humanSeq,sourceSnapshotId:snapshotId,basisHash:basis.basisHash,analysisVersion:basis.analysisVersion,generatedAt:Date.now(),route,...output};
              await this.domain.table('interaction_versions').put(result.resultId,result);
              signal.throwIfAborted();await this.domain.table('interaction_latest').put(`${id}.${item.id}`,{resultId:result.resultId});
              run.completed++;
            }catch(error){if(!signal.aborted){stage=error.analysisStage||stage;run.errors.push({interactionId:item.id,error:error.message,code:error.code||error.name,stage,diagnostic:interventionDiagnostic(error,run,stage,modelCalls,startedAt,'failed')});}}
          }
        };
        // Each worker owns all of its accepted writes. Neither failure nor
        // cancellation releases the active slot before both workers settle.
        await Promise.all(Array.from({length:Math.min(2,targets.length)},worker));
        signal.throwIfAborted();
      }
      run.status=run.errors.length?'failed':'completed';run.stage=run.errors.length?'部分介入整理失败；已保存其余结果':'介入整理完成';
    }catch(error){
      if(!prepared)failed(error);
      run.status=abort.signal.aborted?'cancelled':'failed';run.error=error.message;
      run.diagnostic=interventionDiagnostic(error,run,run.stage,run.modelCalls,run.startedAt,run.status);
    }finally{
      run.finishedAt=Date.now();
      run.diagnostic??=interventionDiagnostic(null,run,run.stage,run.modelCalls,run.startedAt,run.status);
      this.active=null;
    }
  }
  async interactionEvidence(id,resultId,seq){
    if(typeof resultId!=='string'||!resultId||seq!==undefined&&(!Number.isSafeInteger(seq)||seq<0))throw new JournalError('无效的介入证据标识');
    await this.source(id);
    const result=this.domain.table('interaction_versions').get(resultId);
    if(!result||result.sessionId!==id)throw new JournalError('这份介入整理不存在',404);
    const snapshot=this.domain.table('interaction_sources').get(`${id}.${result.sourceSnapshotId}`);
    if(!snapshot||snapshot.sessionId!==id)throw new JournalError('这份介入的原文快照不存在',404);
    const allowed=new Set([result.humanSeq,...result.readEvidence.map(item=>item.seq)]);
    if(seq!==undefined&&!allowed.has(seq))throw new JournalError('这条来源不在已读取的证据中',404);
    const prefix=snapshot.entries.filter(entry=>entry.seq<=result.humanSeq),provenance=createProvenanceIndex(prefix,{beforeSeq:result.humanSeq<Number.MAX_SAFE_INTEGER?result.humanSeq+1:Infinity});
    const entries=prefix.filter(entry=>allowed.has(entry.seq)&&(seq===undefined||entry.seq===seq)).map(entry=>({...structuredClone(entry),...(provenance.has(entry.seq)?{provenance:structuredClone(provenance.get(entry.seq))}:{})}));
    return {resultId,interactionId:result.interactionId,basisHash:result.basisHash,generatedAt:result.generatedAt,entries,provenance:Object.fromEntries(entries.filter(entry=>entry.provenance).map(entry=>[entry.seq,entry.provenance])),readEvidence:structuredClone(result.readEvidence),coverage:structuredClone(result.coverage)};
  }
  async interactionContext(id,interactionId,revision,side,offset=0,limit=20){
    if(typeof interactionId!=='string'||typeof revision!=='string'||!revision)throw new JournalError('缺少交互或原文版本');
    if(!['before','after'].includes(side)||!Number.isSafeInteger(offset)||offset<0
      ||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new JournalError('无效的原文范围');
    const {entries}=await this.source(id),currentRevision=fingerprint(entries);
    if(currentRevision!==revision)throw new JournalError('会话已更新，请刷新后查看',409);
    const items=indexInteractions(entries),item=items.find(x=>x.id===interactionId);
    if(!item)throw new JournalError('这条人的表达不存在',404);
    const humanIndex=entries.findIndex(e=>e.seq===item.human.seq),selected=item[side];
    const first=side==='before'&&selected.fromSeq!==null?entries.findIndex(e=>e.seq===selected.fromSeq):humanIndex;
    const end=side==='after'&&selected.toSeq!==null?entries.findIndex(e=>e.seq===selected.toSeq)+1:humanIndex+1;
    const total=end-first;
    // Before opens next to the intervention, then pages backwards. Each page
    // remains chronological; after pages forwards from the human expression.
    const pageStart=side==='before'?Math.max(0,total-offset-limit):Math.min(offset,total);
    const pageEnd=side==='before'?Math.max(0,total-offset):Math.min(total,offset+limit);
    const nextHuman=items[items.indexOf(item)+1]?.human.seq;
    const provenance=createProvenanceIndex(entries,{beforeSeq:side==='before'?item.human.seq:nextHuman??Infinity});
    const page=entries.slice(first+pageStart,first+pageEnd).map(entry=>({
      ...structuredClone(entry),...(provenance.has(entry.seq)?{provenance:structuredClone(provenance.get(entry.seq))}:{}),
    }));
    return {revision:currentRevision,highlight:[item.human.seq],entries:page,cursorNext:offset+limit<total?offset+limit:null,total};
  }
  matchesCheckpoint(saved,snapshotId,route,report){return !!saved&&saved.jobId!==report?.jobId&&saved.snapshotId===snapshotId&&saved.analysisVersion===ANALYSIS_VERSION&&saved.route.provider===route?.provider&&saved.route.model===route?.model;}
  async start(id){
    if(this.closed)throw new JournalError('插件正在卸载',503);
    if(this.dailyActive)throw new JournalError('正在生成当日总结，请稍后再解析轨迹',409);
    if(this.active){if(this.active.id===id&&this.active.mode!=='interactions')return this.runs.get(id);throw new JournalError('已有解析任务正在处理，请稍后再试',409);}
    // Claim before the first await; double clicks cannot start competing writes.
    const abort=new AbortController();this.active={id,abort};
    const run={id,status:'running',stage:'读取 DSH 原始会话',startedAt:Date.now(),modelCalls:0};this.runs.set(id,run);
    const pending=this.execute(id,abort,run);
    this.active.pending=pending;
    return {...run};
  }
  async execute(id,abort,run){
    try {
      // Long jobs may run while idle. Each provider call still has its own deadline.
      const signal=abort.signal;
      const log=await this.source(id),route=routeFrom(log.events);
      if(!route)throw new Error('此会话没有可复用的模型；请先在 DSH 中选择模型并完成一次对话');
      run.route=route;
      const snapshotId=fingerprint(log.entries),saved=this.domain.table('checkpoints').get(id);
      const resume=this.matchesCheckpoint(saved,snapshotId,route,this.domain.table('reports').get(id));
      const cache=resume?structuredClone(saved.cache):{},jobId=resume?saved.jobId:randomUUID();
      Object.assign(run,trajectoryPlan(log.entries),{completedCalls:0,reusedCalls:0});
      const generate=modelGenerator(this.ctx.llm,route,id);
      const nodes=await analyzeTrajectory((input,signal)=>{run.modelCalls++;return generate(input,signal);},log.entries,stage=>{run.stage=stage;},signal,{
        cache,
        save:async cache=>{await this.domain.table('checkpoints').put(id,{jobId,sessionId:id,snapshotId,route,analysisVersion:ANALYSIS_VERSION,updatedAt:Date.now(),cache:structuredClone(cache)});},
        onProgress:progress=>Object.assign(run,progress),
      });
      signal.throwIfAborted();
      run.stage='保存轨迹与原文快照';
      const report={jobId,sessionId:id,snapshotId:fingerprint(log.entries),generatedAt:Date.now(),route,nodes,entries:log.entries};
      // Save immutable evidence before publishing the new latest pointer.
      await this.domain.table('versions').put(`${id}.${report.snapshotId}`,report);
      signal.throwIfAborted();await this.domain.table('reports').put(id,report);
      // Publishing the report commits this job. A failed cleanup must neither
      // hide that success nor make the next manual parse reuse a finished job.
      try{await this.domain.table('checkpoints').delete(id);}catch{run.warning='轨迹已保存；进度记录暂未清理，下次重新解析仍会从头开始。';}
      run.status='completed';run.stage='解析完成';
    } catch(error){
      run.status=abort.signal.aborted?'cancelled':'failed';
      run.error=error.name==='TimeoutError'?'解析超时':error.message;
      run.diagnostic={code:error.code||error.name||'PARSE_FAILED',stage:run.stage,route:run.route,modelCalls:run.modelCalls,completedCalls:run.completedCalls,totalCalls:run.totalCalls,reusedCalls:run.reusedCalls,elapsedMs:Date.now()-run.startedAt,pluginBuild};
      if(error instanceof OutputValidationError){
        Object.assign(run.diagnostic,{attempts:error.attempts,issues:error.issues});
        // This error's message and stack contain only our structural diagnostics.
        console.warn('[dsh-collab-journal]',JSON.stringify({...run.diagnostic,stack:error.stack}));
      }
    }
    finally {run.finishedAt=Date.now();this.active=null;}
  }
  async context(id,snapshotId,nodeId){
    await this.source(id);
    const report=this.domain.table('versions').get(`${id}.${snapshotId}`);
    if(!report)throw new JournalError('这份轨迹的原文快照不存在',404);
    const node=report.nodes.find(n=>n.id===nodeId);
    if(!node)throw new JournalError('轨迹节点不存在',404);
    const first=report.entries.findIndex(e=>e.seq===node.seqs[0]),last=report.entries.findIndex(e=>e.seq===node.seqs.at(-1));
    return {snapshotId,highlight:node.seqs,entries:report.entries.slice(Math.max(0,first-1),last+2)};
  }
  cancel(id){if(this.active?.id===id)this.active.abort.abort(new Error('已停止解析'));return {ok:true};}
  async close(){this.closed=true;const active=this.active,daily=this.dailyActive;active?.abort.abort(new Error('插件已卸载'));daily?.abort.abort(new Error('插件已卸载'));await Promise.all([active?.pending,daily?.pending]);await this.domain.close();}
}
