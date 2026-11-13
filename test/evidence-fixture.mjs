// Entirely synthetic history using the installed DSH event structure.
// `facts` describes the source records, never a parser's output contract.
// No fixture copies private messages, paths, identifiers, or credentials.
const epoch=1700000000000;
const messageId=seq=>`00000000-0000-4000-8000-${String(seq).padStart(12,'0')}`;
const textBlock=text=>[{type:'text',text}];
const event=(seq,type,data,extra={})=>({type,seq,time:epoch+seq*1000,data,...extra});

function human(seq,text){
  return event(seq,'user/message',{
    role:'user',id:messageId(seq),content:textBlock(text),
    source:{kind:'user',rpcId:messageId(seq+1000),clientTimeZone:'UTC'},
  },{surfaceOp:'append'});
}
function assistant(seq,text,turn=1,step=1){
  return event(seq,'assistant/message',{
    turn,step,stream:[],message:{role:'assistant',id:messageId(seq),content:textBlock(text),
      source:{kind:'model',provider:'synthetic-provider',model:'synthetic-model'}},
  },{surfaceOp:'append'});
}
function call(seq,name,args,{turn=1,step=1,callId=`fixture-call-${seq}`}={}){
  return event(seq,'tool/call',{turn,step,callId,name,arguments:JSON.stringify(args)});
}
function result(seq,invocation,text,{isError=false,id=messageId(seq),meta,
  sourceEventSeqs=[invocation.seq],surfaceOp='append'}={}){
  const {turn,step,callId}=invocation.data;
  return event(seq,'tool/result',{
    turn,step,...(meta?{meta}:{}),message:{role:'tool',id,
      source:{kind:'tool',callId},toolCallId:callId,content:textBlock(text),isError},
  },{sourceEventSeqs,surfaceOp});
}

/** A short, complete JSON request follows enough text to straddle a byte budget.
 * The source is valid regardless of where an implementation divides it.
 */
export function completeCallFixture({paddingCharacters=2100}={}){
  if(!Number.isInteger(paddingCharacters)||paddingCharacters<0)throw new RangeError('paddingCharacters must be nonnegative');
  const invocation=call(3,'glob',{
    pattern:`**/${'component-'.repeat(24)}GUIDE.md`,path:'/synthetic/project',
  });
  const response=result(4,invocation,'/synthetic/project/component-guide/GUIDE.md');
  return {events:[human(1,'查找示例项目的说明文件。'),assistant(2,'说明材料。'.repeat(Math.ceil(paddingCharacters/5)).slice(0,paddingCharacters)),invocation,response,assistant(5,'已找到说明文件；尚未修改项目。')],
    facts:{callSeq:3,resultSeq:4,callId:invocation.data.callId,argumentsAreCompleteJSON:true,
      action:'search',sourceOutcome:'one matching path returned',noProjectModification:true}};
}

/** A completed bash call returns both tests and the following quiet checks.
 * DSH's bash wrapper keeps isError=false for a nonzero command exit as well;
 * renderResult places [exit code: N] in text when N is nonzero.
 */
export function chainedChecksFixture({failure=false}={}){
  const invocation=call(2,'bash',{
    description:'Run synthetic tests and syntax checks',
    command:'node --test alpha.test.mjs && node --check alpha.mjs && node --check beta.mjs',
    workdir:'/synthetic/project',timeoutMs:10000,
  });
  const output=failure?'tests 2\npass 1\nfail 1\n[exit code: 1]':'tests 2\npass 2\nfail 0\n';
  return {events:[human(1,'运行示例测试和语法检查。'),invocation,result(3,invocation,output,{isError:false,meta:{cwd:'/synthetic/project'}}),assistant(4,failure?'测试失败，后面的语法检查没有执行。':'测试和两项语法检查已完成。')],
    facts:{callSeq:2,resultSeq:3,callId:invocation.data.callId,wrapperIsError:false,
      commandExitCode:failure?1:0,syntaxChecksExecuted:!failure,
      failureMarker:failure?'[exit code: 1]':null,
      renderer:'DSH bash: nonzero exits have an exit-code marker; successful quiet commands add no marker.'}};
}

/** Old failure history is injected during a different human-requested task.
 * Compact checkpoints are user-role messages with nonhuman provenance and a
 * surface replacement range. Their text must not become a new action.
 */
