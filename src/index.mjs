import { journalSpec } from './domain.mjs';
import { Journal, JournalError } from './service.mjs';
export const name='dsh-collab-journal';
export const inject=['sessionQuery','workspaceRegistry','storageDomain','llm','connection'];
export async function apply(ctx){
  const domain=await ctx.storageDomain.open(journalSpec),journal=new Journal(ctx,domain);
  ctx.effect(()=>()=>journal.close());
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/dsh-collab-journal',methods:['POST'],requestBody:'buffered',async fetch(request){
    try {
      const text=await request.text();if(text.length>4096)throw new JournalError('请求过大',413);
      let body;try {body=JSON.parse(text);}catch{throw new JournalError('无效 JSON');}
      if(!body||typeof body!=='object')throw new JournalError('无效请求');
      if(body.action!=='catalog'&&(typeof body.id!=='string'||!body.id||body.id.length>200))throw new JournalError('缺少会话标识');
      let value;
      if(body.action==='catalog')value=await journal.catalog();
      else if(body.action==='detail')value=await journal.detail(body.id);
      else if(body.action==='interactions')value=await journal.interactions(body.id);
      else if(body.action==='interactionContext')value=await journal.interactionContext(body.id,body.interactionId,body.revision,body.side,body.offset,body.limit);
      else if(body.action==='parse')value=await journal.start(body.id);
      else if(body.action==='cancel')value=journal.cancel(body.id);
      else if(body.action==='context'){
        if(typeof body.snapshotId!=='string'||typeof body.nodeId!=='string')throw new JournalError('缺少原文版本');
        value=await journal.context(body.id,body.snapshotId,body.nodeId);
      } else throw new JournalError('未知操作');
      return Response.json({ok:true,value},{headers:{'cache-control':'no-store'}});
    }catch(error){return Response.json({ok:false,error:error instanceof JournalError?error.message:'协作观察读取失败，请检查 DSH 日志'},{status:error.status||500,headers:{'cache-control':'no-store'}});}
  }}));
}
