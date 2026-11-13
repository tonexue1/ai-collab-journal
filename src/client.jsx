import React,{useEffect,useRef,useState} from 'react';
import css from './style.css';
import { pluginBuild } from './build-info.mjs';

export async function request(action,params={},signal){
  const response=await fetch('api/dsh-collab-journal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...params}),signal});
  let result;try{result=await response.json();}catch{throw new Error(`DSH 连接异常（${response.status}）`);}
  if(!response.ok||!result.ok)throw new Error(result.error||'DSH 请求失败');return result.value;
}
const statusText={unparsed:'未解析',ready:'已解析',stale:'有新内容',error:'读取失败'};
const formatTime=t=>new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function Icon({size=20}){return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 3h12a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Z"/><path d="M3 17h16M8 7h6M8 11h8"/></svg>;}
function Evidence({id,snapshotId,nodeId}){
  const [value,setValue]=useState(null),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();setValue(null);setError('');request('context',{id,snapshotId,nodeId},controller.signal).then(setValue).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[id,snapshotId,nodeId]);
  return <section className="cj-evidence" aria-label="原始上下文">
    <p className="cj-note">解析时的原文快照 · 包含相邻消息 · 高亮为当前节点依据</p>
    {error&&<p role="alert">{error}</p>}{!value&&!error&&<p role="status">正在读取原文…</p>}
    {value?.entries.map(e=><article key={e.seq} className={value.highlight.includes(e.seq)?'cj-source cj-highlight':'cj-source'}>
      <header><b>{e.role==='user'?'人':e.role==='context'?'自动上下文':'AI / 工具'}</b><span>#{e.seq} · {formatTime(e.time)} · {e.type}</span></header>
      <pre>{e.text}</pre><details><summary>完整事件 JSON</summary><pre>{JSON.stringify(e.source,null,2)}</pre></details>
    </article>)}
  </section>;
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
  const [catalog,setCatalog]=useState(null),[workspace,setWorkspace]=useState(''),[query,setQuery]=useState(''),[archived,setArchived]=useState(false),[id,setId]=useState(''),[detail,setDetail]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[starting,setStarting]=useState(false);
  const selection=useRef(0),catalogVersion=useRef(0);const [revision,setRevision]=useState(0);
  async function refresh(){
    const version=++catalogVersion.current;setLoading(true);setError('');
    try {const data=await request('catalog');if(version!==catalogVersion.current)return;setCatalog(data);setWorkspace(w=>data.workspaces.some(x=>x.id===w)?w:data.workspaces.find(w=>w.sessions.length)?.id||data.workspaces[0]?.id||'');setRevision(r=>r+1);}
    catch(e){if(version===catalogVersion.current)setError(e.message);}finally{if(version===catalogVersion.current)setLoading(false);}
  }
  useEffect(()=>{void refresh();return()=>{catalogVersion.current++;selection.current++;};},[]);
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
      try {const data=await request('detail',{id},controller.signal);if(version!==selection.current)return;setDetail(data);}
      catch(e){if(!controller.signal.aborted&&version===selection.current)setError(e.message);}
    }
    void pull();return()=>controller.abort();
  },[id,revision]);
  // Poll only the selected parse. Navigation never applies a late response to another session.
  useEffect(()=>{
    if(detail?.run?.status!=='running')return;
    const version=selection.current,controller=new AbortController();
    const timer=setTimeout(()=>{request('detail',{id},controller.signal).then(data=>{if(version===selection.current){setDetail(data);if(data.run?.status!=='running')void refresh();}}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});},1300);
    return()=>{clearTimeout(timer);controller.abort();};
  },[id,detail]);
  async function parse(){
    const version=selection.current;setStarting(true);setError('');
    try {const run=await request('parse',{id});if(version!==selection.current)return;setDetail(d=>({...d,run}));}
    catch(e){if(version===selection.current)setError(e.message);}finally{if(version===selection.current)setStarting(false);}
  }
  async function cancel(){try{await request('cancel',{id});}catch(e){setError(e.message);}}
  const session=sessions.find(s=>s.id===id),running=starting||detail?.run?.status==='running';
  const all=catalog?.workspaces.flatMap(w=>w.sessions)||[],parsed=all.filter(s=>s.status==='ready'||s.status==='stale').length;
  return <main className="cj-root" data-testid="journal">
    <div className="cj-page">
      <header className="cj-heading"><div><div className="cj-eyebrow">DSH · COLLABORATION JOURNAL</div><h1>协作观察 <span>看清我们怎样把事情做成</span></h1><p>从 workspace 找到一段对话，展开人和 AI 的来回。</p></div><button onClick={refresh} disabled={loading}>{loading?'读取中…':'刷新会话'}</button></header>
      <details className="cj-build"><summary>版本信息</summary><p>界面 {pluginBuild.version} / {pluginBuild.id}</p><p>后台 {catalog?.pluginBuild?`${catalog.pluginBuild.version} / ${catalog.pluginBuild.id}`:'未提供构建标识'}</p></details>
      {buildMismatch&&<p className="cj-notice" role="alert">界面与后台构建不一致。请完全退出 DSH（包括托盘）并重启，再核对版本信息。</p>}
      <div className="cj-overview"><span><b>{catalog?.workspaces.length||0}</b> workspace</span><span><b>{all.length}</b> 段会话</span><span><b>{parsed}</b> 已解析</span><em>手动解析 · 完整会话 · 可回查原文</em></div>
      <div className="cj-workspaces" aria-label="选择 workspace">{catalog?.workspaces.map(w=><button key={w.id} onClick={()=>{setWorkspace(w.id);setQuery('');}} aria-pressed={workspace===w.id} title={w.path}><span className="cj-folder" aria-hidden="true">▱</span>{w.title}<small>{w.sessions.length}</small></button>)}</div>
      {error&&<div className="cj-alert" role="alert">{error}<button onClick={()=>{void refresh();setId('');}}>重试</button></div>}
      {catalog&&!catalog.workspaces.length?<section className="cj-empty"><Icon size={32}/><h2>从第一段 DSH 对话开始</h2><p>在 DSH 创建 workspace 并聊一次，再回来刷新。</p></section>:<div className="cj-layout">
        <aside className="cj-list"><div className="cj-list-head"><h2>{group?.title||'会话'}</h2><p title={group?.path}>{group?.path||'DSH 会话目录'}</p><input aria-label="搜索会话" placeholder="搜索会话…" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>包含已归档会话{archivedCount?`（${archivedCount}）`:''}</label><p className="cj-list-count">显示 {sessions.length} / {group?.sessions.length||0} 条{!archived&&archivedCount?` · 已隐藏 ${archivedCount} 条归档`:''}</p></div>
          <div className="cj-session-list" role="region" aria-label="会话列表" tabIndex={0}>{sessions.map(s=><button className="cj-session" key={s.id} onClick={()=>setId(s.id)} aria-pressed={id===s.id}><span className="cj-session-title">{s.title}</span><span className="cj-session-meta"><time>{formatTime(s.lastActivityAt)}</time><span>{s.humanCount} 次表达</span></span><span className={`cj-status cj-status-${s.status}`}>{s.archived?'已归档 · ':''}{statusText[s.status]}</span>{s.error&&<small>{s.error}</small>}</button>)}{!sessions.length&&<p className="cj-list-empty">{loading?'正在读取 DSH 会话…':'没有匹配的会话'}</p>}</div>
        </aside>
        <section className="cj-reader" aria-label="会话轨迹">
          {!id?<div className="cj-empty"><h2>选一段值得回看的对话</h2><p>解析只会在你点击后开始。</p></div>:<>
            <header className="cj-reader-head"><div><div className="cj-eyebrow">协作轨迹</div><h2>{session?.title||id}</h2><p>{detail?.route?`${detail.route.provider} / ${detail.route.model}`:'复用此会话的 DSH 模型'}{detail?.report?` · 生成于 ${formatTime(detail.report.generatedAt)}`:''}</p></div><button className="cj-primary" disabled={running||!detail||!detail.humanCount||!detail.route} onClick={parse}>{running?'正在解析…':detail?.report?'重新解析':'解析轨迹'}</button></header>
            {running&&<div className="cj-progress" role="status"><span className="cj-pulse"/>{detail?.run?.stage||'准备解析'}<button className="cj-link" onClick={cancel}>停止</button></div>}
            {(detail?.run?.status==='failed'||detail?.run?.status==='cancelled')&&<div className="cj-alert" role="alert"><div>
              <p>{detail.run.error}。{detail.report?'已有轨迹仍可阅读。':'本次尚未生成轨迹，可重试。'}</p>
              <p>停止位置：{detail.run.stage}</p>
              {detail.run.diagnostic&&<details><summary>诊断信息</summary><pre>{JSON.stringify(detail.run.diagnostic,null,2)}</pre></details>}
            </div></div>}
            {detail?.report?.stale&&<p className="cj-notice">这段会话有新内容。当前展示上次解析的轨迹和原文快照，可点击重新解析。</p>}
            {detail?.report?<><div className="cj-reading-key"><span><i/>人提出、纠正、确认</span><span><i/>AI 回复、调查、执行</span><small>{detail.report.nodes.length} 个节点</small></div><Timeline key={id} id={id} report={detail.report}/><p className="cj-footnote">摘要由 AI 整理，请结合原文核对。图片、音频等附件本版仅保留引用。</p></>:<div className="cj-empty"><div className="cj-sequence"><b>人</b><span>→</span><b>AI</b><span>→</span><b>人</b><span>→</span><b>AI</b></div><h2>{detail?'把长对话，读成清楚的过程':'正在读取会话…'}</h2><p>{detail&&!detail.route?'请先在 DSH 选择模型并完成一次对话。':'每次人的表达独立保留，连续的 AI 行动合并展示。'}<br/>点击「解析轨迹」后，使用 DSH 模型整理这段会话。</p></div>}
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