export function historicalCheckpointFixture(){
  const oldCall=call(2,'bash',{command:'curl --fail https://example.invalid/old-route',workdir:'/synthetic/project'});
  const checkpoint=event(11,'user/message',{
    role:'user',id:messageId(11),source:{kind:'compact-checkpoint',compactionId:messageId(2000)},
    content:textBlock('历史摘要：先前旧接口返回HTTP 404，之后那一轮被中断。这些是此前的经历。当前新任务是构建示例面板。'),
  },{sourceEventSeqs:[1,2,3,4],surfaceOp:{op:'replace',startSeq:1,endSeq:4}});
  const currentCall=call(12,'bash',{command:'node build-view.mjs',workdir:'/synthetic/project'},{turn:2});
  return {events:[human(1,'检查旧接口。'),oldCall,result(3,oldCall,'HTTP 404\n[exit code: 22]'),
    event(4,'turn/end',{turn:1,reason:{kind:'interrupted'}}),human(10,'现在构建示例面板，不重启服务。'),checkpoint,
    currentCall,result(13,currentCall,'Built synthetic view.'),assistant(14,'示例面板已构建；本轮没有重启服务。',2)],
    facts:{oldFailureSeq:3,oldInterruptedSeq:4,checkpointSeq:11,checkpointSourceKind:'compact-checkpoint',
      replacedRange:{startSeq:1,endSeq:4},currentHumanSeq:10,currentTurn:2,currentCallSeq:12,currentResultSeq:13,
      currentOperation:'build view',currentTurnInterrupted:false}};
}

/** A returned panel quotes the unknown outcome of historical material.
 * That quoted state is different from whether this panel returned.
 */
export function quotedPanelFixture(){
  const invocation=call(2,'dsh_browser_content',{format:'txt',selector:'#comparison-panel',maxChars:4000});
  const panel='比较面板\n已选两条历史记录\n记录甲：此前计划检查，结果尚未知。\n记录乙：此前仅提出方案，尚未执行。\n两列原文与来源均已显示。';
  return {events:[human(1,'打开两条历史记录的比较结果。'),invocation,result(3,invocation,panel),assistant(4,'比较面板已打开，历史记录的工作结果仍未知。')],
    facts:{callSeq:2,resultSeq:3,callId:invocation.data.callId,panelReturned:true,
      displayedHistoricalOutcome:'unknown / not executed',doesNotEstablishHistoricalTaskSuccess:true}};
}

/** DSH can later replace a tool message with a shorter representation.
 * Its message ID, call ID, turn and step still identify the old invocation;
 * sourceEventSeqs/surfaceOp identify the old result being replaced.
 */
export function replacedResultFixture(){
  const oldCall=call(2,'read',{file_path:'/synthetic/project/guide.mjs',offset:1,limit:100},{turn:1,step:3});
  const original=result(3,oldCall,'export const example = true;\n'+'// synthetic explanation\n'.repeat(40),{meta:{path:'/synthetic/project/guide.mjs',offset:1}});
  const currentCall=call(11,'web_search',{queries:['synthetic reference projects']},{turn:2,step:1});
  const replacement=result(15,oldCall,'export const example = true;\n[shorter retained representation]',{
    id:original.data.message.id,meta:{path:'/synthetic/project/guide.mjs',offset:1},
    sourceEventSeqs:[3],surfaceOp:{op:'replace',startSeq:3,endSeq:3},
  });
  return {events:[human(1,'先读示例代码。'),oldCall,original,assistant(4,'示例代码已读，未修改。'),
    human(10,'现在检索参考项目。'),currentCall,result(12,currentCall,'Found a synthetic reference project.'),replacement,
    assistant(16,'参考项目已找到；此轮没有重新读取本地代码。',2)],
    facts:{oldCallSeq:2,originalResultSeq:3,replacementSeq:15,oldCallId:oldCall.data.callId,
      originalMessageId:original.data.message.id,replacementMessageId:replacement.data.message.id,
      oldTurn:1,currentTurn:2,currentHumanSeq:10,currentCallSeq:11,currentResultSeq:12,
      sourceEventSeqs:[3],surfaceOp:{op:'replace',startSeq:3,endSeq:3},replacementIsNewInvocation:false}};
}

/** A content call and its returned long body may occupy separate fragments. */
export function returnedContentFixture(){
  const invocation=call(2,'dsh_browser_content',{format:'txt',selector:'article',maxChars:12000});
  const body='Synthetic reference article.\n'+'This paragraph describes a fictional tool and makes no claim of running it.\n'.repeat(100);
  return {events:[human(1,'读取参考文档，先不要安装或运行。'),invocation,result(3,invocation,body),assistant(4,'文档正文已读取；未安装或运行其中的工具。')],
    facts:{callSeq:2,resultSeq:3,callId:invocation.data.callId,bodyReturned:true,
      installationPerformed:false,referenceToolExecuted:false}};
}
