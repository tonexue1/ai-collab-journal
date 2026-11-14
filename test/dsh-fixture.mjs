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
  const dayInputs=[];
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
      const input=JSON.parse(text),{items,anchor,evidence,correction}=input;
      if(correction)repairs++;
      if(['replay-rule','replay-author','replay-code'].includes(input.kind)){
        const rule='局部改动前核对已有阅读顺序，按用户要求保留已认可的布局。';
        const result=input.kind==='replay-rule'?{id:input.options[0].id,reason:'历史上曾再次说明范围。'}:
          input.kind==='replay-author'?{text:rule}:
          {files:input.files.map(file=>({path:file.path,text:input.rules.includes(rule)?'export const route = "candidate";\n':'export const route = "baseline";\n'}))};
        yield {type:'text-delta',index:0,text:JSON.stringify(result)};
        yield {type:'finish',reason:{kind:'stop'}};return;
      }
      if(input.kind==='day-summary'){
        // Capture the real plugin request at its external LLM boundary. These
        // synthetic replies check transport/storage only, not semantic quality.
        dayInputs.push(input);
        const humanCount=input.sessions.reduce((count,session)=>count+session.humans.length,0);
        yield {type:'text-delta',index:0,text:JSON.stringify({items:[{id:'day',summary:`当天包含 ${humanCount} 次人的表达。`,details:['接口检查仍未完成，执行结果尚未确认。']}]})};
        yield {type:'finish',reason:{kind:'stop'}};return;
      }
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
  async function seedDaySessions(){
    const roots=['day-a','day-b'].map(name=>join(process.env.DSH_HOME,'projects',name));
    for(const root of roots)await mkdir(root,{recursive:true});
    const workspaces=await Promise.all(roots.map(root=>ctx.workspaceRegistry.create(root,'当日总结 workspace')));
    const fixtures=[
      {id:'journal-day-a',workspace:0,title:'跨日安排',humans:[['2025-07-01T23:30:00Z','午夜前：先确认目标。'],['2025-07-02T00:30:00Z','午夜后：补充上下文。']]},
      {id:'journal-day-b',workspace:1,title:'接口检查',humans:[['2025-07-02T01:00:00Z','接口检查仍未完成。']]},
      {id:'journal-day-archived',workspace:0,title:'归档事项',archived:true,humans:[['2025-07-02T01:30:00Z','归档事项：这次尝试失败。']]},
    ];
    for(const fixture of fixtures){
      const seed=[],firstTime=Date.parse(fixture.humans[0][0]);
      const add=(type,data,time,surface=false)=>seed.push({type,seq:seed.length,time,data,...surface?{surfaceOp:'append'}:{}});
      add('turn/start',{turn:1},firstTime);add('step/start',{turn:1,step:1},firstTime);
      for(const [iso,text] of fixture.humans){
        const time=Date.parse(iso);
        add('user/message',createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}),time,true);
        add('assistant/message',{turn:1,step:1,stream:[],message:createAssistantMessage({content:[{type:'text',text:'AI 后续计划不是当日人的表达。'}],source:{provider:'journal-fixture',model:'fixture'}})},time+1,true);
      }
      const lastTime=seed.at(-1).time+1;
      add('step/end',{turn:1,step:1},lastTime);add('turn/end',{turn:1,reason:{kind:'completed'}},lastTime);
      add('session/title',{title:fixture.title,messageSeqs:[],source:{kind:'user'}},lastTime);
      // Native replay validates the full history, then native persistence stores
      // it. Keep these sessions cold so neither dates nor restart need clock mocks.
      const session=ctx.sessions.prepare(fixture.id,{seed,meta:{cwd:roots[fixture.workspace],createdAt:Date.parse('2025-06-01T00:00:00Z')}});
      await persist(session);await workspaces[fixture.workspace].attachSession(session.id);
      if(fixture.archived)await ctx.workspaceRegistry.archiveSession(session.id);
    }
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
    if(body.action==='seed-day')await seedDaySessions();
    if(body.action==='append-day'){
      const id='journal-day-a',log=await ctx.sessionQuery.readSession(id);
      const event={type:'user/message',seq:log.events.length,time:Date.parse('2025-07-02T02:00:00Z'),data:createUserMessage({content:[{type:'text',text:'追加反馈：验证失败，先暂停。'}],source:{kind:'user'}}),surfaceOp:'append'};
      ctx.sessions.prepare(id,{seed:[...log.events,event],meta:log.session});
      const writer=await ctx.sessionPersistence.open(id,'write');try{await writer.append([event]);}finally{await writer.close();}
    }
    if(body.action==='append'){
      const event=primary.append('user/message',createUserMessage({content:[{type:'text',text:'今天继续：检查测试结果。'}],source:{kind:'user'}}),{surfaceOp:'append'});
      const writer=await ctx.sessionPersistence.open(primary.id,'write');try{await writer.append([event]);}finally{await writer.close();}
    }
    return Response.json({ready:true,calls,seenTail,repairs,envelopesEmitted,dayInputs,live:!!ctx.sessions.get('journal-test-a')});
    }catch(error){return Response.json({ok:false,error:error.stack},{status:500});}
  }}));
}
