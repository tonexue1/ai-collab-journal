import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkDay, today, addDays, dates, monday, bounds } from './time.mjs';
import { prepareBatches, validateEvents, mergeEvents, structured, EVENT_SCHEMA, SUMMARY_SCHEMA, WEEK_SCHEMA, assertShape, sourceFingerprint, continuation } from './analysis.mjs';

export class Engine {
  constructor(config,store,adapter){this.config=config;this.store=store;this.adapter=adapter;}
  start(kind,scope,{collect=true}={}){
    checkDay(scope);
    if(scope>today())throw new Error('不能回顾未来日期');
    if(!['daily','weekly'].includes(kind))throw new Error('任务类型无效');
    if(kind==='weekly'&&monday(scope)!==scope)throw new Error('周总结日期必须是周一');
    return this.execute(kind,scope,collect,this.store.lock());
  }
  execute(kind,scope,collect,release=()=>{}){
    const id=this.store.newRun(kind,scope);
    const done=(async()=>{
      try{
        const result=kind==='daily'?await this.daily(scope,id,collect):await this.weekly(scope,id);
        this.store.finish(id);return result;
      }catch(error){this.store.finish(id,error);throw error}finally{release()}
    })();
    // Attach a rejection handler immediately; HTTP clients poll run status separately.
    done.catch(()=>{});
    return {id,done};
  }
  async daily(day,id,collect){
    let collection=this.collection||{source:'已导入的本地记录',directories:this.store.sessions().map(s=>s.directory)};
    if(collect){this.store.stage(id,'读取 OpenCode 历史');collection=await this.adapter.collect();}
    const cutoff=Date.now(), inputRevision=this.store.dayRevision(day), {batches,stats}=prepareBatches(this.store,day,this.config,cutoff);
    const snapshots=Object.fromEntries([...new Set(batches.map(b=>b.sessionId))].map(id=>[id,this.store.snapshot(id)]));
    let extracted=[];
    for(let i=0;i<batches.length;i++){
      this.store.stage(id,`分析会话片段 ${i+1}/${batches.length}`);
      const batch=continuation(batches[i],extracted,this.store);
      if(!batch.messages.some(m=>m.targetDay&&m.role==='user')&&!batch.previousEvents.length)continue;
      if(JSON.stringify(batch).length>this.config.maxInputChars*4)throw new Error('事件延续材料过大，请提高 maxInputChars；未丢弃已有证据');
      extracted=mergeEvents([...extracted,...await structured(this.adapter,'daily-events',{day,...batch},EVENT_SCHEMA,r=>validateEvents(r,batch,day,this.store))]);
    }
    const events=mergeEvents(extracted);
    events.forEach(event=>{event.snapshots=Object.fromEntries(event.evidence.map(ref=>[ref.sessionId,snapshots[ref.sessionId]]));});
    let summary={overview:stats.messages?'当天记录未识别出需要单独归纳的协作事件。':'已完成采集：当天没有对话记录。',observations:[],questions:[]};
    const effective=this.store.previewEvents(day,events);
    if(effective.length){
      this.store.stage(id,'汇总当天观察');
      const notes=effective.filter(e=>e.reflection.note||e.reflection.category||e.reflection.follow).map(e=>({id:e.id,reflection:e.reflection}));
      const eventInput=effective.map(({id,title,category,summary,intent,intervention,outcome,evidence,needsReview})=>({id,title,category,summary,intent,intervention,outcome,evidence,needsReview}));
      // Refuse oversized synthesis rather than dropping incidents from a day.
      if(JSON.stringify({events:eventInput,notes}).length>this.config.maxInputChars*4)throw new Error('当天汇总材料过大，请提高 maxInputChars 或缩小项目范围；未截断事件');
      summary=await structured(this.adapter,'daily-summary',{day,events:eventInput,notes},SUMMARY_SCHEMA);
    }
    const report={day,...summary,inputRevision,sourceFingerprint:sourceFingerprint(batches),complete:day<today(cutoff),cutoff,generatedAt:Date.now(),mode:this.config.demo?'demo':'live',eventCount:effective.length,coverage:{...stats,...collection,batches:batches.length,limitations:['二进制附件未解析','未保存或已被源端清理的内容无法恢复','子代理会话保留原文，但不单独视为人的协作事件',...(stats.segments?['长消息分片携带已有事件继续分析，完整原文可回查']:[])]}};
    this.store.saveReview(report,events,()=>this.writeDaily(day));
    return this.store.review(day);
  }
  async weekly(start,id){
    const end=addDays(start,6);
    const required=dates(start,end).filter(d=>d>=this.config.startDate&&d<today());
    const reviews=required.map(d=>this.store.review(d)).filter(r=>r?.complete);
    if(!reviews.length)throw new Error('尚无完整日报，先生成日报再做周总结');
    const missing=required.filter(d=>!reviews.some(r=>r.day===d));
    const sourceRevisions=Object.fromEntries(required.map(day=>[day,this.store.dayRevision(day)]));
    const inputs=reviews.map(r=>({day:r.day,overview:r.stale?'概况待更新，以当前有效事件为准':r.overview,events:r.events.map(({id,title,category,summary,intent,intervention,outcome,evidence,reflection,needsReview})=>({id,title,category,summary,intent,intervention,outcome,evidence,reflection,needsReview}))}));
    if(JSON.stringify(inputs).length>this.config.maxInputChars*6)throw new Error('周总结材料过大，请提高 maxInputChars；未截断数据');
    this.store.stage(id,'比较跨日事件与个人批注');
    const known=new Map(inputs.flatMap(r=>r.events.map(e=>[e.id,r.day])));
    const result=await structured(this.adapter,'weekly',{start,end,missing,reviews:inputs},WEEK_SCHEMA,value=>{
      assertShape(value,WEEK_SCHEMA);
      for(const p of value.patterns){if(!p.eventIds.length||p.eventIds.some(id=>!known.has(id)))throw new Error('周模式引用了不存在的事件');if(new Set(p.eventIds.map(id=>known.get(id))).size<2)throw new Error('周模式至少需要来自两天的证据');}
      return value;
    });
    const eventSnapshots=Object.fromEntries(reviews.flatMap(r=>r.events.map(e=>[e.id,e])));
    const week={start,end,...result,sourceRevisions,eventSnapshots,missing,covered:reviews.map(r=>r.day),complete:missing.length===0&&end<today(),mode:this.config.demo?'demo':'live',generatedAt:Date.now()};
    const out=path.join(this.config.dataDir,'weekly');fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,`${start}.md`),`# ${start} — ${end} 协作观察\n\n${week.overview}\n\n${week.patterns.map(p=>`## ${p.title}\n\n${p.observation}\n\n事件：${p.eventIds.join(', ')}`).join('\n\n')}\n\n缺失日期：${missing.join(', ')||'无'}\n`);
    return this.store.saveWeek(week);
  }
  writeDaily(day){
    const r=this.store.review(day),out=path.join(this.config.dataDir,'daily');fs.mkdirSync(out,{recursive:true});
    const text=`# ${day} 协作观察${r.mode==='demo'?'（演示数据）':''}\n\n${r.complete?'完整日记':'当天暂稿'}${r.stale?' · 概况待更新':''} · 采集截至 ${new Date(r.cutoff).toISOString()}\n\n${r.overview}\n\n${r.events.map(e=>`## ${e.title}\n\n分类：${e.category}\n\n${e.summary}\n\n介入：${e.intervention}\n\n结果：${e.outcome}\n\n证据：${e.evidence.map(ref=>`${ref.sessionId} / ${ref.messageIds.join(', ')}`).join('; ')}\n\n我的思考：${e.reflection.note||'（未填写）'}`).join('\n\n')}\n\n## 继续观察\n\n${r.questions.join('\n\n')||'暂未形成待观察问题。'}\n\n覆盖：${r.coverage.sessions} 个会话，${r.coverage.messages} 条当天消息。\n`;
    const file=path.join(out,`${day}.md`),tmp=file+'.tmp';fs.writeFileSync(tmp,text);fs.renameSync(tmp,file);
  }
  async due(){
    const last=addDays(today(),-1), results=[];
    const days=dates(this.config.startDate,last);if(!days.length)return results;
    const release=this.store.lock(), failures=[];
    try{
      const collectionRun=this.store.newRun('collect',last);
      try{this.collection=await this.adapter.collect();this.store.finish(collectionRun);}catch(error){this.store.finish(collectionRun,error);throw error;}
      for(const day of days){
        const review=this.store.review(day),fingerprint=sourceFingerprint(prepareBatches(this.store,day,this.config,Date.now()).batches);
        if(review?.complete&&!review.stale&&review.sourceFingerprint===fingerprint)continue;
        try{results.push(await this.execute('daily',day,false).done);}catch(error){if(error.scope==='global')throw error;failures.push(`${day}: ${error.message}`);}
      }
      for(let week=monday(this.config.startDate);addDays(week,6)<=last;week=addDays(week,7)){
        if(this.store.weeks().some(w=>w.start===week&&w.complete&&!w.stale))continue;
        try{results.push(await this.execute('weekly',week,false).done);}catch(error){if(error.scope==='global')throw error;failures.push(`${week} 周总结: ${error.message}`);}
      }
      if(failures.length)throw new Error(`补跑部分失败：成功 ${results.length} 项；${failures.join('；')}`);
      return results;
    }finally{this.collection=null;release();}
  }
  addManual(input){
    const day=checkDay(input.day);if(day>today())throw new Error('不能补记未来日期');
    const messages=(input.evidence||[]).flatMap(ref=>(ref.messageIds||[]).map(id=>{
      const m=this.store.message(ref.sessionId,id);if(!m)throw new Error('补记引用的消息不存在');
      return {...m,targetDay:today(m.createdAt)===day};
    }));
    const event=validateEvents({events:[{title:input.title,category:input.category||'其他',summary:input.summary,intent:input.intent||'用户补记',intervention:input.intervention||input.summary,outcome:input.outcome||'未知',evidence:input.evidence}]},{messages},day,this.store)[0];
    event.id=randomUUID().replaceAll('-','');event.origin='human';
    event.snapshots=Object.fromEntries(event.evidence.map(ref=>[ref.sessionId,this.store.snapshot(ref.sessionId)]));
    if(!this.store.review(day)){
      const {stats}=prepareBatches(this.store,day,this.config);
      this.store.saveReview({day,complete:false,cutoff:Date.now(),generatedAt:Date.now(),overview:'已补记事件，概况尚未生成。',observations:[],questions:[],coverage:{...stats,limitations:[]},mode:this.config.demo?'demo':'live'},[]);
    }
    const saved=this.store.addManual(event);this.writeDaily(day);return saved;
  }
}
