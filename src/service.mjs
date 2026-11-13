import { randomUUID } from 'node:crypto';
import { analyzeTrajectory, trajectoryPlan, ANALYSIS_VERSION, fingerprint, routeFrom, sourceEntries, contentText } from './trajectory.mjs';
import { modelGenerator } from './model.mjs';
import { OutputValidationError } from './output.mjs';
import { pluginBuild } from './build-info.mjs';
import { indexInteractions } from './interactions.mjs';
import { createProvenanceIndex } from './provenance.mjs';

export class JournalError extends Error {constructor(message,status=400){super(message);this.status=status;}}
export class Journal {
  constructor(ctx,domain){this.ctx=ctx;this.domain=domain;this.runs=new Map();this.active=null;this.closed=false;}
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
  async interactions(id){
    const {entries}=await this.source(id);
    return {id,revision:fingerprint(entries),items:indexInteractions(entries)};
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
    if(this.active){if(this.active.id===id)return this.runs.get(id);throw new JournalError('另一个会话正在解析，请稍后再试',409);}
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
  async close(){this.closed=true;const active=this.active;active?.abort.abort(new Error('插件已卸载'));await active?.pending;await this.domain.close();}
}
