import fs from 'node:fs';
import path from 'node:path';
import { checkDay, today, addDays, dates, monday, bounds } from './time.mjs';
import { prepareBatches, validateEvents, mergeEvents, structured, EVENT_SCHEMA, SUMMARY_SCHEMA, WEEK_SCHEMA, assertShape } from './analysis.mjs';

export class Engine {
  constructor(config,store,adapter){this.config=config;this.store=store;this.adapter=adapter;}
  start(kind,scope,{collect=true}={}){
    checkDay(scope);
    if(scope>today())throw new Error('不能回顾未来日期');
    if(!['daily','weekly'].includes(kind))throw new Error('任务类型无效');
    if(kind==='weekly'&&monday(scope)!==scope)throw new Error('周总结日期必须是周一');
    const release=this.store.lock(), id=this.store.newRun(kind,scope);
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
    let collection={source:'已导入的本地记录',directories:this.store.sessions().map(s=>s.directory)};
    if(collect){this.store.stage(id,'读取 OpenCode 历史');collection=await this.adapter.collect();}
    const cutoff=Date.now(), {batches,stats}=prepareBatches(this.store,day,this.config,cutoff);
    const snapshots=Object.fromEntries([...new Set(batches.map(b=>b.sessionId))].map(id=>[id,this.store.snapshot(id)]));
    const extracted=[];
    for(let i=0;i<batches.length;i++){
      this.store.stage(id,`分析会话片段 ${i+1}/${batches.length}`);
      extracted.push(...await structured(this.adapter,'daily-events',{day,...batches[i]},EVENT_SCHEMA,r=>validateEvents(r,batches[i],day,this.store)));
    }
    const events=mergeEvents(extracted);
    events.forEach(event=>{event.snapshots=Object.fromEntries(event.evidence.map(ref=>[ref.sessionId,snapshots[ref.sessionId]]));});
    let summary={overview:stats.messages?'当天记录未识别出需要单独归纳的协作事件。':'已完成采集：当天没有对话记录。',observations:[],questions:[]};
    if(events.length){
      this.store.stage(id,'汇总当天观察');
      const old=this.store.review(day);
      const notes=(old?[...old.events,...old.retiredEvents]:[]).filter(e=>e.reflection.note||e.reflection.category||e.reflection.follow);
      const eventInput=events.map(({id,title,category,summary,outcome})=>({id,title,category,summary,outcome}));
      // Refuse oversized synthesis rather than dropping incidents from a day.
      if(JSON.stringify({events:eventInput,notes}).length>this.config.maxInputChars*4)throw new Error('当天汇总材料过大，请提高 maxInputChars 或缩小项目范围；未截断事件');
      summary=await structured(this.adapter,'daily-summary',{day,events:eventInput,notes},SUMMARY_SCHEMA);
    }
    const report={day,...summary,complete:day<today(cutoff),cutoff,generatedAt:Date.now(),mode:this.config.demo?'demo':'live',eventCount:events.length,coverage:{...stats,...collection,batches:batches.length,limitations:['二进制附件未解析','未保存或已被源端清理的内容无法恢复','子代理会话保留原文，但不单独视为人的协作事件',...(stats.segments?['长消息已分段分析，完整原文仍可查看']:[])]}};
    this.store.saveReview(report,events,()=>this.writeDaily(day));
    return this.store.review(day);
  }
  async weekly(start,id){
    const end=addDays(start,6);
    const required=dates(start,end).filter(d=>d>=this.config.startDate&&d<today());
    const reviews=required.map(d=>this.store.review(d)).filter(r=>r?.complete);
    if(!reviews.length)throw new Error('尚无完整日报，先生成日报再做周总结');
    const missing=required.filter(d=>!reviews.some(r=>r.day===d));
    const inputs=reviews.map(r=>({day:r.day,overview:r.overview,events:[...r.events,...r.retiredEvents].map(e=>({id:e.id,title:e.title,category:e.reflection.category||e.category,summary:e.summary,reflection:e.reflection}))}));
    if(JSON.stringify(inputs).length>this.config.maxInputChars*6)throw new Error('周总结材料过大，请提高 maxInputChars；未截断数据');
    this.store.stage(id,'比较跨日事件与个人批注');
    const known=new Map(inputs.flatMap(r=>r.events.map(e=>[e.id,r.day])));
    const result=await structured(this.adapter,'weekly',{start,end,missing,reviews:inputs},WEEK_SCHEMA,value=>{
      assertShape(value,WEEK_SCHEMA);
      for(const p of value.patterns){if(!p.eventIds.length||p.eventIds.some(id=>!known.has(id)))throw new Error('周模式引用了不存在的事件');if(new Set(p.eventIds.map(id=>known.get(id))).size<2)throw new Error('周模式至少需要来自两天的证据');}
      return value;
    });
    const week={start,end,...result,missing,covered:reviews.map(r=>r.day),complete:missing.length===0&&end<today(),mode:this.config.demo?'demo':'live',generatedAt:Date.now()};
    this.store.saveWeek(week);
    const out=path.join(this.config.dataDir,'weekly');fs.mkdirSync(out,{recursive:true});
    fs.writeFileSync(path.join(out,`${start}.md`),`# ${start} — ${end} 协作观察\n\n${week.overview}\n\n${week.patterns.map(p=>`## ${p.title}\n\n${p.observation}\n\n事件：${p.eventIds.join(', ')}`).join('\n\n')}\n\n缺失日期：${missing.join(', ')||'无'}\n`);
    return week;
  }
  writeDaily(day){
    const r=this.store.review(day),out=path.join(this.config.dataDir,'daily');fs.mkdirSync(out,{recursive:true});
    const text=`# ${day} 协作观察${r.mode==='demo'?'（演示数据）':''}\n\n${r.complete?'完整日记':'当天暂稿'} · 采集截至 ${new Date(r.cutoff).toISOString()}\n\n${r.overview}\n\n${r.events.map(e=>`## ${e.title}\n\n分类：${e.reflection.category||e.category}\n\n${e.summary}\n\n介入：${e.intervention}\n\n结果：${e.outcome}\n\n证据：${e.evidence.map(ref=>`${ref.sessionId} / ${ref.messageIds.join(', ')}`).join('; ')}\n\n我的思考：${e.reflection.note||'（未填写）'}`).join('\n\n')}\n\n## 继续观察\n\n${r.questions.join('\n\n')||'暂未形成待观察问题。'}\n\n覆盖：${r.coverage.sessions} 个会话，${r.coverage.messages} 条当天消息。\n`;
    const file=path.join(out,`${day}.md`),tmp=file+'.tmp';fs.writeFileSync(tmp,text);fs.renameSync(tmp,file);
  }
  async due(){
    const last=addDays(today(),-1), results=[];
    for(const day of dates(this.config.startDate,last))if(!this.store.review(day)?.complete)results.push(await this.start('daily',day).done);
    for(let week=monday(this.config.startDate);addDays(week,6)<=last;week=addDays(week,7))if(!this.store.weeks().some(w=>w.start===week&&w.complete))results.push(await this.start('weekly',week).done);
    return results;
  }
}
