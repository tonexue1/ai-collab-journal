import { createHash } from 'node:crypto';
import { messageText, structured } from './analysis.mjs';
import { matchesProject } from './config.mjs';

export const fingerprint = (sessionId, messages) => createHash('sha256').update(sessionId+'\0'+JSON.stringify(messages)).digest('hex');
export const visibleSession = (store, config, s) => s && !store.isExcluded(s.id) && !s.parentID && !s.parentId && !(s.title||'').startsWith('[collab-review]') && matchesProject(s.directory,config.projects);

export function sourceSession(store, config, id) {
  const session=store.sessions().find(s=>s.id===id);
  if(!visibleSession(store,config,session))throw new Error('会话不在当前采集范围');
  return session;
}

// Human boundaries and evidence are fixed by code, never invented by the model.
export function trajectoryNodes(messages) {
  const nodes=[];
  for(const m of messages){
    let node=nodes.at(-1);
    if(m.role==='user'||!node||node.role!==m.role){
      node={id:`n${nodes.length+1}`,role:m.role,startedAt:m.createdAt,endedAt:m.createdAt,messageIds:[],toolCount:0};nodes.push(node);
    }
    node.messageIds.push(m.id);node.endedAt=m.createdAt;
    node.toolCount+=m.parts.filter(p=>p.type==='tool').length;
  }
  return nodes;
}

const schema={type:'object',required:['items'],properties:{items:{type:'array',maxItems:100,items:{type:'object',required:['id','summary','details'],properties:{id:{type:'string'},summary:{type:'string'},details:{type:'array',maxItems:3,items:{type:'string'}}}}}}};
async function summarize(adapter,task,items){
  return structured(adapter,task,{items},schema,output=>{
    if(!output||!Array.isArray(output.items)||output.items.length!==items.length)throw new Error('轨迹摘要必须完整覆盖输入片段');
    const expected=new Set(items.map(i=>i.id)),seen=new Set();
    for(const item of output.items){
      if(!item||!expected.has(item.id)||seen.has(item.id))throw new Error('轨迹摘要包含未知或重复节点');
      if(typeof item.summary!=='string'||!item.summary.trim()||item.summary.length>180||!Array.isArray(item.details)||item.details.length>3||item.details.some(s=>typeof s!=='string'||s.length>240))throw new Error('轨迹摘要过长或格式无效');
      seen.add(item.id);
    }
    return items.map(i=>{const value=output.items.find(v=>v.id===i.id);return {id:i.id,summary:value.summary,details:value.details};});
  });
}
function batches(items,budget){
  const output=[];let batch=[];
  for(const item of items){
    if(batch.length&&(JSON.stringify({items:[...batch,item]}).length>budget||batch.length>=40)){output.push(batch);batch=[];}
    if(JSON.stringify({items:[item]}).length>budget)throw new Error('轨迹片段超过输入上限');
    batch.push(item);
  }
  if(batch.length)output.push(batch);return output;
}
export async function analyzeTrajectory(adapter,messages,budget,onStage=()=>{}){
  const nodes=trajectoryNodes(messages),byId=new Map(messages.map(m=>[m.id,m]));
  if(!nodes.length)throw new Error('会话没有可解析的消息，请先同步会话');
  const fragments=[];
  // Small pieces bound even JSON escape expansion. Every byte of readable source
  // is included; very long logs are summarized in pieces then folded per node.
  const size=Math.max(400,Math.floor(budget/14));
  for(const node of nodes){
    let index=0;
    for(const id of node.messageIds){
      const text=messageText(byId.get(id))||'（这条消息没有可读文本）',count=Math.ceil(text.length/size);
      for(let offset=0;offset<text.length;offset+=size)fragments.push({id:`${node.id}.${++index}`,nodeId:node.id,role:node.role,messageId:id,segment:`${Math.floor(offset/size)+1}/${count}`,text:text.slice(offset,offset+size)});
    }
  }
  const output=new Map(),groups=batches(fragments,budget);
  for(let i=0;i<groups.length;i++){
    onStage(`整理会话片段 ${i+1}/${groups.length}`);
    for(const item of await summarize(adapter,'trajectory',groups[i]))output.set(item.id,item);
  }
  for(const node of nodes){
    let parts=fragments.filter(f=>f.nodeId===node.id).map(f=>output.get(f.id));
    let round=0;
    while(parts.length>1){
      const next=[];
      for(let offset=0;offset<parts.length;offset+=3){
        const group=parts.slice(offset,offset+3);
        if(group.length===1){next.push(group[0]);continue;}
        onStage(`合并${node.role==='user'?'人的表达':'AI 行动'} · ${node.id}`);
        const item={id:`${node.id}.merge${round}.${offset}`,role:node.role,fragments:group};
        if(JSON.stringify({items:[item]}).length>budget)throw new Error('轨迹合并材料超限；已有结果仍保留');
        next.push((await summarize(adapter,'trajectory-merge',[item]))[0]);
      }
      parts=next;round++;
    }
    node.summary=parts[0].summary;node.details=parts[0].details;
  }
  return nodes;
}

export function trajectoryReport(store,config,id){
  sourceSession(store,config,id);
  const report=store.trajectory(id);
  return report?{...report,stale:report.snapshotId!==fingerprint(id,store.messages(id))}:null;
}
export function trajectoryContext(store,config,id,nodeId,snapshotId){
  sourceSession(store,config,id);
  const report=snapshotId?store.trajectoryVersion(id,snapshotId):store.trajectory(id);
  if(!report)throw new Error('轨迹尚未生成');
  const node=report.nodes.find(n=>n.id===nodeId);
  if(!node)throw new Error('轨迹节点不存在');
  const all=store.snapshotMessages(report.snapshotId);
  if(!all)throw new Error('轨迹原文快照缺失');
  const indexes=all.map((m,i)=>node.messageIds.includes(m.id)?i:-1).filter(i=>i>=0);
  const start=Math.max(0,indexes[0]-1),end=Math.min(all.length,indexes.at(-1)+2);
  return {sessionId:id,snapshotId:report.snapshotId,highlight:node.messageIds,start,end,total:all.length,messages:all.slice(start,end)};
}
export function workspaceCatalog(store,config){
  const groups=new Map(),runs=store.runs();
  for(const directory of config.projects)groups.set(directory,{directory,name:directory.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1)||directory,sessions:[]});
  for(const session of store.sessions().filter(s=>visibleSession(store,config,s))){
    const directory=config.projects.find(dir=>matchesProject(session.directory,[dir]))||session.directory||'';
    if(!groups.has(directory))groups.set(directory,{directory,name:directory.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1)||'未标记 workspace',sessions:[]});
    const messages=store.messages(session.id),report=store.trajectory(session.id);
    const run=runs.find(r=>r.kind==='trajectory'&&r.scope===session.id);
    groups.get(directory).sessions.push({id:session.id,title:session.title||session.id,directory,messageCount:messages.length,userCount:messages.filter(m=>m.role==='user').length,
      lastActivityAt:messages.at(-1)?.createdAt||session.time?.updated||0,generatedAt:report?.generatedAt||null,
      status:report?(report.snapshotId===fingerprint(session.id,messages)?'ready':'stale'):'unparsed',nodeCount:report?.nodes.length||0,run:run||null});
  }
  for(const group of groups.values())group.sessions.sort((a,b)=>b.lastActivityAt-a.lastActivityAt||a.id.localeCompare(b.id));
  return {workspaces:[...groups.values()].sort((a,b)=>a.directory.localeCompare(b.directory)),activeRun:runs.find(r=>r.status==='running')||null};
}
