import React,{useCallback,useEffect,useRef,useState} from 'react';
import css from './style.css';
import { pluginBuild } from './build-info.mjs';
import { syncCatalogDetail } from './catalog-sync.mjs';
import { pollReader } from './reader-poll.mjs';
import { DayNavigation, DaySummary } from './day-header.jsx';
import { filterDayGroups, todayInZone } from './day-navigation.mjs';
import { createInteractionChangeObserver } from './day-summary-reader.mjs';

export async function request(action,params={},signal){
  const response=await fetch('api/dsh-collab-journal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...params}),signal});
  let result;try{result=await response.json();}catch{throw new Error(`DSH 连接异常（${response.status}）`);}
  if(!response.ok||!result.ok){const error=new Error(result.error||'DSH 请求失败');error.status=response.status;throw error;}return result.value;
}
const statusText={unparsed:'未解析',ready:'已解析',stale:'有新内容',error:'读取失败'};
const categories=['方向纠正','任务指挥','上下文补充','流程推进','授权选择','结果反馈','新任务','未判定'];
const formatTime=t=>t==null||!Number.isFinite(new Date(t).getTime())?'时间未知':new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const formatDate=date=>date?date.replaceAll('-',' / '):'全部日期';
function Icon({size=20}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 3h12a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Z"/><path d="M3 17h16M8 7h6M8 11h8"/></svg>;}
function SourceEntry({entry,highlight,readRanges}){
  const p=entry.provenance,history=p?.sourceKind==='compact-checkpoint';
  return <article className={highlight?'cj-source cj-highlight':'cj-source'}>
    <header><b>{entry.role==='user'?'人':history?'历史上下文':entry.role==='context'?'自动上下文':'AI / 工具'}</b><span>#{entry.seq} · {formatTime(entry.time)} · {entry.type}</span>{highlight&&<span>当前选中原文</span>}</header>
    {(p?.replaces||p?.callSeq!=null)&&<p className="cj-note">{p.replaces?`替换历史记录 #${p.replaces.startSeq}–#${p.replaces.endSeq}`:''}{p.replaces&&p.callSeq!=null?' · ':''}{p.callSeq!=null?`对应调用 #${p.callSeq}`:''}</p>}
    {readRanges&&<p className="cj-read-range">{readRanges.length?<>模型读取区间：{readRanges.map(range=>`${range.offset}–${range.offset+range.text.length}`).join('、')} / 全文 {readRanges[0].totalChars} 字符</>:'未记录模型读取区间'}</p>}
    {entry.role==='context'?<details className="cj-context-text"><summary>展开自动上下文原文</summary><pre>{entry.text}</pre></details>:<pre>{entry.text}</pre>}<details><summary>完整事件 JSON</summary><pre>{JSON.stringify(entry.source,null,2)}</pre></details>
  </article>;
}
function Evidence({id,snapshotId,nodeId}){
  const [value,setValue]=useState(null),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();setValue(null);setError('');request('context',{id,snapshotId,nodeId},controller.signal).then(setValue).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[id,snapshotId,nodeId]);
  return <section className="cj-evidence" aria-label="原始上下文">
    <p className="cj-note">解析时的原文快照 · 包含相邻消息 · 高亮为当前节点依据</p>
    {error&&<p role="alert">{error}</p>}{!value&&!error&&<p role="status">正在读取原文…</p>}
    {value?.entries.map(e=><SourceEntry key={e.seq} entry={e} highlight={value.highlight.includes(e.seq)}/>)}
  </section>;
}
function FoldedText({text,prior=false}){
  const [expanded,setExpanded]=useState(false),long=text.length>(prior?240:600)||text.split('\n').length>(prior?4:8);
  return <><p className={`cj-expression-text${prior?' cj-prior-text':''}${long&&!expanded?' cj-text-folded':''}`}>{text}</p>{long&&<button className="cj-link cj-fold-toggle" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起原话':prior?'展开此前原话':'展开全部原话'}</button>}</>;
}
function InteractionContext({id,interactionId,revision,side,onRefresh}){
  const [value,setValue]=useState(null),[offset,setOffset]=useState(0),[error,setError]=useState(null),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError(null);
    request('interactionContext',{id,interactionId,revision,side,offset,limit:20},controller.signal).then(data=>{
      if(controller.signal.aborted)return;
      setValue(previous=>{
        if(offset===0||!previous)return data;
        const entries=side==='before'?[...data.entries,...previous.entries]:[...previous.entries,...data.entries];
        return {...data,entries:[...new Map(entries.map(entry=>[entry.seq,entry])).values()].sort((a,b)=>a.seq-b.seq)};
      });
    }).catch(error=>{if(!controller.signal.aborted)setError(error);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[id,interactionId,revision,side,offset,retry]);
  const before=side==='before',hasMore=value?.cursorNext!=null;
  const more=<button disabled={loading||!!error} onClick={()=>setOffset(value.cursorNext)}>{loading?'正在读取…':before?'加载更早的原文':'加载后续原文'}</button>;
  return <section className="cj-evidence cj-interaction-context" aria-label={before?'介入前原文':'后续原文'}>
    <p className="cj-note">{before?'按时间查看介入前的记录，当前表达在最后。':'按时间查看这次表达之后的记录。'}{value?` 已显示 ${value.entries.length} / ${value.total} 条。`:''}</p>
    {error&&<div className="cj-alert" role="alert">{error.status===409?'会话已更新，请刷新后查看。':error.message}<button onClick={error.status===409?onRefresh:()=>setRetry(value=>value+1)}>{error.status===409?'刷新会话':'重试读取'}</button></div>}
    {!value&&loading&&<p role="status">正在读取原文…</p>}
    {before&&hasMore&&<div className="cj-context-more">{more}</div>}
    {value?.entries.map(entry=><SourceEntry key={entry.seq} entry={entry} highlight={value.highlight.includes(entry.seq)}/>)}
    {!before&&hasMore&&<div className="cj-context-more">{more}</div>}
  </section>;
}
function FrozenEvidence({id,resultId,seq}){
  const [value,setValue]=useState(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),target=useRef(null);
  useEffect(()=>{
    const controller=new AbortController();setValue(null);setError('');
    request('interactionEvidence',{id,resultId},controller.signal).then(data=>{if(!controller.signal.aborted)setValue(data);}).catch(error=>{if(!controller.signal.aborted)setError(error.message);});
    return()=>controller.abort();
  },[id,resultId,retry]);
  useEffect(()=>{if(value)target.current?.scrollIntoView({block:'nearest',behavior:'auto'});},[value,seq]);
  return <section className="cj-evidence cj-frozen-evidence" aria-label="整理依据原文">
    <p className="cj-note">整理依据的原文快照 · {value?formatTime(value.generatedAt):'正在读取'} · 引用 #{seq}</p>
    {value?.coverage&&<p className="cj-evidence-coverage">模型已读 {value.coverage.readChars} / {value.coverage.totalChars} 字符。{value.coverage.complete?'已读完此次介入的前文与当前表达。':'只读取了部分原文，未读部分不表示不存在。'}</p>}
    {value&&<p className="cj-note">下方为完整原文，供你核查；模型只读取所标区间。位置从 0 计，终点不含在内。</p>}
    {error&&<div className="cj-alert" role="alert">{error}<button onClick={()=>setRetry(n=>n+1)}>重试读取</button></div>}
    {!value&&!error&&<p role="status">正在读取依据…</p>}
    {value&&!value.entries.some(entry=>entry.seq===seq)&&<p className="cj-alert" role="alert">这条引用未包含在保存的依据中。</p>}
    {value?.entries.map(entry=><div key={entry.seq} ref={entry.seq===seq?target:null}><SourceEntry entry={entry} highlight={entry.seq===seq} readRanges={value.readEvidence.filter(range=>range.seq===entry.seq)}/></div>)}
  </section>;
}
function References({evidence,onSelect}){
  return evidence?.length>0?<span className="cj-references">{evidence.map((reference,index)=><button key={`${reference.seq}:${index}`} className="cj-reference" title={reference.quote} onClick={()=>onSelect(reference.seq)}>依据 #{reference.seq}</button>)}</span>:null;
}
function InteractionCard({id,item,revision,onRefresh,onAnalyze,disabled,itemError}){
  const [side,setSide]=useState(null),[evidenceSeq,setEvidenceSeq]=useState(null);
  const analysis=item.analysis,result=analysis?.result,beforeOpen=side==='before',afterOpen=side==='after';
  const showEvidence=seq=>{setEvidenceSeq(seq);setSide(null);};
  const toggle=next=>{setSide(current=>current===next?null:next);setEvidenceSeq(null);};
  return <article className="cj-card cj-expression-card">
    <header><div className="cj-interaction-meta"><time>{formatTime(item.human.time)}</time>{item.isFirst&&<span>会话起点</span>}{result?result.categories.map(category=><span className="cj-category" key={category.label}>{category.label}</span>):<span className="cj-category cj-unprocessed">未整理</span>}</div><span>#{item.human.seq}</span></header>
    {result?<>
      <h3 className="cj-interaction-title">{result.title}</h3>
      <section className="cj-analysis-before"><h4>此前情况</h4><p>{result.before.text}</p><References evidence={result.before.evidence} onSelect={showEvidence}/></section>
      <section className="cj-analysis-contribution"><h4>我补上的</h4><p>{result.contribution.text}</p><References evidence={result.contribution.evidence} onSelect={showEvidence}/></section>
      <div className="cj-classification-evidence">{result.categories.map(category=><span key={category.label}>{category.label}<References evidence={category.evidence} onSelect={showEvidence}/></span>)}</div>
      <p className="cj-analysis-note">AI 整理，可查看依据{result.certainty==='unclear'?' · 前因待确认':''}</p>
      {analysis.stale&&<p className="cj-notice">相关原文或整理规则已更新。这里保留上次整理，可重新整理这次交互。</p>}
    </>:<section className="cj-unprocessed-preview"><h3>原话摘录</h3><p>{item.human.text.slice(0,180)}{item.human.text.length>180?'…':''}</p></section>}
    {itemError&&<div className="cj-alert cj-item-error" role="alert"><p>这次未整理完成：{itemError.error}{analysis?'。上次整理仍可阅读。':''}</p>{(itemError.stage||itemError.code||itemError.diagnostic)&&<details><summary>查看诊断</summary><p>{itemError.stage}{itemError.code?` · ${itemError.code}`:''}</p>{itemError.diagnostic&&<pre>{JSON.stringify(itemError.diagnostic,null,2)}</pre>}</details>}</div>}
    <details className="cj-original"><summary>我的原话</summary><section className="cj-human"><p className="cj-expression-text">{item.human.text}</p></section></details>
    {item.before.preview&&<details className="cj-original cj-prior-original"><summary>此前 AI 的原话 · {formatTime(item.before.preview.time)}</summary><section className="cj-prior"><FoldedText text={item.before.preview.text} prior/></section></details>}
    <footer className="cj-interaction-actions"><button className="cj-before-button" aria-expanded={beforeOpen} onClick={()=>toggle('before')}>{beforeOpen?'收起介入前原文':item.isFirst&&item.before.entryCount===0?'查看会话起点原文':'看这次介入之前'}</button>{item.after.entryCount>0&&<button className="cj-link" aria-expanded={afterOpen} onClick={()=>toggle('after')}>{afterOpen?'收起后续':'查看后续'}</button>}<button className="cj-link cj-analyze-one" disabled={disabled} onClick={()=>onAnalyze(item.id,!!analysis)}>{analysis?'重新整理这次交互':'整理这次交互'}</button></footer>
    {side&&<InteractionContext key={`${item.id}:${side}:${revision}`} id={id} interactionId={item.id} revision={revision} side={side} onRefresh={onRefresh}/>}
    {evidenceSeq!=null&&analysis&&<><button className="cj-link cj-close-evidence" onClick={()=>setEvidenceSeq(null)}>收起依据</button><FrozenEvidence key={analysis.resultId} id={id} resultId={analysis.resultId} seq={evidenceSeq}/></>}
  </article>;
}
function InteractionList({id,value,onRefresh,onAnalyze,disabled}){
  const [filter,setFilter]=useState('');
  const items=value.items.filter(item=>!filter||(filter==='未整理'?!item.analysis:item.analysis?.result.categories.some(category=>category.label===filter)));
  const counts=new Map();for(const item of value.items){for(const category of item.analysis?.result.categories||[{label:'未整理'}])counts.set(category.label,(counts.get(category.label)||0)+1);}
  const errors=new Map((value.analysisRun?.errors||[]).map(error=>[error.interactionId,error]));
  return <><div className="cj-category-filters" role="group" aria-label="交互分类"><button aria-pressed={!filter} onClick={()=>setFilter('')}>全部 {value.items.length}</button>{[...categories,'未整理'].filter(label=>counts.has(label)).map(label=><button key={label} aria-pressed={filter===label} onClick={()=>setFilter(label)}>{label} {counts.get(label)}</button>)}</div>
    {!items.length&&<p className="cj-list-empty">当前分类没有交互。<button className="cj-link" onClick={()=>setFilter('')}>查看全部</button></p>}
    <ol className="cj-expressions" aria-label="我的交互">{items.map(item=><li key={item.id}><InteractionCard key={`${item.id}:${item.analysis?.resultId||'raw'}`} id={id} item={item} revision={value.revision} onRefresh={onRefresh} onAnalyze={onAnalyze} disabled={disabled} itemError={errors.get(item.id)}/></li>)}</ol>
  </>;
}
function Timeline({id,report}){
  const [expanded,setExpanded]=useState(null);
  useEffect(()=>setExpanded(null),[id,report.snapshotId]);
  return <ol className="cj-timeline" aria-label="人机协作轨迹">{report.nodes.map((node,i)=><li key={node.id} className={`cj-node cj-${node.role}`}>
    <span className="cj-marker">{node.role==='user'?'人':node.role==='assistant'?'AI':'·'}</span>
    <article className="cj-card"><header><b>{node.role==='user'?'人的表达':node.role==='assistant'?'AI 的行动':'自动上下文'}</b><span>{String(i+1).padStart(2,'0')} · {formatTime(node.startedAt)}{node.toolCount>0?` · ${node.toolCount} 次工具调用`:''}</span></header>
      <p className="cj-summary">{node.summary}</p>
      <footer>{node.details.length>0&&<details><summary>展开细节</summary><ul>{node.details.map((d,i)=><li key={i}>{d}</li>)}</ul></details>}
        <button className="cj-link" aria-expanded={expanded===node.id} onClick={()=>setExpanded(expanded===node.id?null:node.id)}>{expanded===node.id?'收起原文':'查看原文'} <span aria-hidden="true">↗</span></button></footer>
      {expanded===node.id&&<Evidence id={id} snapshotId={report.snapshotId} nodeId={node.id}/>}
    </article>
  </li>)}</ol>;
}
export function JournalPage(){
  const [timeZone]=useState(()=>Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [today,setToday]=useState(()=>todayInZone(timeZone)),[selectedDay,setSelectedDay]=useState(()=>todayInZone(timeZone));
  const [summaryRevision, setSummaryRevision] = useState(0);
  const [interactionChanges] = useState(createInteractionChangeObserver);
  const [catalog,setCatalog]=useState(null),[workspace,setWorkspace]=useState(''),[query,setQuery]=useState(''),[archived,setArchived]=useState(false),[navigation,setNavigation]=useState('days'),[selected,setSelected]=useState(null);
  const [dayState,setDayState]=useState(null),[storedDetail,setDetail]=useState(null),[storedInteractions,setInteractions]=useState(null),[activeRun,setActiveRun]=useState(null);
  const [error,setError]=useState(''),[interactionError,setInteractionError]=useState(''),[loading,setLoading]=useState(true),[starting,setStarting]=useState(false),[revision,setRevision]=useState(0),[view,setView]=useState('expressions');
  const selection=useRef(0),catalogVersion=useRef(0),readerRequest=useRef(0);
  const daysKey=JSON.stringify([workspace,archived,revision]),days=dayState?.key===daysKey?dayState.value:null;
  const all=catalog?.workspaces.flatMap(w=>w.sessions)||[],group=catalog?.workspaces.find(w=>w.id===workspace),workspaceSessions=workspace?group?.sessions||[]:all;
  const matching=s=>s.title.toLowerCase().includes(query.toLowerCase());
  const visibleDays=filterDayGroups(days?.days||[],selectedDay,query);
  const catalogSessions=workspaceSessions.filter(s=>(archived||!s.archived)&&matching(s));
  const candidates=navigation==='days'?visibleDays.flatMap(day=>day.sessions.map(session=>({...session,date:day.date}))):catalogSessions.map(session=>({...session,date:null}));
  const session=candidates.find(s=>s.id===selected?.id&&s.date===selected?.date)||candidates[0],id=session?.id||'',date=session?.date??null;
  const scopeKey=JSON.stringify([id,date,timeZone,revision]),detail=storedDetail?.id===id?storedDetail:null,interactions=storedInteractions?.key===scopeKey?storedInteractions.value:null;
  const fullRun=detail?.run?.mode==='interactions'?null:detail?.run,analysisRun=interactions?.analysisRun;
  const active=activeRun?.status==='running'?activeRun:null,running=starting||!!active,fullRunning=starting==='parse'||fullRun?.status==='running',analysisRunning=starting==='analyze'||analysisRun?.status==='running';
  const buildMismatch=catalog&&catalog.pluginBuild?.id!==pluginBuild.id;
  const receiveRun=useCallback((run,fromAction=false)=>{
    if(!run)return;
    if (interactionChanges(run, fromAction)) setSummaryRevision(value => value + 1);
    setActiveRun(current=>{
      if(current?.id===run.id&&current.startedAt>run.startedAt)return current;
      return run.status==='running'?run:current?.id===run.id?null:current;
    });
  },[interactionChanges]);
  const receiveDetail=useCallback(data=>{setDetail(data);setCatalog(current=>syncCatalogDetail(current,data));receiveRun(data.run);},[receiveRun]);
  const refresh=useCallback(async()=>{
    const version=++catalogVersion.current;setLoading(true);setError('');
    try{const data=await request('catalog');if(version!==catalogVersion.current)return;setCatalog(data);interactionChanges(data.activeRun);setActiveRun(data.activeRun);setRevision(r=>r+1);}
    catch(e){if(version===catalogVersion.current)setError(e.message);}finally{if(version===catalogVersion.current)setLoading(false);}
  },[interactionChanges]);
  useEffect(()=>{void refresh();return()=>{catalogVersion.current++;selection.current++;};},[refresh]);
  useEffect(()=>{const timer=setInterval(()=>setToday(todayInZone(timeZone)),60000);return()=>clearInterval(timer);},[timeZone]);
  useEffect(()=>{
    const controller=new AbortController();setDayState(null);
    request('days',{timeZone,includeArchived:archived,...workspace?{workspaceId:workspace}:{}},controller.signal).then(value=>{if(!controller.signal.aborted)setDayState({key:daysKey,value});}).catch(e=>{if(!controller.signal.aborted)setDayState({key:daysKey,error:e.message});});
    return()=>controller.abort();
  },[daysKey,timeZone,archived,workspace]);
  useEffect(()=>{
    const version=++selection.current,readVersion=++readerRequest.current,controller=new AbortController();setStarting(false);setInteractionError('');setError('');
    if(!id)return()=>controller.abort();
    request('detail',{id},controller.signal).then(data=>{if(!controller.signal.aborted&&version===selection.current&&readVersion===readerRequest.current)receiveDetail(data);}).catch(e=>{if(!controller.signal.aborted&&version===selection.current&&readVersion===readerRequest.current)setError(e.message);});
    request('interactions',{id,timeZone,...date?{date}:{}},controller.signal).then(value=>{if(!controller.signal.aborted&&version===selection.current&&readVersion===readerRequest.current){setInteractions({key:scopeKey,value});receiveRun(value.analysisRun);}}).catch(e=>{if(!controller.signal.aborted&&version===selection.current&&readVersion===readerRequest.current)setInteractionError(e.message);});
    return()=>controller.abort();
  },[scopeKey,id,date,timeZone,receiveDetail,receiveRun]);
  // A running job stays visible across dates/workspaces. Requests for an old
  // selection are aborted and may never replace the newly selected reader.
  useEffect(()=>{
    if(!active)return;
    const controller=new AbortController(),version=selection.current;let timer;
    async function poll(){
      const readVersion=active.id===id?++readerRequest.current:null;
      await pollReader({request,activeRun:active,id,date,timeZone,signal:controller.signal,publish:batch=>{
        if(controller.signal.aborted||version!==selection.current||readVersion!==null&&readVersion!==readerRequest.current)return;
        if(batch.interactions){setInteractions({key:scopeKey,value:batch.interactions});setInteractionError('');}
        if(batch.detail){if(active.id===id)setDetail(batch.detail);setCatalog(current=>syncCatalogDetail(current,batch.detail));setError('');}
        if(batch.detailError)setError(batch.detailError.message);
        if(batch.interactionError)setInteractionError(batch.interactionError.message);
        // Publish terminal state last, after the matching cards/report are in
        // the same synchronous update. No sibling request remains to abort.
        if(batch.idle)setActiveRun(current=>current?.id===active.id&&current.startedAt===active.startedAt?null:current);
        else receiveRun(batch.run);
      }});
      if(!controller.signal.aborted)timer=setTimeout(poll,1300);
    }
    timer=setTimeout(poll,500);return()=>{clearTimeout(timer);controller.abort();};
  },[active?.id,active?.startedAt,id,date,scopeKey,timeZone,receiveDetail,receiveRun]);
  async function act(action,extra={}){
    const version=selection.current;setStarting(action==='parse'?'parse':'analyze');setError('');
    try{
      const run=await request(action,{id,...action==='analyzeInteractions'?{timeZone,...date?{date}:{}}:{},...extra});receiveRun(run,true);
      if(version!==selection.current)return;
      if(action==='parse')setDetail(current=>({...current,id,run}));
      else{const readVersion=++readerRequest.current,value=await request('interactions',{id,timeZone,...date?{date}:{}});if(version===selection.current&&readVersion===readerRequest.current){setInteractions({key:scopeKey,value});receiveRun(value.analysisRun);}}
    }catch(e){if(version===selection.current)setError(e.message);}finally{if(version===selection.current)setStarting(false);}
  }
  async function cancel(){try{await request('cancel',{id:active?.id||id});}catch(e){setError(e.message);}}
  const analyze=(interactionId,force=false)=>act('analyzeInteractions',{...interactionId?{interactionId}:{},force});
  const allAnalyzed=!!interactions?.items.length&&interactions.items.every(item=>item.analysis&&!item.analysis.stale);
  const fullNotice=fullRunning?'完整轨迹正在解析':fullRun?.status==='failed'?'完整轨迹解析未完成':fullRun?.status==='cancelled'?'完整轨迹已暂停':detail?.checkpoint?'完整轨迹有已保存的解析进度':null;
  const archivedCount=navigation==='days'?days?.archivedByDate?.[selectedDay]||0:workspaceSessions.filter(s=>s.archived).length;
  const visibleSessionCount=new Set(candidates.map(s=>s.id)).size;
  function selectDay(value){setSelectedDay(value);setNavigation('days');setSelected(null);}
  return <main className="cj-root" data-testid="journal"><div className="cj-page">
    <header className="cj-heading"><div><div className="cj-eyebrow">DSH · COLLABORATION JOURNAL</div><h1>协作观察 <span>看清自己的表达与介入</span></h1><p>按日期回看：此前发生了什么，我又补上了什么。</p></div><button onClick={refresh} disabled={loading}>{loading?'读取中…':'刷新会话'}</button></header>
    <details className="cj-build"><summary>版本信息</summary><p>界面 {pluginBuild.version} / {pluginBuild.id}</p><p>后台 {catalog?.pluginBuild?`${catalog.pluginBuild.version} / ${catalog.pluginBuild.id}`:'未提供构建标识'}</p></details>
    {buildMismatch&&<p className="cj-notice" role="alert">界面与后台构建不一致。请完全退出 DSH（包括托盘）并重启，再核对版本信息。</p>}
    <div className="cj-daily-header">
      <DayNavigation date={selectedDay} today={today} onChange={selectDay} availableDates={(days?.days||[]).map(day=>day.date)}/>
      <DaySummary key={JSON.stringify([selectedDay,timeZone,archived])} date={selectedDay} timeZone={timeZone} includeArchived={archived} revision={revision + summaryRevision} request={request}/>
    </div>
    <div className="cj-workspace-filter"><span>工作区</span><div className="cj-workspaces" aria-label="选择 workspace"><button onClick={()=>{setWorkspace('');setQuery('');}} aria-pressed={!workspace}>全部工作区</button>{catalog?.workspaces.map(w=><button key={w.id} onClick={()=>{setWorkspace(w.id);setQuery('');}} aria-pressed={workspace===w.id} title={w.path}><span className="cj-folder" aria-hidden="true">▱</span>{w.title}</button>)}</div></div>
    {error&&<div className="cj-alert" role="alert">{error}<button onClick={refresh}>刷新重试</button></div>}
    {active&&active.id!==id&&<div className="cj-task-notice" role="status"><span>其他会话正在{active.mode==='interactions'?'整理交互':'解析完整轨迹'}，可继续阅读。</span><button className="cj-link" onClick={cancel}>暂停任务</button></div>}
    <div className="cj-layout"><aside className="cj-list"><div className="cj-list-head">
      <h2>{navigation==='days'?'交互日期':'所有会话'}</h2><p>{group?.title||'全部工作区'} · {timeZone}</p>
      <div className="cj-nav-mode" role="group" aria-label="会话分组"><button aria-pressed={navigation==='days'} onClick={()=>setNavigation('days')}>按日期</button><button aria-pressed={navigation==='sessions'} onClick={()=>setNavigation('sessions')}>全部会话</button></div>
      <input aria-label="搜索会话" placeholder="搜索会话…" value={query} onChange={e=>setQuery(e.target.value)}/>
      <label><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>包含已归档会话{archivedCount?`（${archivedCount}）`:''}</label>
      <p className="cj-list-count">{navigation==='days'?`显示 ${visibleDays.length} 天 · ${visibleSessionCount} 段会话`:`显示 ${catalogSessions.length} / ${workspaceSessions.length} 条`}{!archived&&archivedCount?` · 已隐藏 ${archivedCount} 条归档`:''}</p>
    </div><div className="cj-session-list" role="region" aria-label="会话列表" tabIndex={0}>
      {navigation==='days'&&visibleDays.map(day=><section className="cj-date-group" key={day.date}><header><h3>{formatDate(day.date)}</h3><p>{query?'匹配':'当日'} {day.sessions.length} 段会话 / {day.sessions.reduce((sum,item)=>sum+item.humanCount,0)} 次表达</p></header>{day.sessions.map(s=>{const native=all.find(item=>item.id===s.id);return <button className="cj-session" key={s.id} onClick={()=>setSelected({id:s.id,date:day.date})} aria-pressed={id===s.id&&date===day.date}><span className="cj-session-title">{s.title}</span><span className="cj-session-meta"><span>{s.humanCount} 次表达</span>{s.archived&&<span>已归档</span>}</span>{native&&<span className={`cj-status cj-status-${native.status}`}>{native.status==='error'?'':'完整轨迹 · '}{statusText[native.status]}</span>}</button>;})}</section>)}
      {navigation==='sessions'&&catalogSessions.map(s=><button className="cj-session" key={s.id} onClick={()=>setSelected({id:s.id,date:null})} aria-pressed={id===s.id}><span className="cj-session-title">{s.title}</span><span className="cj-session-meta"><time>{formatTime(s.lastActivityAt)}</time><span>{s.humanCount} 次表达</span></span><span className={`cj-status cj-status-${s.status}`}>{s.archived?'已归档 · ':''}{s.status==='error'?'':'完整轨迹 · '}{statusText[s.status]}</span>{s.error&&<small>{s.error}</small>}</button>)}
      {navigation==='days'&&dayState?.key===daysKey&&dayState.error&&<p className="cj-alert" role="alert">{dayState.error}</p>}
      {!candidates.length&&<p className="cj-list-empty">{navigation==='days'&&!dayState?'正在读取交互日期…':query?'没有匹配的会话':navigation==='days'?'此范围没有人的交互':'没有匹配的会话'}</p>}
    </div>{navigation==='days'&&days?.unknownTimeCount>0&&<p className="cj-list-foot">{days.unknownTimeCount} 次表达缺少日期，可在「全部会话」查看。</p>}{navigation==='days'&&days?.errors.length>0&&<details className="cj-list-errors"><summary>{days.errors.length} 段会话读取失败</summary>{days.errors.map(item=><p key={item.id}>{item.id}：{item.error}</p>)}</details>}</aside>
    <section className="cj-reader" aria-label="会话阅读">{!id?<div className="cj-empty"><Icon size={32}/><h2>{navigation==='days'?'按日期看自己的交互':'选择一段会话'}</h2><p>人的原话可直接阅读，点击整理后再看前因、贡献与分类。</p></div>:<>
      <header className="cj-reader-head"><div><div className="cj-eyebrow">{view==='expressions'?`${formatDate(date)} · 我的交互`:'整段会话 · 全部日期'}</div><h2>{session.title}</h2><p>{view==='expressions'?`${interactions?.items.length??session.humanCount} 次表达 · 整理后可按分类回看，并核对原文依据。`:<>{detail?.route?`${detail.route.provider} / ${detail.route.model}`:'复用此会话的 DSH 模型'}{detail?.report?` · 生成于 ${formatTime(detail.report.generatedAt)}`:''}</>}</p></div>{view==='expressions'?<button className="cj-primary" disabled={running||!interactions?.items.length||!detail?.route} onClick={()=>analyze(undefined,allAnalyzed)}>{analysisRunning?'正在整理…':allAnalyzed?(date?'重新整理当天交互':'重新整理这段会话'):(date?'整理当天交互':'整理这段会话')}</button>:<button className="cj-primary" disabled={running||!detail?.humanCount||!detail.route} onClick={()=>act('parse')}>{fullRunning?'正在解析…':detail?.checkpoint?'继续解析':detail?.report?'重新解析':'解析轨迹'}</button>}</header>
      <div className="cj-reader-tabs" role="group" aria-label="阅读方式"><button aria-pressed={view==='expressions'} onClick={()=>setView('expressions')}>我的交互</button><button aria-pressed={view==='timeline'} onClick={()=>setView('timeline')}>完整轨迹</button></div>
      {analysisRun&&<div className={`cj-task-notice cj-analysis-progress${analysisRun.status==='failed'?' cj-analysis-failed':''}`} role="status"><span>{analysisRun.scopeDate!==date?`${formatDate(analysisRun.scopeDate)} · `:''}{analysisRun.status==='running'?'正在整理交互':analysisRun.status==='cancelled'?'交互整理已暂停':analysisRun.status==='failed'?(analysisRun.error?'交互整理未完成':'部分交互未整理完成'):'交互整理完成'} · 已保存 {analysisRun.completed} / {analysisRun.total} 次{analysisRun.errors?.length?` · ${analysisRun.errors.length} 次失败`:''}{analysisRun.status==='running'?` · ${analysisRun.stage}`:''}</span>{analysisRun.status==='running'&&<button className="cj-link" onClick={cancel}>暂停</button>}</div>}
      {analysisRun?.error&&<div className="cj-alert cj-analysis-error" role="alert"><p>{analysisRun.error}。已保存的整理仍可阅读。</p>{analysisRun.diagnostic&&<details><summary>整理诊断信息</summary><pre>{JSON.stringify(analysisRun.diagnostic,null,2)}</pre></details>}</div>}
      {view==='expressions'?<>
        {fullNotice&&<div className="cj-task-notice" role="status"><span>{fullNotice}{fullRunning&&fullRun?.totalCalls>0?` · ${fullRun.completedCalls||0} / ${fullRun.totalCalls}`:''}</span><button className="cj-link" onClick={()=>setView('timeline')}>{fullRunning?'查看进度':'查看详情'}</button></div>}
        {interactionError&&<div className="cj-alert" role="alert">{interactionError}<button onClick={refresh}>刷新会话</button></div>}
        {!interactions&&!interactionError&&<p className="cj-expressions-loading" role="status">正在读取你的交互…</p>}
        {interactions?.items.length>0&&<InteractionList key={scopeKey} id={id} value={interactions} onRefresh={refresh} onAnalyze={analyze} disabled={running||!detail?.route}/>}
        {interactions&&!interactions.items.length&&<div className="cj-empty"><h2>这段会话没有此范围内的人的表达</h2><p>可切换日期，或查看完整轨迹。</p></div>}
      </>:<>
        {detail?.plan?.totalCalls>0&&<p className="cj-note">完整解析约 {detail.plan.totalCalls} 次调用（不含重试） · {detail.plan.fragmentCount} 个片段。可离开此页面，保持 DSH 运行；暂停或退出后，已完成部分会保留。</p>}
        {detail?.checkpoint&&!fullRunning&&<p className="cj-notice">已保存 {detail.checkpoint.completedCalls} / {detail.checkpoint.totalCalls} 步进度。点击「继续解析」复用已完成部分；原文或模型变化时会从头解析。</p>}
        {fullRunning&&<div className="cj-progress" role="status"><span className="cj-pulse"/><div><div>{fullRun?.stage||'准备解析'}</div>{fullRun?.totalCalls>0&&<div>已完成 {fullRun.completedCalls||0} / {fullRun.totalCalls} 步 · 复用 {fullRun.reusedCalls||0} 步 · 本次调用 {fullRun.modelCalls||0} 次</div>}</div><button className="cj-link" onClick={cancel}>暂停</button></div>}
        {(fullRun?.status==='failed'||fullRun?.status==='cancelled')&&<div className="cj-alert" role="alert"><div><p>{fullRun.error}。{detail.report?'已有轨迹仍可阅读。':'本次尚未生成轨迹，可重试。'}</p><p>停止位置：{fullRun.stage}</p>{fullRun.diagnostic&&<details><summary>诊断信息</summary><pre>{JSON.stringify(fullRun.diagnostic,null,2)}</pre></details>}</div></div>}
        {detail?.report?.stale&&<p className="cj-notice">这段会话有新内容。当前展示上次解析的轨迹和原文快照，可点击重新解析。</p>}
        {detail?.report?<><div className="cj-reading-key"><span><i/>人提出、纠正、确认</span><span><i/>AI 回复、调查、执行</span><small>{detail.report.nodes.length} 个节点</small></div><Timeline key={id} id={id} report={detail.report}/><p className="cj-footnote">摘要由 AI 整理，请结合原文核对。图片、音频等附件本版仅保留引用。</p></>:<div className="cj-empty"><div className="cj-sequence"><b>人</b><span>→</span><b>AI</b><span>→</span><b>人</b><span>→</span><b>AI</b></div><h2>{detail?'把长对话，读成清楚的过程':'正在读取会话…'}</h2><p>{detail&&!detail.route?'请先在 DSH 选择模型并完成一次对话。':'每次人的表达独立保留，连续的 AI 行动合并展示。'}<br/>点击「解析轨迹」后，使用 DSH 模型整理整段会话。</p></div>}
      </>}
    </>}</section></div>
  </div></main>;
}
export const name='dsh-collab-journal';
export const inject=['slots','connection'];
export function apply(ctx){
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin=name;style.textContent=css;document.head.append(style);return()=>style.remove();});
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:name},()=>React.createElement(JournalPage)));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:name,order:21,label:()=> '协作观察'},props=>React.createElement(Icon,props)));
}
