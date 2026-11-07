import { createHash } from 'node:crypto';
import { bounds } from './time.mjs';
import { matchesProject } from './config.mjs';
const string = { type:'string' };
const strings = { type:'array',items:string };
export const EVENT_SCHEMA = { type:'object',required:['events'],properties:{events:{type:'array',items:{type:'object',required:['title','category','summary','intent','intervention','outcome','evidence'],properties:{title:string,category:string,summary:string,intent:string,intervention:string,outcome:string,evidence:{type:'array',items:{type:'object',required:['sessionId','messageIds'],properties:{sessionId:string,messageIds:strings}}}}}}}};
export const SUMMARY_SCHEMA = {type:'object',required:['overview','observations','questions'],properties:{overview:string,observations:strings,questions:{...strings,maxItems:2}}};
export const WEEK_SCHEMA = {type:'object',required:['overview','patterns','questions'],properties:{overview:string,patterns:{type:'array',items:{type:'object',required:['title','observation','eventIds'],properties:{title:string,observation:string,eventIds:strings}}},questions:{...strings,maxItems:2}}};
export function assertShape(value, schema, name = 'output') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`);
    for (const key of schema.required || []) if (!(key in value)) throw new Error(`${name} 缺少 ${key}`);
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) assertShape(value[key], child, `${name}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems || 200)) throw new Error(`${name} 数组无效或超限`);
    value.forEach((item,i)=>assertShape(item,schema.items,`${name}[${i}]`));
  } else if (schema.type === 'string' && (typeof value !== 'string' || value.length > 20000)) throw new Error(`${name} 字符串无效`);
}
export function messageText(message) {
  return message.parts.map(part => {
    if (part.type === 'text') return part.text || '';
    if (part.type === 'tool') return `[工具 ${part.tool || 'unknown'}] ${JSON.stringify(part.state || part)}`;
    if (part.type === 'file') return `[附件 ${part.filename || part.mime || ''}：本轮未解析二进制内容]`;
    if (part.type === 'compaction') return '[会话已压缩，相关旧工具内容可能不再可用]';
    return '';
  }).filter(Boolean).join('\n');
}
export function prepareBatches(store, day, config, cutoff = Infinity) {
  const { start,end } = bounds(day), batches=[], stats={sessions:0,messages:0,userMessages:0,segments:0,attachments:0,childSessions:0};
  for (const session of store.sessions()) {
    if (store.isExcluded(session.id) || (session.title || '').startsWith('[collab-review]')) continue;
    if (!matchesProject(session.directory,config.projects)) continue;
    if (session.parentID || session.parentId) { stats.childSessions++; continue; }
    const messages = store.messages(session.id);
    const inDay = m => m.createdAt >= start && m.createdAt < end && m.createdAt <= cutoff;
    const targets=messages.map((m,i)=>inDay(m)?i:-1).filter(i=>i>=0);
    if (!targets.length) continue;
    stats.sessions++; stats.messages+=targets.length; stats.userMessages+=targets.filter(i=>messages[i].role==='user').length;
    const indexes=new Set(); targets.forEach(i=>{for(let j=Math.max(0,i-4);j<=Math.min(messages.length-1,i+4);j++) if(messages[j].createdAt<=cutoff) indexes.add(j)});
    const items=[];
    for (const i of [...indexes].sort((a,b)=>a-b)) {
      const m=messages[i], text=messageText(m), size=Math.max(1000,Math.floor(config.maxInputChars/4));
      stats.attachments+=m.parts.filter(p=>p.type==='file').length;
      const count=Math.max(1,Math.ceil(text.length/size)); if(count>1)stats.segments+=count;
      for(let part=0;part<count;part++) items.push({sessionId:session.id,id:m.id,role:m.role,createdAt:m.createdAt,targetDay:inDay(m),segment:`${part+1}/${count}`,text:text.slice(part*size,(part+1)*size)});
    }
    let buffer=[], length=0;
    for (const item of items) {
      const bytes=JSON.stringify(item).length;
      if(buffer.length&&length+bytes>config.maxInputChars){batches.push({sessionId:session.id,title:session.title,messages:buffer});buffer=[];length=0;}
      buffer.push(item);length+=bytes;
    }
    if(buffer.length)batches.push({sessionId:session.id,title:session.title,messages:buffer});
  }
  return {batches,stats};
}
export function validateEvents(output, batch, day, store) {
  assertShape(output, EVENT_SCHEMA);
  const allowed=new Map(batch.messages.map(m=>[`${m.sessionId}/${m.id}`,m]));
  return output.events.map(event => {
    if(!event.title.trim()||!event.category.trim()||!event.evidence.length)throw new Error('事件标题、分类或证据为空');
    const refs=[];
    for(const ref of event.evidence){
      if(!ref.messageIds.length)throw new Error('证据消息列表为空');
      for(const id of new Set(ref.messageIds)){
        const m=allowed.get(`${ref.sessionId}/${id}`);
        if(!m||!store.message(ref.sessionId,id))throw new Error('事件引用了输入之外的消息');
        refs.push(m);
      }
    }
    const anchors=refs.filter(m=>m.targetDay&&m.role==='user').sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
    if(!anchors.length)throw new Error('事件必须引用当天真实用户消息，旧背景不能计为当天事件');
    const anchor=anchors[0];
    const id=createHash('sha256').update(`${day}\0${anchor.sessionId}\0${anchor.id}`).digest('hex').slice(0,24);
    return {id,day,title:event.title,category:event.category,summary:event.summary,intent:event.intent,intervention:event.intervention,outcome:event.outcome,evidence:event.evidence,anchor:{sessionId:anchor.sessionId,messageId:anchor.id},createdAt:anchor.createdAt};
  });
}
export async function structured(analyzer, task, data, schema, validate = value => {assertShape(value,schema);return value}) {
  let last;
  for(let attempt=0;attempt<2;attempt++){
    const result=await analyzer.analyze(task,attempt?{...data,validationError:last.message}:data,schema);
    try{return validate(result)}catch(error){last=error}
  }
  throw new Error(`模型输出校验失败：${last.message}`);
}
export function mergeEvents(events) {
  const byId=new Map();
  for(const event of events){
    const prev=byId.get(event.id);
    if(!prev){byId.set(event.id,event);continue}
    const sources=new Map();
    for(const ref of [...prev.evidence,...event.evidence]){if(!sources.has(ref.sessionId))sources.set(ref.sessionId,new Set());ref.messageIds.forEach(id=>sources.get(ref.sessionId).add(id));}
    prev.evidence=[...sources].map(([sessionId,ids])=>({sessionId,messageIds:[...ids]}));
  }
  return [...byId.values()].sort((a,b)=>a.createdAt-b.createdAt);
}
