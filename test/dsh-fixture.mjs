// Loaded only by the integration overlay; excluded from the distributable package.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const require=createRequire(process.env.DSH_TEST_ANCHOR);
const { LlmAdapter,createUserMessage,createAssistantMessage,createToolResultMessage }=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
export const name='journal-integration-fixture';
export const inject=['llm','sessions','sessionPersistence','sessionQuery','workspaceRegistry','connection'];
export async function apply(ctx){
  let fail=false,calls=0,seenTail=false,malformed=0,repairs=0;
  class Adapter extends LlmAdapter {
    async *stream(options){
      if(options.purpose!=='collab-journal')throw Error('unexpected purpose');
      if(options.tools?.length)throw Error('journal must not request tools');
      calls++;if(fail)throw Error('fixture model failure');
      const text=options.messages[0].content[0].text;seenTail ||= text.includes('TAIL_EVIDENCE');
      const {items,correction}=JSON.parse(text);
      if(correction)repairs++;
      if(malformed>0){
        malformed--;
        yield {type:'text-delta',index:0,text:JSON.stringify({items:items.map(i=>({id:i.id,summary:'长'.repeat(181),details:[]}))})};
        yield {type:'finish',reason:{kind:'stop'}};return;
      }
      const summaries={n1:'提出目标：收敛流量购买的 H5 跳转方式。',n2:'查阅 Android 跳转实现与工具日志，找到三个入口，随后请求确认统一范围。尚未修改代码。',n3:'纠正范围：安卓和鸿蒙都要统一，要求先比较缺失的 API。',n4:'完成两端 API 对比，指出鸿蒙缺少返回结果的桥接。实现与验证尚未开始。',n5:'继续追问测试结果。'};
      yield {type:'text-delta',index:0,text:JSON.stringify({items:items.map(i=>({id:i.id,summary:summaries[i.nodeId||i.id.split('.')[0]]||'整理会话材料。',details:['测试模型生成，用于验证 DSH 插件链路。']}))})};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['journal-fixture'],new Adapter());
  const existing=new Set((await ctx.sessionQuery.listSessions()).map(s=>s.header.id));
  async function persist(session){
    const writer=await ctx.sessionPersistence.create(session.header,{inheritedEventCount:session.inheritedEventCount});
    try{await writer.append(session.snapshotEvents());}finally{await writer.close();}
  }
  let primary=ctx.sessions.get('journal-test-a');
  if(!existing.has('journal-test-a')){
    const roots=[join(process.env.DSH_HOME,'projects','harmony'),join(process.env.DSH_HOME,'projects','android')];
    for(const root of roots)await mkdir(root,{recursive:true});
    const workspaces=await Promise.all(roots.map(p=>ctx.workspaceRegistry.create(p,'同名 workspace')));
    function addHuman(s,text,source='user'){s.append('user/message',createUserMessage({content:[{type:'text',text}],source:{kind:source}}),{surfaceOp:'append'});}
    function addAi(s,text,turn,blocks=[]){s.append('assistant/message',{turn,step:1,stream:[],message:createAssistantMessage({content:[{type:'text',text},...blocks],source:{provider:'journal-fixture',model:'fixture'}})},{surfaceOp:'append'});}
    primary=ctx.sessions.create('journal-test-a',{meta:{cwd:roots[0],createdAt:Date.now()-3*86400000}});
    primary.append('turn/start',{turn:1});primary.append('step/start',{turn:1,step:1});
    addHuman(primary,'流量购买的 H5 跳转方式应该收敛。');
    addAi(primary,'我先查看 Android 的跳转实现。',1,[{type:'tool-call',id:'call-a',name:'read',arguments:'{"file":"FlowRouter.kt"}'}]);
    primary.append('tool/call',{turn:1,step:1,callId:'call-a',name:'read',arguments:'{"file":"FlowRouter.kt"}'});
    primary.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:'call-a',content:[{type:'text',text:'调查日志\n'.repeat(1600)+'TAIL_EVIDENCE：路由入口有三处。'}],isError:false})},{surfaceOp:'append'});
    addHuman(primary,'自动加载的项目规则，不是人的介入。','skill');addAi(primary,'发现三个跳转入口，需要确认统一的范围。',1);
    primary.append('step/end',{turn:1,step:1});primary.append('turn/end',{turn:1,reason:{kind:'completed'}});
    primary.append('turn/start',{turn:2});primary.append('step/start',{turn:2,step:1});addHuman(primary,'不是只改安卓，鸿蒙也要统一；先比较缺失的 API。');addAi(primary,'已对比两端 API，鸿蒙尚缺返回结果的桥接。代码还未修改。',2);primary.append('step/end',{turn:2,step:1});primary.append('turn/end',{turn:2,reason:{kind:'completed'}});
    primary.append('session/title',{title:'统一流量购买 H5 跳转',messageSeqs:[],source:{kind:'user'}});
    await persist(primary);await workspaces[0].attachSession(primary.id);
    const b=ctx.sessions.create('journal-test-b',{meta:{cwd:roots[1]}});addHuman(b,'检查 Android Push API。');addAi(b,'已检查安卓接口。',1);b.append('session/title',{title:'检查 Android Push API',messageSeqs:[],source:{kind:'user'}});await persist(b);await workspaces[1].attachSession(b.id);
    const child=ctx.sessions.create('journal-test-child',{meta:{cwd:roots[0],origin:'subagent',parentSession:primary.id}});addHuman(child,'子代理材料');await persist(child);await workspaces[0].attachSession(child.id);
  }
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/journal-test',methods:['POST'],requestBody:'buffered',async fetch(request){
    try {
    const body=await request.json();
    if(body.action==='fail')fail=body.value;
    if(body.action==='malformed')malformed=body.value;
    if(body.action==='append'){
      const event=primary.append('user/message',createUserMessage({content:[{type:'text',text:'今天继续：检查测试结果。'}],source:{kind:'user'}}),{surfaceOp:'append'});
      const writer=await ctx.sessionPersistence.open(primary.id,'write');try{await writer.append([event]);}finally{await writer.close();}
    }
    return Response.json({ready:true,calls,seenTail,repairs,live:!!ctx.sessions.get('journal-test-a')});
    }catch(error){return Response.json({ok:false,error:error.stack},{status:500});}
  }}));
}
