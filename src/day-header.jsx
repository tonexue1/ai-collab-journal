import React,{useEffect,useRef,useState} from 'react';
import { canSelectDay, monthCells, shiftDay, shiftMonth } from './day-navigation.mjs';
import { observeDaySummary } from './day-summary-reader.mjs';

const dateLabel=date=>new Date(`${date}T12:00:00Z`).toLocaleDateString('zh-CN',{timeZone:'UTC',year:'numeric',month:'long',day:'numeric',weekday:'long'});
const generatedLabel=(time,timeZone)=>new Date(time).toLocaleString('zh-CN',{timeZone,month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});

export function DayNavigation({date,today,onChange,availableDates=[]}){
  const [open,setOpen]=useState(false),[month,setMonth]=useState(()=>date.slice(0,7));
  const root=useRef(null),trigger=useRef(null);
  useEffect(()=>{
    if(!open)return;
    const outside=event=>{if(!root.current?.contains(event.target))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  function choose(value){if(canSelectDay(value,today)){setOpen(false);onChange(value);trigger.current?.focus();}}
  const records=new Set(availableDates),cells=open?monthCells(month):[];
  return <nav className="cj-day-navigation" aria-label="选择交互日期" ref={root} onKeyDown={event=>{if(event.key==='Escape'&&open){setOpen(false);trigger.current?.focus();}}}>
    <button aria-label="上一天" onClick={()=>choose(shiftDay(date,-1))}>‹ 上一天</button>
    <div className="cj-date-anchor"><button ref={trigger} className="cj-date-trigger" aria-expanded={open} aria-controls="cj-date-calendar" onClick={()=>{if(!open)setMonth(date.slice(0,7));setOpen(value=>!value);}}>{dateLabel(date)} <span aria-hidden="true">▾</span></button>
      {open&&<div className="cj-date-calendar" id="cj-date-calendar" role="dialog" aria-label="选择日期">
        <div className="cj-calendar-heading"><button aria-label="上个月" onClick={()=>setMonth(value=>shiftMonth(value,-1))}>‹</button><span aria-live="polite">{month.replace('-',' 年 ')} 月</span><button aria-label="下个月" disabled={month>=today.slice(0,7)} onClick={()=>setMonth(value=>shiftMonth(value,1))}>›</button></div>
        <div className="cj-calendar-grid">{['日','一','二','三','四','五','六'].map(label=><span key={label}>{label}</span>)}{cells.map((value,index)=>value?<button key={value} disabled={!canSelectDay(value,today)} aria-label={`${value}${records.has(value)?'，有交互记录':''}`} aria-pressed={date===value} data-record={records.has(value)} onClick={()=>choose(value)}>{Number(value.slice(-2))}</button>:<span key={`blank-${index}`} aria-hidden="true"/>)}</div>
        <p>小点表示当前工作区范围有交互记录</p>
      </div>}
    </div>
    <button aria-label="下一天" disabled={date>=today} onClick={()=>choose(shiftDay(date,1))}>下一天 ›</button>
    <button className="cj-day-today" onClick={()=>choose(today)}>今天</button>
  </nav>;
}

export function DaySummary({date,timeZone,includeArchived,revision,request}){
  const [data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[starting,setStarting]=useState(false),[refresh,setRefresh]=useState(0);
  const generation=useRef(null),running=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    void observeDaySummary({request,scope:{date,timeZone,includeArchived},signal:controller.signal,initialRunning:running.current,publish:value=>{
      running.current=value.run?.status==='running';setData(value);setError('');setLoading(false);
    },onError:error=>{setError(error.message);setLoading(false);}}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[date,timeZone,includeArchived,revision,refresh,request]);
  useEffect(()=>()=>generation.current?.abort(),[]);
  async function generate(){
    const controller=new AbortController();generation.current=controller;setStarting(true);setError('');
    try {
      const run=await request('generateDaySummary',{date,timeZone,includeArchived},controller.signal);
      if(controller.signal.aborted)return;
      running.current=run.status==='running';setData(value=>({...value,run}));setRefresh(value=>value+1);
    }catch(error){if(!controller.signal.aborted)setError(error.message);}
    finally{if(!controller.signal.aborted)setStarting(false);}
  }
  const summary=data?.summary,run=data?.run,busy=starting||run?.status==='running';
  return <section className="cj-day-summary" aria-labelledby="cj-day-summary-heading">
    <header><div><h2 id="cj-day-summary-heading">当日总结</h2><span>全部工作区 · {date} · {includeArchived?'包含归档':'不含归档'}</span></div><button disabled={busy||loading||!data?.canGenerate} onClick={generate}>{busy?'正在总结…':summary?'更新当日总结':'生成当日总结'}</button></header>
    <div aria-live="polite">{summary?<p className="cj-day-summary-text">{summary.text}</p>:<p className="cj-day-summary-empty">{loading?'正在读取当日总结…':busy?'正在整理这一天的主要事项…':data?.reason||'尚未生成。点击生成后，使用 DSH 模型概括这一天的主要事项。'}</p>}
      {summary&&data.stale&&<p className="cj-day-summary-stale">当天内容已变化，上次总结尚未包含这些变化。</p>}
      {busy&&<p className="cj-day-summary-meta" role="status">{run?.stage||'正在准备总结'}{summary?' · 上次总结仍可阅读。':''}</p>}
    </div>
    {error&&<div className="cj-alert" role="alert">{error}<button onClick={()=>setRefresh(value=>value+1)}>重试读取</button></div>}
    {run&&(run.status==='failed'||run.status==='cancelled')&&<div className="cj-alert" role="alert"><p>这次总结未完成：{run.error||run.stage}{summary?'。上次总结仍可阅读。':''}</p>{run.diagnostic&&<details><summary>查看总结诊断</summary><pre>{JSON.stringify(run.diagnostic,null,2)}</pre></details>}</div>}
    {!busy&&summary&&data?.reason&&<p className="cj-day-summary-meta">当前无法更新：{data.reason}</p>}
    {summary&&<details className="cj-day-summary-sources"><summary>总结范围与来源 · {generatedLabel(summary.generatedAt,timeZone)}</summary><p>{summary.sessionCount} 段会话、{summary.humanCount} 次人的表达 · {timeZone}</p><p>模型：{summary.route.provider} / {summary.route.model}</p><ul>{summary.sources.map(source=><li key={source.sessionId}>{source.workspaceTitle} / {source.title} · {source.humanSeqs.length} 次表达</li>)}</ul></details>}
    {!summary&&!busy&&data?.route&&data?.canGenerate&&<p className="cj-day-summary-meta">{data.coverage.sessionCount} 段会话、{data.coverage.humanCount} 次表达 · {data.route.provider} / {data.route.model}</p>}
  </section>;
}
