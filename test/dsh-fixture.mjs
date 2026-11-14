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
  let fail=false,calls=0,seenTail=false,malformed=0,repairs=0,missingEnvelope=0,envelopesEmitted=0;
  let held=null,release,failAfter=0,failGate,releaseFailure,malformedTarget;
  class Adapter extends LlmAdapter {
    async *stream(options){
      if(options.purpose!=='collab-journal')throw Error('unexpected purpose');
      if(options.tools?.length)throw Error('journal must not request tools');
      const callNumber=++calls;if(held)await held;
      if(fail)throw Error('fixture model failure');
      if(failAfter&&callNumber>failAfter){
        let abort;
        try{await Promise.race([failGate,new Promise((resolve,reject)=>{abort=()=>reject(options.signal.reason);if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});})]);}
        finally{options.signal.removeEventListener('abort',abort);}
        throw Error('fixture model failure');
      }
      const text=options.messages[0].content[0].text;
      const {items,anchor,evidence,correction}=JSON.parse(text);
      if(correction)repairs++;
      if(anchor){
        // This branch verifies native model/storage/citation wiring only. It
        // deliberately labels known synthetic fixtures, not real conversations.
        const correcting=anchor.text.startsWith('不是只改安卓'),quote={seq:anchor.seq,quote:anchor.text.slice(0,1000)};
        const preceding=evidence.findLast(e=>e.type==='assistant/message'&&!e.provenance?.replaces);
        const output={title:correcting?'纠正统一范围并安排接口对比':'提出新的任务目标',
          categories:[{label:correcting?'方向纠正':'新任务',evidence:[quote]}],
          before:preceding?{text:'AI 表示需要确认统一范围。',evidence:[{seq:preceding.seq,quote:preceding.text.slice(0,1000)}]}:{text:'前文证据不足，无法确定介入前状态。',evidence:[]},
          contribution:{text:correcting?'明确安卓与鸿蒙都要统一，要求先比较缺失的接口。':'提出接下来的任务目标。',evidence:[quote]},certainty:preceding?'supported':'unclear'};
        yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}};return;
      }
      seenTail ||= text.includes('TAIL_EVIDENCE');
      const batchKey=JSON.stringify(items.map(i=>i.id));
      if(malformed>0&&malformedTarget===undefined)malformedTarget=batchKey;
      if(malformed>0&&batchKey===malformedTarget){
        malformed--;
        yield {type:'text-delta',index:0,text:JSON.stringify({items:items.map(i=>({id:i.id,summary:'长'.repeat(181),details:[]}))})};
        yield {type:'finish',reason:{kind:'stop'}};return;
      }
      const summaries={n1:'提出目标：收敛流量购买的 H5 跳转方式。',n2:'查阅 Android 跳转实现与工具日志，找到三个入口，随后请求确认统一范围。尚未修改代码。',n3:'纠正范围：安卓和鸿蒙都要统一，要求先比较缺失的 API。',n4:'完成两端 API 对比，指出鸿蒙缺少返回结果的桥接。实现与验证尚未开始。',n5:'继续追问测试结果。'};
      let output=JSON.stringify({items:items.map(i=>({id:i.id,summary:summaries[i.nodeId||i.id.split('.')[0]]||'整理会话材料。',details:['测试模型生成，用于验证 DSH 插件链路。']}))});
      if(missingEnvelope>0){missingEnvelope--;envelopesEmitted++;output=output.slice(0,-2);}
      yield {type:'text-delta',index:0,text:output};
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
    addHuman(primary,'自动加载的项目规则，不是人的介入。','skill');addAi(primary,'发现三个跳转入口，需要确认统一的范围。',1,[{type:'tool-call',id:'call-future',name:'read',arguments:'{"file":"FutureComparison.md"}'}]);
    primary.append('tool/call',{turn:1,step:1,callId:'call-future',name:'read',arguments:'{"file":"FutureComparison.md"}'});
    // The human intervenes before this tool returns. Keep the native step open
    // until its advertised tool lifecycle is complete.
    addHuman(primary,'不是只改安卓，鸿蒙也要统一；先比较缺失的 API。');
    primary.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:'call-future',content:[{type:'text',text:'FUTURE_RESULT_AFTER_INTERVENTION：这条旧调用的结果在第二次人的介入之后才返回。'}],isError:false})},{surfaceOp:'append'});
    addAi(primary,'已对比两端 API，鸿蒙尚缺返回结果的桥接。代码还未修改。',1);primary.append('step/end',{turn:1,step:1});primary.append('turn/end',{turn:1,reason:{kind:'completed'}});
    primary.append('session/title',{title:'统一流量购买 H5 跳转',messageSeqs:[],source:{kind:'user'}});
    await persist(primary);await workspaces[0].attachSession(primary.id);
    const b=ctx.sessions.create('journal-test-b',{meta:{cwd:roots[1]}});
    b.append('turn/start',{turn:1});b.append('step/start',{turn:1,step:1});
    addHuman(b,'检查 Android Push API。');addAi(b,'已检查安卓接口。',1);
    b.append('step/end',{turn:1,step:1});b.append('turn/end',{turn:1,reason:{kind:'completed'}});
    b.append('session/title',{title:'检查 Android Push API',messageSeqs:[],source:{kind:'user'}});await persist(b);await workspaces[1].attachSession(b.id);
    const child=ctx.sessions.create('journal-test-child',{meta:{cwd:roots[0],origin:'subagent',parentSession:primary.id}});addHuman(child,'子代理材料');await persist(child);await workspaces[0].attachSession(child.id);
  }
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/journal-test',methods:['POST'],requestBody:'buffered',async fetch(request){
    try {
    const body=await request.json();
    if(body.action==='hold'){
      if(body.value&&!held)held=new Promise(resolve=>{release=resolve;});
      else if(!body.value){release?.();held=null;release=null;}
    }
    if(body.action==='fail')fail=body.value;
    if(body.action==='fail-after'){failAfter=calls+body.value;failGate=new Promise(resolve=>{releaseFailure=resolve;});}
    if(body.action==='release-failure')releaseFailure?.();
    if(body.action==='malformed'){malformed=body.value;malformedTarget=undefined;}
    if(body.action==='missing-envelope')missingEnvelope=body.value;
    if(body.action==='seed-list'){
      for(let i=0;i<12;i++){
        const id=`journal-list-${String(i+1).padStart(2,'0')}`;
        const s=ctx.sessions.create(id,{meta:{createdAt:Date.now()-i*1000}});
        s.append('user/message',createUserMessage({content:[{type:'text',text:`列表测试 ${i+1}`}],source:{kind:'user'}}),{surfaceOp:'append'});
        await persist(s);
        if(i>=5)await ctx.workspaceRegistry.archiveSession(id);
      }
    }
    if(body.action==='append'){
      const event=primary.append('user/message',createUserMessage({content:[{type:'text',text:'今天继续：检查测试结果。'}],source:{kind:'user'}}),{surfaceOp:'append'});
      const writer=await ctx.sessionPersistence.open(primary.id,'write');try{await writer.append([event]);}finally{await writer.close();}
    }
    return Response.json({ready:true,calls,seenTail,repairs,envelopesEmitted,live:!!ctx.sessions.get('journal-test-a')});
    }catch(error){return Response.json({ok:false,error:error.stack},{status:500});}
  }}));
}
