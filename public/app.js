const state={view:'daily',status:null,days:[],day:'',review:null,event:null,tab:'context',before:6,after:6,full:false,sourceSession:'',dirty:false,contextRequest:0};
const app=document.getElementById('app');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=ms=>new Date(ms).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const dayOf=ms=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(ms));
async function api(url,method='GET',data){const r=await fetch(url,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const v=await r.json();if(!r.ok)throw new Error(v.error||'请求失败');return v;}
function toast(text,error=false){const box=document.getElementById('toast');box.textContent=text;box.className=error?'error':'';box.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>box.hidden=true,4500);}
function canLeave(){return !state.dirty||confirm('这条思考尚未保存，确定离开吗？');}
function shell(){
 app.innerHTML=`<div class="shell"><aside class="sidebar"><div class="brand">协作观察<span>COLLABORATION JOURNAL</span></div><nav aria-label="主导航">${[['daily','◷','每日日记'],['weekly','▤','每周观察'],['runs','↻','运行记录'],['settings','⚙','设置与接入']].map(([id,icon,label])=>`<button data-nav="${id}" class="${state.view===id?'active':''}"><span class="nav-symbol">${icon}</span>${label}</button>`).join('')}</nav><div class="recent-wrap"><div class="recent-title">最近的日记</div><div class="recent">${state.days.slice(0,12).map(d=>`<button data-day="${d.day}" class="${state.day===d.day&&state.view==='daily'?'active':''}">${d.day}${d.complete?'':' · 暂稿'}</button>`).join('')||'<span class="small">　还没有日记</span>'}</div></div><div class="side-foot"><b>每天留一点时间，认识自己的工作。</b><p>北京时间 · 本地保存</p></div></aside><main class="main"><div class="topbar"><div class="crumb">AI 优化之道 / ${({daily:'每日复盘',weekly:'每周观察',runs:'运行记录',settings:'设置与接入'})[state.view]}</div><span class="local-badge">${state.status.demo?'演示模式':'本地工作空间'}</span></div>${state.status.demo?'<div class="demo-banner">演示数据与真实记录隔离保存。当前对话、分析均为示例，未调用真实模型。</div>':''}<div id="page"></div><div class="footer-note">观察事实，核对依据，留下自己的判断。</div></main></div>`;
}
function eventCard(e,retired=false){return `<article class="event-card ${state.event?.id===e.id?'selected':''}"><div class="card-top"><span class="tag">${esc(e.reflection.category||e.category)}</span><span class="status-note">${e.reflection.follow?'留到周总结 ':''}${e.reflection.note?'有思考':''}${retired?' · 历史版本':''}</span></div><h3>${esc(e.title)}</h3><p>${esc(e.summary)}</p><div class="actions"><button data-event="${e.id}">查看原会话</button><button class="ghost" data-reflect="${e.id}">写下思考</button></div></article>`;}
async function showDaily(day){
 state.view='daily';state.day=day;state.dirty=false;state.event=null;state.contextRequest++;
 try{state.review=await api(`/api/reviews/${day}`)}catch(e){state.review=null}
 if(state.day!==day||state.view!=='daily')return;
 shell();const page=document.getElementById('page'),r=state.review;
 page.innerHTML=`<div class="heading"><div><h1>今天，我怎样参与了协作</h1><div class="muted small">${esc(day)} · ${r?(r.complete?'完整日记':'当天暂稿'):'尚未生成'}${r?` · 截至 ${when(r.cutoff)}`:''}</div></div><div class="actions"><input aria-label="日记日期" class="date-input" type="date" id="day-picker" value="${day}" max="${state.status.today}"><button class="primary" id="run-daily">${r?'重新回顾':'生成日记'}</button>${r?`<a href="/api/export/${day}">导出</a>`:''}</div></div>${r?`<div class="overview"><span class="star">✦</span><div><h2>先看一眼</h2><p>${esc(r.overview)}</p><details class="coverage"><summary>${r.coverage.sessions} 个会话 · ${r.coverage.messages} 条当天消息 · 查看覆盖范围</summary><ul><li>日期判断依据：北京时间的消息时间，包含老会话的新交流。</li><li>项目：${esc((r.coverage.directories||[]).join('、')||'无')}</li><li>采集方式：${esc(r.coverage.source||`OpenCode ${r.coverage.version||''} 导出`)}</li>${(r.coverage.limitations||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details></div></div><div class="workspace"><section><div class="section-label"><h2>值得回看的事件</h2><span class="muted small">${r.events.length} 条</span></div><div class="event-list">${r.events.map(e=>eventCard(e)).join('')||'<div class="empty">没有识别出需要单独归纳的事件，不代表你今天没有工作。</div>'}</div>${r.retiredEvents.length?`<details class="retired"><summary>重新分析前保留的批注（${r.retiredEvents.length}）</summary><div class="event-list">${r.retiredEvents.map(e=>eventCard(e,true)).join('')}</div></details>`:''}</section><aside class="panel" id="detail"><div class="empty">选择一个事件，查看当时的对话。</div></aside></div>${r.observations?.length?`<section class="question-list"><h2>观察记录</h2><ul>${r.observations.map(q=>`<li>${esc(q)}</li>`).join('')}</ul></section>`:''}${r.questions?.length?`<section class="question-list"><h2>留给自己的问题</h2><ul>${r.questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul></section>`:''}`:`<div class="empty"><h2>从一篇真实日记开始</h2><p>点击“生成日记”，读取本机 OpenCode 的历史并分析这一天。请先确认在当前账户中可以正常运行 OpenCode。</p><p>也可以在“设置与接入”中导入已有会话，再分析导入的数据。</p><button data-nav="settings">查看接入方式</button></div>`}`;
 if(r?.events.length)selectEvent(r.events[0].id,'context');
}
function selectEvent(id,tab){
 if(!canLeave())return;state.dirty=false;state.event=[...state.review.events,...state.review.retiredEvents].find(e=>e.id===id);state.tab=tab;state.before=6;state.after=6;state.full=false;state.sourceSession='';
 app.querySelectorAll('.event-card').forEach(card=>card.classList.toggle('selected',card.querySelector('[data-event]')?.dataset.event===id));
 renderDetail();
}
function renderDetail(){
 const e=state.event;if(!e)return;
 const detail=document.getElementById('detail');if(!detail)return;
 detail.innerHTML=`<div class="panel-title"><div class="muted small">当前事件</div><h2>${esc(e.title)}</h2></div><div class="tabs" role="tablist" aria-label="事件详情"><button role="tab" aria-selected="${state.tab==='context'}" data-tab="context" class="${state.tab==='context'?'active':''}">原会话</button><button role="tab" aria-selected="${state.tab==='reflection'}" data-tab="reflection" class="${state.tab==='reflection'?'active':''}">我的思考</button></div><div class="detail-body" id="detail-body"></div>`;
 if(state.tab==='context')loadContext();else renderReflection();
}
async function loadContext(){
 const request=++state.contextRequest,e=state.event;const body=document.getElementById('detail-body');body.innerHTML='<div class="muted small">读取原始消息…</div>';
 try{
  const q=new URLSearchParams({before:String(state.before),after:String(state.after),full:state.full?'1':'0'});if(state.sourceSession)q.set('sessionId',state.sourceSession);
  const context=await api(`/api/events/${e.id}/context?${q}`);
  if(request!==state.contextRequest||state.tab!=='context'||state.event?.id!==e.id)return;
  body.innerHTML=`<div class="source-meta">${esc(context.title)}<br>${esc(context.sessionId)} · 原始消息 ${context.start+1}—${context.end} / ${context.total}</div>${context.sessions.length>1?`<label for="source-session" class="small">关联会话</label><select id="source-session">${context.sessions.map(s=>`<option ${s===context.sessionId?'selected':''}>${esc(s)}</option>`).join('')}</select>`:''}<div class="context-actions"><button id="context-full">${state.full?'收起为相关片段':'查看完整会话'}</button><button id="context-anchor">定位相关消息</button></div>${context.start>0?'<button class="ghost small" id="context-before">↑ 展开更早消息</button>':''}<div id="messages">${context.messages.map(m=>`<article class="message ${context.highlight.includes(m.id)?'evidence':''}" data-message="${esc(m.id)}"><header><span>${m.role==='user'?'我':'AI'} ${context.highlight.includes(m.id)?'<span class="evidence-pill">· 引用依据</span>':''}</span><span>${when(m.createdAt)}${dayOf(m.createdAt)!==state.day?' · 跨日背景':''}</span></header>${m.parts.map(p=>{if(p.type==='text')return `<p>${esc(p.text)}</p>`;if(p.type==='tool')return `<details><summary>工具：${esc(p.tool||'调用结果')}</summary><pre>${esc(JSON.stringify(p.state||p,null,2))}</pre></details>`;if(p.type==='file')return `<p class="muted small">附件：${esc(p.filename||p.mime||'文件')}（未解析二进制内容）</p>`;if(p.type==='compaction')return '<p class="muted small">会话压缩标记：部分旧工具内容可能不再可用。</p>';return ''}).join('')}</article>`).join('')}</div>${context.end<context.total?'<button class="ghost small" id="context-after">↓ 展开后续消息</button>':''}<div class="context-actions"><button class="primary" data-tab="reflection">核对后写思考</button></div>`;
 }catch(error){if(request===state.contextRequest)body.innerHTML=`<div class="error">${esc(error.message)}</div>`;}
}
function renderReflection(){
 state.contextRequest++;const e=state.event;
 document.getElementById('detail-body').innerHTML=`<div class="insight"><div class="small muted">AI 的归纳</div><p>${esc(e.intervention)}</p><p class="small muted">后续结果：${esc(e.outcome)}</p></div><div class="form-field"><label for="category">修正分类（可留空，沿用 AI 分类）</label><input type="text" id="category" maxlength="80" list="categories" value="${esc(e.reflection.category)}" placeholder="${esc(e.category)}"><datalist id="categories"><option>方向校准</option><option>任务指挥</option><option>流程推进</option><option>补充背景</option><option>判断取舍</option><option>待判断</option></datalist></div><div class="form-field"><label for="note">我的思考</label><textarea id="note" maxlength="20000" placeholder="当时我为什么介入？这件事值得继续观察吗？">${esc(e.reflection.note)}</textarea></div><label class="small"><input type="checkbox" id="follow" ${e.reflection.follow?'checked':''}> 留到周总结继续观察</label><div class="context-actions"><button class="primary" id="save-reflection">保存思考</button><span class="small muted" id="save-status">${e.reflection.updatedAt?`已保存 · ${when(e.reflection.updatedAt)}`:'可以留空，无须逐条审批。'}</span></div>`;
}
async function saveReflection(){
 const e=state.event,input={note:document.getElementById('note').value,category:document.getElementById('category').value.trim(),follow:document.getElementById('follow').checked};
 await api(`/api/events/${e.id}/reflection`,'PUT',input);e.reflection={...input,updatedAt:Date.now()};state.dirty=false;document.getElementById('save-status').textContent='已保存，重新生成日记也会保留。';toast('思考已保存');
}
async function startRun(kind,date,collect=true){
 if(!canLeave())return;
 const result=await api('/api/runs','POST',{kind,date,collect});toast('任务已开始，可在运行记录查看进度');await showView('runs');pollJob(result.id,date,kind);
}
function pollJob(id,date,kind){
 clearTimeout(pollJob.timer);
 const poll=async()=>{try{const runs=await api('/api/runs'),job=runs.find(r=>r.id===id);if(state.view==='runs')renderRuns(runs);if(job?.status==='running'){pollJob.timer=setTimeout(poll,2000);return}state.days=await api('/api/reviews');if(job?.status==='succeeded'){toast('复盘已完成');if(state.view==='runs')kind==='daily'?await showDaily(date):await showView('weekly');}else if(job)toast(job.error||'执行失败，可重试',true);}catch(error){toast(error.message,true)}};pollJob.timer=setTimeout(poll,1000);
}
function renderRuns(runs){
 document.getElementById('page').innerHTML=`<div class="heading"><div><h1>每一次回顾，都有记录</h1><div class="muted small">失败不会标记为成功；上一次日记仍然保留。</div></div><button id="refresh-runs">刷新</button></div><div class="run-list">${runs.map(r=>`<article class="run-row ${r.status}"><div class="card-top"><h3>${esc(r.scope)} · ${r.kind==='daily'?'每日复盘':'每周观察'}</h3><span class="tag">${({running:'执行中',succeeded:'已完成',failed:'失败'})[r.status]}</span></div><p>${esc(r.stage)} · ${when(r.started_at)}</p>${r.error?`<p class="error">${esc(r.error)}</p><button data-retry="${r.scope}" data-kind="${r.kind}">重新执行</button>`:''}</article>`).join('')||'<div class="empty">尚无运行记录。</div>'}</div>`;
}
function previousMonday(){const d=new Date(`${state.status.today}T12:00:00Z`);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7)-7);return d.toISOString().slice(0,10)}
async function showView(view){
 if(!canLeave())return;state.dirty=false;state.contextRequest++;state.view=view;shell();const page=document.getElementById('page');
 if(view==='daily'){await showDaily(state.day||state.status.today);return}
 if(view==='runs'){renderRuns(await api('/api/runs'));return}
 if(view==='weekly'){
  const weeks=await api('/api/weeks');page.innerHTML=`<div class="heading"><div><h1>从事件里，慢慢看见模式</h1><div class="muted small">优先参考你的思考，结论保留证据和局限。</div></div><div class="actions"><input type="date" id="week-start" class="date-input" aria-label="周总结起始周一" value="${previousMonday()}" max="${state.status.today}"><button class="primary" id="run-week">生成周观察</button></div></div>${weeks.map(w=>`<article class="week-card"><div class="card-top"><h2>${w.start} — ${w.end}</h2><span class="tag">${w.complete?'已完成':'材料未齐'}</span></div><p>${esc(w.overview)}</p><p class="small muted">已覆盖：${w.covered.join('、')}；缺失：${w.missing.join('、')||'无'}</p>${w.patterns.map(p=>`<section class="week-pattern"><h3>${esc(p.title)}</h3><p>${esc(p.observation)}</p><div class="actions">${p.eventIds.map((id,i)=>`<button data-source-event="${esc(id)}">证据 ${i+1}</button>`).join('')}</div></section>`).join('')||'<p class="muted">暂未形成有跨日证据支持的稳定模式。</p>'}${w.questions.map(q=>`<div class="notice">${esc(q)}</div>`).join('')}</article>`).join('')||'<div class="empty"><h2>先积累几篇日记</h2><p>周观察会比较跨天事件，结合你的批注找到重复模式。缺失日期会明确标注。</p></div>'}`;return;
 }
 if(view==='settings'){
  const s=state.status;page.innerHTML=`<div class="heading"><div><h1>让回顾融入日常</h1><div class="muted small">首版通过本地配置文件设置，避免误改模型账户。</div></div></div><section class="setup"><h2>当前工作空间</h2><dl><dt>数据位置</dt><dd>${esc(s.dataDir)}</dd><dt>采集范围</dt><dd>${esc(s.projects.join('、')||'OpenCode CLI 可访问的全部项目')}</dd><dt>模型</dt><dd>${esc(s.model)}</dd><dt>补跑起点</dt><dd>${s.startDate}</dd><dt>日期口径</dt><dd>北京时间 · 按每条消息的时间</dd></dl><h2>接入与定时</h2><p>在项目目录运行 <code>node src/cli.mjs doctor</code>，检查本机 OpenCode。配置可参考 <code>config.example.json</code>。</p><p>运行 <code>scripts/install-schedule.ps1</code> 安装每天北京时间 02:00 的本地任务。会自动补齐遗漏日期，并在周日日报完成后生成周总结。</p><div class="notice">这里显示的是安装说明；是否已经安装，请在 Windows 任务计划程序核实。</div><h2>已有会话导入</h2><p class="small muted">选择 OpenCode 导出的 JSON。导入只保存原文；“分析导入数据”仍会调用你的 OpenCode 模型。</p><input id="import-file" type="file" accept=".json,application/json" aria-label="导入 OpenCode 会话 JSON"><div class="actions"><input type="date" id="import-date" class="date-input" aria-label="分析导入数据的日期" value="${state.day||s.today}" max="${s.today}"><button id="analyze-imported">分析导入数据</button></div></section>`;
 }
}
app.addEventListener('click',async e=>{
 const b=e.target.closest('button');if(!b)return;
 try{
  if(b.dataset.nav)await showView(b.dataset.nav);
  else if(b.dataset.day){if(canLeave())await showDaily(b.dataset.day)}
  else if(b.dataset.event)selectEvent(b.dataset.event,'context');
  else if(b.dataset.reflect)selectEvent(b.dataset.reflect,'reflection');
  else if(b.dataset.tab){if(!canLeave())return;state.dirty=false;state.tab=b.dataset.tab;renderDetail()}
  else if(b.id==='run-daily')await startRun('daily',state.day);
  else if(b.id==='run-week')await startRun('weekly',document.getElementById('week-start').value);
  else if(b.id==='context-full'){state.full=!state.full;loadContext()}
  else if(b.id==='context-before'){state.before+=10;loadContext()}
  else if(b.id==='context-after'){state.after+=10;loadContext()}
  else if(b.id==='context-anchor'){document.querySelector('.message.evidence')?.scrollIntoView({block:'center',behavior:'smooth'})}
  else if(b.id==='save-reflection')await saveReflection();
  else if(b.id==='refresh-runs')renderRuns(await api('/api/runs'));
  else if(b.dataset.retry)await startRun(b.dataset.kind,b.dataset.retry);
  else if(b.id==='analyze-imported')await startRun('daily',document.getElementById('import-date').value,false);
  else if(b.dataset.sourceEvent){const event=await api(`/api/events/${b.dataset.sourceEvent}`);if(canLeave()){await showDaily(event.day);selectEvent(event.id,'context')}}
 }catch(error){toast(error.message,true)}
});
app.addEventListener('input',e=>{if(['note','category','follow'].includes(e.target.id)){state.dirty=true;document.getElementById('save-status').textContent='尚未保存'}});
app.addEventListener('change',async e=>{try{
 if(e.target.id==='day-picker'){if(canLeave())await showDaily(e.target.value);else e.target.value=state.day}
 if(e.target.id==='source-session'){state.sourceSession=e.target.value;loadContext()}
 if(e.target.id==='import-file'&&e.target.files[0]){const file=e.target.files[0];if(file.size>64*1024*1024)throw new Error('文件超过 64 MB');const r=await api('/api/import','POST',JSON.parse(await file.text()));toast(`已导入 ${r.messages} 条消息`)}
 }catch(error){toast(error.message,true)}});
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue=''}});
(async()=>{try{state.status=await api('/api/status');state.days=await api('/api/reviews');state.day=state.days[0]?.day||state.status.today;await showDaily(state.day);const active=(await api('/api/runs')).find(r=>r.status==='running');if(active)pollJob(active.id,active.scope,active.kind);}catch(error){app.innerHTML=`<div class="error">无法读取本地服务：${esc(error.message)}</div>`}})();
