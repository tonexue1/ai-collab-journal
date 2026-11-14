import { randomUUID } from 'node:crypto';
import { routeFrom } from './trajectory.mjs';
import { JournalError } from './service.mjs';
import { modelGenerator } from './model.mjs';
import { protectDaySummaryInput } from './day-summary.mjs';
import { gitRoot, nearbyCommits, replayPaths, freezeFiles, editCopy } from './replay-files.mjs';
import { pluginBuild } from './build-info.mjs';

const options=[
  {id:'preserve-layout',text:'识别并保留用户已认可的界面布局与操作习惯'},
  {id:'preserve-behavior',text:'局部修改已有功能时兼顾原有行为与调用方式'},
  {id:'clarify-goal',text:'在影响交付方向的歧义下取得足够的需求背景'},
  {id:'verify-result',text:'验证实际交付并准确说明已完成和未验证的事项'},
];
const researchSystem='根据真实开发对话，从 options 中选一个适合改善工作区指导的问题类别。expressions 中每条人话可带它之前的 AI 回复，历史材料仅用于观察。没有合适的问题类别请选 none。只返回 JSON {"id":"类别 id 或 none","reason":"依据，中文，最多300字"}。不要撰写新规则。';
const authorSystem='为一个 coding 工作区的 AGENTS.md 起草一条简短且可执行的通用规则来应对 category 描述的问题。自行决定具体做法，说明适用条件，兼容其他类型任务，适用于今后不同项目。只输出 JSON {"text":"一条完整中文规则，最多300字"}。不指定项目、文件名、答案、命令或工具。';
const coderSystem='你负责在一个独立的小型代码副本中完成编程任务。requests 是按时间排序的原始要求与用户选入的补充；rules 是这个副本的 AGENTS.md，files 是你可读写的所有代码文件。任务中提及的外部操作不能执行。只返回 JSON {"files":[{"path":"所给路径","text":"修改后的完整文件内容"}]}。每个给定路径恰好返回一次，未改文件逐字返回。text 为 null 表示删除或保持不存在。不要用省略号代替代码。若因缺少工具、文件或真实运行条件无法交付，请改为 {"unavailable":true}。';
function parseReply(raw){
  try{return JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));}
  catch{throw new JournalError('模型返回的 JSON 不完整，本次复演已停止。');}
}
function codeFiles(raw,expected){
  const response=parseReply(raw);
  if(response?.unavailable===true)throw new JournalError('模型判断当前文件或运行条件不足以交付。请核对范围。');
  if(!Array.isArray(response?.files)||response.files.length!==expected.length)throw new JournalError('模型返回文件数量与选择的范围不一致。');
  const mapped=new Map();
  for(const file of response.files){
    if(!expected.some(source=>source.path===file?.path)||mapped.has(file.path)
      ||!(file.text===null||typeof file.text==='string'&&Buffer.byteLength(file.text)<=24000&&!file.text.includes('\0')))
      throw new JournalError('模型输出包含未选择的路径、重复路径或不支持的文件内容。');
    mapped.set(file.path,file.text);
  }
  return expected.map(({path})=>({path,text:mapped.get(path)}));
}
function inputBudget(input){
  if(JSON.stringify(input).length>48000)throw new JournalError('本次模型输入超过 48,000 字符预算。请缩小场景范围或选择较短的会话。');
  const knownCredential=/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{30,}|AKIA[0-9A-Z]{16})\b/;
  if(knownCredential.test(JSON.stringify(input))||protectDaySummaryInput(input).redactions)throw new JournalError('场景中发现已知格式的凭证，本次未发送给模型。');
}
function visibleScene(scene){if(!scene)return null;const {sources,rules,...visible}=scene;return {...visible,baseRules:rules};}
function baseRecord(id){return {id,favorite:false,savedAt:null,humans:[],route:null,scene:null};}

