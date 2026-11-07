import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeExport } from './opencode.mjs';
import { today, monday } from './time.mjs';
import { checkDay, bounds } from './time.mjs';
import { matchesProject } from './config.mjs';

const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){
  if(!String(req.headers['content-type']||'').startsWith('application/json'))throw new Error('需要 application/json');
  const buffers=[];let count=0;
  for await(const part of req){count+=part.length;if(count>64*1024*1024)throw new Error('请求超过 64 MB');buffers.push(part);}
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}
export function contextFor(store,eventId,{sessionId,before=8,after=8,full=false,weekId}={}){
  const event=weekId?store.weekEvent(weekId,eventId):store.event(eventId);if(!event)throw new Error('事件不存在');
  const ids=event.evidence.map(e=>e.sessionId);
  sessionId=sessionId||event.anchor.sessionId;
  if(!ids.includes(sessionId))throw new Error('会话不属于此事件');
  const all=event.snapshots?.[sessionId]?store.snapshotMessages(event.snapshots[sessionId]):store.messages(sessionId),ref=event.evidence.find(e=>e.sessionId===sessionId);
  if(!all)throw new Error('该次分析的原文快照缺失');
  const anchor=all.findIndex(m=>m.id===(sessionId===event.anchor.sessionId?event.anchor.messageId:ref.messageIds[0]));
  if(anchor<0)throw new Error('原文锚点缺失，不能用模型生成的文字代替');
  before=Math.max(0,Math.min(10000,Number(before)||0));after=Math.max(0,Math.min(10000,Number(after)||0));
  const start=full?0:Math.max(0,anchor-before),end=full?all.length:Math.min(all.length,anchor+after+1);
  return {sessionId,sessions:ids,anchor:event.anchor,highlight:ref.messageIds,total:all.length,start,end,messages:all.slice(start,end),title:store.sessions().find(s=>s.id===sessionId)?.title||sessionId};
}
export function createServer(config,store,engine){
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'self'");
    try{
      const host=req.headers.host||'';
      if(!config.demo&&!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))return json(res,403,{error:'仅允许本机访问'});
      if(req.headers.origin&&new URL(req.headers.origin).host!==host)return json(res,403,{error:'拒绝跨来源请求'});
      if(req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'拒绝跨站请求'});
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,{demo:config.demo,today:today(),timeZone:'Asia/Shanghai',startDate:config.startDate,projects:config.projects,dataDir:config.dataDir,opencodeCommand:config.opencodeCommand,model:config.model||'OpenCode 默认模型',schedule:'Windows 任务计划程序 · 凌晨 02:00（需本机安装）'});
      if(req.method==='GET'&&url.pathname==='/api/reviews')return json(res,200,store.listReviews());
      if(req.method==='GET'&&url.pathname.startsWith('/api/reviews/')){const r=store.review(url.pathname.split('/').at(-1));return json(res,r?200:404,r||{error:'这一天尚未生成日记'});}
      if(req.method==='GET'&&url.pathname==='/api/weeks')return json(res,200,store.weeks());
      if(req.method==='GET'&&url.pathname==='/api/weeks/history')return json(res,200,store.weekHistory(checkDay(url.searchParams.get('start'))));
      const weekEvent=url.pathname.match(/^\/api\/weeks\/([a-f0-9]+)\/events\/([a-f0-9]+)$/);
      if(req.method==='GET'&&weekEvent)return json(res,200,store.weekEvent(weekEvent[1],weekEvent[2]));
      if(req.method==='GET'&&url.pathname==='/api/sessions'){
        const day=checkDay(url.searchParams.get('day')||today()),{start,end}=bounds(day);
        const sessions=store.sessions().filter(s=>!store.isExcluded(s.id)&&!s.parentID&&!s.parentId&&!(s.title||'').startsWith('[collab-review]')&&matchesProject(s.directory,config.projects));
        return json(res,200,sessions.map(s=>({...s,messages:store.messages(s.id).filter(m=>m.createdAt>=start&&m.createdAt<end)})).filter(s=>s.messages.length));
      }
      const source=url.pathname.match(/^\/api\/sessions\/([a-zA-Z0-9_-]+)$/);
      if(req.method==='GET'&&source){
        const s=store.sessions().find(s=>s.id===source[1]);
        if(!s||store.isExcluded(s.id)||(s.title||'').startsWith('[collab-review]')||!matchesProject(s.directory,config.projects))throw new Error('会话不在当前采集范围');
        return json(res,200,{...s,messages:store.messages(s.id)});
      }
      if(req.method==='POST'&&url.pathname==='/api/events')return json(res,201,engine.addManual(await body(req)));
      if(req.method==='GET'&&url.pathname==='/api/runs')return json(res,200,store.runs());
      const eventRoute=url.pathname.match(/^\/api\/events\/([a-f0-9]+)$/);
      if(req.method==='GET'&&eventRoute){const event=store.event(eventRoute[1]);return json(res,event?200:404,event||{error:'事件不存在'});}
      const context=url.pathname.match(/^\/api\/events\/([a-f0-9]+)\/context$/);
      if(req.method==='GET'&&context)return json(res,200,contextFor(store,context[1],{sessionId:url.searchParams.get('sessionId'),before:url.searchParams.get('before')??8,after:url.searchParams.get('after')??8,full:url.searchParams.get('full')==='1',weekId:url.searchParams.get('weekId')}));
      const reflection=url.pathname.match(/^\/api\/events\/([a-f0-9]+)\/reflection$/);
      if(req.method==='PUT'&&reflection){const saved=store.reflect(reflection[1],await body(req));engine.writeDaily(store.event(reflection[1]).day);return json(res,200,{ok:true,reflection:saved,event:store.event(reflection[1])});}
      if(req.method==='POST'&&url.pathname==='/api/runs'){
        const input=await body(req),job=engine.start(input.kind||'daily',input.date||today(),{collect:input.collect!==false});
        return json(res,202,{id:job.id});
      }
      if(req.method==='POST'&&url.pathname==='/api/import'){
        const payload=await body(req),item=normalizeExport(payload);
        if((item.session.title||'').startsWith('[collab-review]'))throw new Error('回顾会话不能导入为分析材料');
        store.upsertSession(item.session,item.messages);return json(res,200,{sessionId:item.session.id,messages:item.messages.length});
      }
      if(req.method==='GET'&&url.pathname.startsWith('/api/export/')){
        const day=url.pathname.split('/').at(-1);if(!store.review(day))return json(res,404,{error:'日记不存在'});engine.writeDaily(day);
        res.writeHead(200,{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="${day}.md"`});return res.end(fs.readFileSync(path.join(config.dataDir,'daily',`${day}.md`)));
      }
      if(req.method==='GET'){
        const files={'/':'index.html','/app.js':'app.js','/editor.js':'editor.js','/style.css':'style.css'};const file=files[url.pathname];
        if(file){const type=file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html';res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});return res.end(fs.readFileSync(path.join(config.root,'public',file)));}
      }
      json(res,404,{error:'未找到此资源'});
    }catch(error){json(res,/正在执行|已在其他页面更新/.test(error.message)?409:400,{error:error.message});}
  });
}
