import React,{useEffect,useRef,useState} from 'react';
import css from './style.css';
import { pluginBuild } from './build-info.mjs';
import { syncCatalogDetail } from './catalog-sync.mjs';

export async function request(action,params={},signal){
  const response=await fetch('api/dsh-collab-journal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...params}),signal});
  let result;try{result=await response.json();}catch{throw new Error(`DSH 连接异常（${response.status}）`);}
  if(!response.ok||!result.ok){const error=new Error(result.error||'DSH 请求失败');error.status=response.status;throw error;}return result.value;
}
const statusText={unparsed:'未解析',ready:'已解析',stale:'有新内容',error:'读取失败'};
const formatTime=t=>new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function Icon({size=20}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 3h12a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Z"/><path d="M3 17h16M8 7h6M8 11h8"/></svg>;}
function SourceEntry({entry,highlight}){
  const p=entry.provenance,history=p?.sourceKind==='compact-checkpoint';
  return <article className={highlight?'cj-source cj-highlight':'cj-source'}>
    <header><b>{entry.role==='user'?'人':history?'历史上下文':entry.role==='context'?'自动上下文':'AI / 工具'}</b><span>#{entry.seq} · {formatTime(entry.time)} · {entry.type}</span>{highlight&&<span>当前选中原文</span>}</header>
    {(p?.replaces||p?.callSeq!=null)&&<p className="cj-note">{p.replaces?`替换历史记录 #${p.replaces.startSeq}–#${p.replaces.endSeq}`:''}{p.replaces&&p.callSeq!=null?' · ':''}{p.callSeq!=null?`对应调用 #${p.callSeq}`:''}</p>}
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
function InteractionList({id,value,onRefresh}){
  const [expanded,setExpanded]=useState(null);
  const toggle=(interactionId,side)=>setExpanded(current=>current?.id===interactionId&&current.side===side?null:{id:interactionId,side});
  return <ol className="cj-expressions" aria-label="我的表达">{value.items.map((item,index)=>{
    const beforeOpen=expanded?.id===item.id&&expanded.side==='before',afterOpen=expanded?.id===item.id&&expanded.side==='after';
    return <li key={item.id}><article className="cj-card cj-expression-card">
      <header><b>{item.isFirst?'会话起点':`第 ${index+1} 次表达`}</b><span>{formatTime(item.human.time)} · #{item.human.seq}</span></header>
      {item.before.preview&&<section className="cj-prior"><h3>此前 AI 的原话</h3><FoldedText text={item.before.preview.text} prior/></section>}
      <section className="cj-human"><h3>我的原话</h3><FoldedText text={item.human.text}/></section>
      <footer className="cj-interaction-actions"><button className="cj-before-button" aria-expanded={beforeOpen} onClick={()=>toggle(item.id,'before')}>{beforeOpen?'收起介入前原文':item.isFirst&&item.before.entryCount===0?'查看会话起点原文':'看这次介入之前'}</button>{item.after.entryCount>0&&<button className="cj-link" aria-expanded={afterOpen} onClick={()=>toggle(item.id,'after')}>{afterOpen?'收起后续':'查看后续'}</button>}</footer>
      {(beforeOpen||afterOpen)&&<InteractionContext key={`${item.id}:${expanded.side}`} id={id} interactionId={item.id} revision={value.revision} side={expanded.side} onRefresh={onRefresh}/>}
    </article></li>;
  })}</ol>;
}
function HumanExpressions({id,refreshKey,onRefresh}){
  const [value,setValue]=useState(null),[error,setError]=useState(null);
  useEffect(()=>{
    const controller=new AbortController();setValue(null);setError(null);
    request('interactions',{id},controller.signal).then(data=>{if(!controller.signal.aborted)setValue(data);}).catch(error=>{if(!controller.signal.aborted)setError(error);});
    return()=>controller.abort();
  },[id,refreshKey]);
  if(error)return <div className="cj-alert" role="alert">{error.message}<button onClick={onRefresh}>刷新会话</button></div>;
  if(!value)return <p className="cj-expressions-loading" role="status">正在读取你的表达…</p>;
  if(!value.items.length)return <div className="cj-empty"><h2>这段会话还没有人的表达</h2><p>有新的表达后，刷新会话即可查看。</p></div>;
  return <InteractionList key={`${id}:${value.revision}`} id={id} value={value} onRefresh={onRefresh}/>;
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
  const [catalog,setCatalog]=useState(null),[workspace,setWorkspace]=useState(''),[query,setQuery]=useState(''),[archived,setArchived]=useState(false),[id,setId]=useState(''),[storedDetail,setDetail]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[starting,setStarting]=useState(false);
  const detail=storedDetail?.id===id?storedDetail:null;
  const selection=useRef(0),catalogVersion=useRef(0);const [revision,setRevision]=useState(0);
  const [view,setView]=useState('expressions');
  async function refresh(){
    const version=++catalogVersion.current;setLoading(true);setError('');
    try {const data=await request('catalog');if(version!==catalogVersion.current)return;setCatalog(data);setWorkspace(w=>data.workspaces.some(x=>x.id===w)?w:data.workspaces.find(w=>w.sessions.length)?.id||data.workspaces[0]?.id||'');setRevision(r=>r+1);}
    catch(e){if(version===catalogVersion.current)setError(e.message);}finally{if(version===catalogVersion.current)setLoading(false);}
  }
  useEffect(()=>{void refresh();return()=>{catalogVersion.current++;selection.current++;};},[]);
  function receiveDetail(data){setDetail(data);setCatalog(current=>syncCatalogDetail(current,data));}
  const group=catalog?.workspaces.find(w=>w.id===workspace);
  const sessions=(group?.sessions||[]).filter(s=>(archived||!s.archived)&&`${s.title} ${s.directory}`.toLowerCase().includes(query.toLowerCase()));
  const archivedCount=(group?.sessions||[]).filter(s=>s.archived).length;
  const buildMismatch=catalog&&catalog.pluginBuild?.id!==pluginBuild.id;
  useEffect(()=>{setId(current=>sessions.some(s=>s.id===current)?current:sessions[0]?.id||'');},[workspace,query,archived,catalog]);
  useEffect(()=>{
    const version=++selection.current,controller=new AbortController();
    setDetail(previous=>previous?.id===id?previous:null);setStarting(false);setError('');
    if(!id)return()=>controller.abort();
    async function pull(){
      try {const data=await request('detail',{id},controller.signal);if(version!==selection.current)return;receiveDetail(data);}
      catch(e){if(!controller.signal.aborted&&version===selection.current)setError(e.message);}
    }
    void pull();return()=>controller.abort();
  },[id,revision]);
  // Poll only the selected parse. Navigation never applies a late response to another session.
  useEffect(()=>{
    if(detail?.run?.status!=='running')return;
    const version=selection.current,controller=new AbortController();
    const timer=setTimeout(()=>{request('detail',{id},controller.signal).then(data=>{if(version===selection.current)receiveDetail(data);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});},1300);
    return()=>{clearTimeout(timer);controller.abort();};
  },[id,detail]);
  async function parse(){
    const version=selection.current;setStarting(true);setError('');
    try {const run=await request('parse',{id});if(version!==selection.current)return;setDetail(d=>({...d,run}));}
    catch(e){if(version===selection.current)setError(e.message);}finally{if(version===selection.current)setStarting(false);}
  }
  async function cancel(){const version=selection.current;try{await request('cancel',{id});}catch(e){if(version===selection.current)setError(e.message);}}
  const session=sessions.find(s=>s.id===id),running=starting||detail?.run?.status==='running';
  const all=catalog?.workspaces.flatMap(w=>w.sessions)||[];
  const taskNotice=running?'完整轨迹正在解析':detail?.run?.status==='failed'?'完整轨迹解析未完成':detail?.run?.status==='cancelled'?'完整轨迹已暂停':detail?.checkpoint?'完整轨迹有已保存的解析进度':null;
  return <main className="cj-root" data-testid="journal">
    <div className="cj-page">
      <header className="cj-heading"><div><div className="cj-eyebrow">DSH · COLLABORATION JOURNAL</div><h1>协作观察 <span>看清自己的表达与介入</span></h1><p>回看你说了什么，以及介入之前发生了什么。</p></div><button onClick={refresh} disabled={loading}>{loading?'读取中…':'刷新会话'}</button></header>
      <details className="cj-build"><summary>版本信息</summary><p>界面 {pluginBuild.version} / {pluginBuild.id}</p><p>后台 {catalog?.pluginBuild?`${catalog.pluginBuild.version} / ${catalog.pluginBuild.id}`:'未提供构建标识'}</p></details>
      {buildMismatch&&<p className="cj-notice" role="alert">界面与后台构建不一致。请完全退出 DSH（包括托盘）并重启，再核对版本信息。</p>}
      <div className="cj-overview"><span><b>{catalog?.workspaces.length||0}</b> workspace</span><span><b>{all.length}</b> 段会话</span><em>原话即开即读 · 介入前后可回查</em></div>
      <div className="cj-workspaces" aria-label="选择 workspace">{catalog?.workspaces.map(w=><button key={w.id} onClick={()=>{setWorkspace(w.id);setQuery('');}} aria-pressed={workspace===w.id} title={w.path}><span className="cj-folder" aria-hidden="true">▱</span>{w.title}<small>{w.sessions.length}</small></button>)}</div>
      {error&&<div className="cj-alert" role="alert">{error}<button onClick={()=>{void refresh();setId('');}}>重试</button></div>}
      {catalog&&!catalog.workspaces.length?<section className="cj-empty"><Icon size={32}/><h2>从第一段 DSH 对话开始</h2><p>在 DSH 创建 workspace 并聊一次，再回来刷新。</p></section>:<div className="cj-layout">
        <aside className="cj-list"><div className="cj-list-head"><h2>{group?.title||'会话'}</h2><p title={group?.path}>{group?.path||'DSH 会话目录'}</p><input aria-label="搜索会话" placeholder="搜索会话…" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>包含已归档会话{archivedCount?`（${archivedCount}）`:''}</label><p className="cj-list-count">显示 {sessions.length} / {group?.sessions.length||0} 条{!archived&&archivedCount?` · 已隐藏 ${archivedCount} 条归档`:''}</p></div>
          <div className="cj-session-list" role="region" aria-label="会话列表" tabIndex={0}>{sessions.map(s=><button className="cj-session" key={s.id} onClick={()=>setId(s.id)} aria-pressed={id===s.id}><span className="cj-session-title">{s.title}</span><span className="cj-session-meta"><time>{formatTime(s.lastActivityAt)}</time><span>{s.humanCount} 次表达</span></span><span className={`cj-status cj-status-${s.status}`}>{s.archived?'已归档 · ':''}{s.status==='error'?'':'完整轨迹 · '}{statusText[s.status]}</span>{s.error&&<small>{s.error}</small>}</button>)}{!sessions.length&&<p className="cj-list-empty">{loading?'正在读取 DSH 会话…':'没有匹配的会话'}</p>}</div>
        </aside>
        <section className="cj-reader" aria-label="会话阅读">
          {!id?<div className="cj-empty"><h2>选一段值得回看的对话</h2><p>先看自己的表达，再展开介入前的原文。</p></div>:<>
            <header className="cj-reader-head"><div><div className="cj-eyebrow">{view==='expressions'?'我的表达':'完整轨迹'}</div><h2>{session?.title||id}</h2><p>{view==='expressions'?'每次表达独立保留，从此前的情况理解这次介入。':<>{detail?.route?`${detail.route.provider} / ${detail.route.model}`:'复用此会话的 DSH 模型'}{detail?.report?` · 生成于 ${formatTime(detail.report.generatedAt)}`:''}</>}</p></div>{view==='timeline'&&<button className="cj-primary" disabled={running||!detail||!detail.humanCount||!detail.route} onClick={parse}>{running?'正在解析…':detail?.checkpoint?'继续解析':detail?.report?'重新解析':'解析轨迹'}</button>}</header>
            <div className="cj-reader-tabs" role="group" aria-label="阅读方式"><button aria-pressed={view==='expressions'} onClick={()=>setView('expressions')}>我的表达</button><button aria-pressed={view==='timeline'} onClick={()=>setView('timeline')}>完整轨迹</button></div>
            {view==='expressions'?<>
              {taskNotice&&<div className="cj-task-notice" role="status"><span>{taskNotice}{running&&detail?.run?.totalCalls>0?` · ${detail.run.completedCalls||0} / ${detail.run.totalCalls}`:''}</span><button className="cj-link" onClick={()=>setView('timeline')}>{running?'查看进度':'查看详情'}</button></div>}
              <HumanExpressions key={`${id}:${revision}`} id={id} refreshKey={revision} onRefresh={refresh}/>
            </>:<>
            {detail?.plan?.totalCalls>0&&<p className="cj-note">完整解析约 {detail.plan.totalCalls} 次调用（不含重试） · {detail.plan.fragmentCount} 个片段。可离开此页面，保持 DSH 运行；暂停或退出后，已完成部分会保留。</p>}
            {detail?.checkpoint&&!running&&<p className="cj-notice">已保存 {detail.checkpoint.completedCalls} / {detail.checkpoint.totalCalls} 步进度。点击「继续解析」复用已完成部分；原文或模型变化时会从头解析。</p>}
            {running&&<div className="cj-progress" role="status"><span className="cj-pulse"/><div><div>{detail?.run?.stage||'准备解析'}</div>{detail?.run?.totalCalls>0&&<div>已完成 {detail.run.completedCalls||0} / {detail.run.totalCalls} 步 · 复用 {detail.run.reusedCalls||0} 步 · 本次调用 {detail.run.modelCalls||0} 次</div>}</div><button className="cj-link" onClick={cancel}>暂停</button></div>}
            {(detail?.run?.status==='failed'||detail?.run?.status==='cancelled')&&<div className="cj-alert" role="alert"><div>
              <p>{detail.run.error}。{detail.report?'已有轨迹仍可阅读。':'本次尚未生成轨迹，可重试。'}</p>
              <p>停止位置：{detail.run.stage}</p>
              {detail.run.diagnostic&&<details><summary>诊断信息</summary><pre>{JSON.stringify(detail.run.diagnostic,null,2)}</pre></details>}
            </div></div>}
            {detail?.report?.stale&&<p className="cj-notice">这段会话有新内容。当前展示上次解析的轨迹和原文快照，可点击重新解析。</p>}
            {detail?.report?<><div className="cj-reading-key"><span><i/>人提出、纠正、确认</span><span><i/>AI 回复、调查、执行</span><small>{detail.report.nodes.length} 个节点</small></div><Timeline key={id} id={id} report={detail.report}/><p className="cj-footnote">摘要由 AI 整理，请结合原文核对。图片、音频等附件本版仅保留引用。</p></>:<div className="cj-empty"><div className="cj-sequence"><b>人</b><span>→</span><b>AI</b><span>→</span><b>人</b><span>→</span><b>AI</b></div><h2>{detail?'把长对话，读成清楚的过程':'正在读取会话…'}</h2><p>{detail&&!detail.route?'请先在 DSH 选择模型并完成一次对话。':'每次人的表达独立保留，连续的 AI 行动合并展示。'}<br/>点击「解析轨迹」后，使用 DSH 模型整理这段会话。</p></div>}
            </>}
          </>}
        </section>
      </div>}
    </div>
  </main>;
}
export const name='dsh-collab-journal';
export const inject=['slots','connection'];
export function apply(ctx){
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin=name;style.textContent=css;document.head.append(style);return()=>style.remove();});
  ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:name},()=>React.createElement(JournalPage)));
  ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id:name,order:21,label:()=> '协作观察'},props=>React.createElement(Icon,props)));
}