export class ReplayDesk {
  constructor(journal){
    this.journal=journal;
    this.active=null;this.closed=false;this.writes=Promise.resolve();
  }
  get cases(){return this.journal.domain.table('replay_cases');}
  get results(){return this.journal.domain.table('replay_results');}
  queue(fn){
    const task=this.writes.then(fn);this.writes=task.catch(()=>{});return task;
  }
  async close(){
    this.closed=true;
    await this.writes;
    this.active?.controller.abort();
    await this.active?.pending;
    await this.writes;
  }
  current(id){
    const stored=this.results.get(id)??{run:null,previous:null};
    if(this.active?.id===id)return {...stored,run:this.active.run};
    if(stored.run?.status==='running')return {...stored,run:{...stored.run,status:'interrupted',stage:'宿主重启，复演已中断。'}};
    return stored;
  }
  state(id){
    const {favorite,savedAt,humans,route,scene}=this.cases.get(id)??baseRecord(id);
    return {favorite,savedAt,humans,route,scene:visibleScene(scene),...this.current(id)};
  }
  saved(id){
    const record=this.cases.get(id);
    if(!record?.favorite)throw new JournalError('请先收藏这段对话。');
    return record;
  }
  async favorite(id){
    const existing=this.cases.get(id);
    if(existing){if(!existing.favorite)await this.cases.put(id,{...existing,favorite:true});return;}
    const log=await this.journal.source(id);
    const workspace=this.journal.ctx.workspaceRegistry.list().find(w=>w.sessionIds.includes(id));
    const humans=[],cues=[];let before=null;
    for(const entry of log.entries){
      if(entry.role==='user'){
        humans.push({seq:entry.seq,time:Number.isFinite(entry.time)?entry.time:null,text:entry.text});
        if(before)cues.push({humanSeq:entry.seq,seq:before.seq,text:before.text.slice(0,1200),excerpt:before.text.length>1200});
        before=null;
      }else if(entry.type==='assistant/message')before=entry;
    }
    await this.cases.put(id,{...baseRecord(id),favorite:true,savedAt:Date.now(),humans,cues,route:routeFrom(log.events),
      workspacePath:workspace?.path??null});
  }
  async paths(id,body){
    const root=await gitRoot(this.saved(id).workspacePath);
    return {paths:await replayPaths(root,body.base,body.reference)};
  }
  async configure(id,body){
    const record=this.saved(id);
    if(this.active?.id===id)throw new JournalError('本场景正在复演，请等待或结束本轮。',409);
    if(!Array.isArray(body.extraSeqs)||new Set(body.extraSeqs).size!==body.extraSeqs.length
      ||!body.extraSeqs.every(seq=>record.humans.slice(1).some(h=>h.seq===seq)))throw new JournalError('补充要求须来自收藏时已有的后续真人表达。');
    if(!record.humans.length)throw new JournalError('该对话没有可复演的真人要求。');
    const snapshot=await freezeFiles(await gitRoot(record.workspacePath),body);
    const scene={...snapshot,extraSeqs:record.humans.filter(h=>body.extraSeqs.includes(h.seq)).map(h=>h.seq),source:'user-selected-git'};
    await this.cases.put(id,{...record,scene});
  }
  async start(id){
    if(this.active)throw new JournalError('已有一项复演运行中。',409);
    const record=this.saved(id);
    if(!record.scene)throw new JournalError('请先确认开工版本、认可交付和复演文件。');
    if(!record.route)throw new JournalError('收藏的会话没有记录可用的 DSH 模型。');
    const {scene}=record;
    if(scene.sources.some(file=>file.text===null))throw new JournalError('已保存的材料含开工时不存在的文件。请调整复演材料后再试。');
    const requests=record.humans.filter((h,index)=>index===0||scene.extraSeqs.includes(h.seq)).map(({seq,text})=>({seq,text}));
    if(requests.some(h=>h.text.includes('附件；此版仅解析文本〕')))throw new JournalError('所选要求依赖当前版本不能重放的附件。');
    const expressions=record.humans.map(h=>({...h,before:record.cues.find(c=>c.humanSeq===h.seq)??null}));
    const authorInput={kind:'replay-rule',options,expressions,requests};
    inputBudget(authorInput);inputBudget({kind:'replay-code',requests,files:scene.sources,rules:scene.rules});
    const previous=this.current(id);
    const run={runId:randomUUID(),status:'running',stage:'从历史介入识别问题类别',modelCalls:0,startedAt:Date.now(),route:record.route,pluginBuild,scene:visibleScene(scene)};
    await this.results.put(id,{run:structuredClone(run),previous:previous.run?.status==='completed'?previous.run:previous.previous});
    const job={id,run,controller:new AbortController()};
    this.active=job;
    job.pending=this.execute(job,record,requests,authorInput).finally(()=>{if(this.active===job)this.active=null;});
    // A persistence failure still releases the active job; its durable running marker
    // remains recoverable as interrupted, including after a host restart.
    job.pending.catch(()=>{});
  }
  async execute(job,record,requests,authorInput){
    const {run,id,controller}=job;
    const {signal}=controller;
    const call=async(system,input,actor)=>{
      signal.throwIfAborted();inputBudget(input);
      run.modelCalls++;
      await this.persist(run,id);
      signal.throwIfAborted();
      const generate=modelGenerator(this.journal.ctx.llm,record.route,`journal-replay-${run.runId}-${actor}`,{system});
      const raw=await generate(input,signal);signal.throwIfAborted();return raw;
    };
    try{
      const reply=parseReply(await call(researchSystem,authorInput,'researcher'));
      if(typeof reply?.reason!=='string'||!reply.reason.trim()||reply.reason.length>480)throw new JournalError('规则选择结果缺少有效依据。');
      const selected=options.find(option=>option.id===reply.id);
      if(!selected&&reply.id!=='none')throw new JournalError('模型选择了范围外的规则。');
      if(!selected){run.status='skipped';run.stage='没有匹配的通用规则';run.reason=reply.reason;}
      else{
        run.stage='隔离起草一条新的工作区规则';
        // Only a validated, fixed category crosses from history into the author.
        const draft=parseReply(await call(authorSystem,{kind:'replay-author',category:selected.text},'author'));
        if(typeof draft?.text!=='string'||!draft.text.trim()||draft.text.length>480||/[\x00-\x1f]/.test(draft.text))
          throw new JournalError('模型起草的规则须为一条简短完整的文本。');
        run.rule={id:selected.id,category:selected.text,path:'AGENTS.md',text:draft.text.trim(),reason:reply.reason};
        const {scene}=record;
        for(const arm of ['baseline','candidate']){
          run.stage=arm==='baseline'?'用原有规则生成交付':'用候选规则生成交付';
          const rules=arm==='baseline'?scene.rules:`${scene.rules}${scene.rules?'\n\n':''}${run.rule.text}\n`;
          run[arm]=await editCopy(scene.sources,rules,async(files,rules)=>{
            const raw=await call(coderSystem,{kind:'replay-code',requests,rules,files},arm);
            return codeFiles(raw,files);
          },signal);
        }
        run.status='completed';run.stage='两份代码已生成，等待你验收';
      }
    }catch(error){
      run.status=signal.aborted?'interrupted':'failed';
      run.error=signal.aborted?'本轮已中断，既有交付仍可查看。':
        error instanceof JournalError?error.message:'DSH 模型调用或临时副本处理失败，请核对原会话模型后重试。';
    }
    run.finishedAt=Date.now();
    await this.persist(run,id);
  }
  persist(run,id){
    const snapshot=structuredClone(run);
    return this.queue(async()=>{
      const latest=this.results.get(id);
      await this.results.put(id,{run:snapshot,previous:latest.previous});
    });
  }
  async review(id,{runId,choice,note=''}){
    if(!['candidate','reference','tie','neither'].includes(choice)||typeof note!=='string'||note.length>1000)throw new JournalError('请选择有效的验收结论，说明最多 1000 字符。');
    const results=this.results.get(id);
    const key=['run','previous'].find(key=>results?.[key]?.runId===runId&&results[key].status==='completed');
    if(!key)throw new JournalError('这次已完成交付不可用，请刷新。',409);
    await this.results.put(id,{...results,[key]:{...results[key],review:{choice,note,at:Date.now()}}});
  }
  async dispatch(action,id,body){
    if(this.closed)throw new JournalError('插件正在关闭。',409);
    if(action==='replayState')return this.state(id);
    if(action==='replayFavorites')return {ids:[...this.cases.entries()].filter(([,v])=>v.favorite).map(([key])=>key)};
    if(action==='replayPaths')return this.paths(id,body);
    if(action==='replayCommits'){
      const record=this.saved(id);
      return {commits:await nearbyCommits(await gitRoot(record.workspacePath),record.humans[0]?.time)};
    }
    return this.queue(async()=>{
      if(this.closed)throw new JournalError('插件正在关闭。',409);
      if(action==='replayFavorite')await this.favorite(id);
      else if(action==='replayUnfavorite'){
        if(this.active?.id===id)throw new JournalError('先结束正在运行的复演再取消收藏。',409);
        const record=this.cases.get(id);if(record)await this.cases.put(id,{...record,favorite:false});
      }
      else if(action==='replayConfigure')await this.configure(id,body);
      else if(action==='replayStart')await this.start(id);
      else if(action==='replayReview')await this.review(id,body);
      else if(action==='replayCancel'){
        if(this.active?.id===id)this.active.controller.abort();
      }
      else throw new JournalError('未知复演操作。');
      return this.state(id);
    });
  }
}
