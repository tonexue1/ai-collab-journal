const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={unparsed:'未解析',ready:'已解析',stale:'有新内容'};
const body=message=>message.parts.map(part=>{
  if(part.type==='text')return `<p>${esc(part.text)}</p>`;
  if(part.type==='tool')return `<details><summary>工具 · ${esc(part.tool||'调用')}</summary><pre>${esc(JSON.stringify(part.state||part,null,2))}</pre></details>`;
  if(part.type==='file')return `<p class="muted">附件：${esc(part.filename||part.mime||'文件')}（未解析二进制内容）</p>`;
  if(part.type==='compaction')return '<p class="muted">会话压缩标记：部分旧内容可能已清理。</p>';
  return '';
}).join('')||'<p class="muted">此消息没有可展示的文本。</p>';
export function createTrajectoryView({api,toast,when}){
  let root=null,data={workspaces:[]},workspace='*',selected='',query='',filter='all',tab='trajectory',report=null,timer=null,epoch=0,selection=0,posting=false;
  const all=()=>data.workspaces.flatMap(w=>w.sessions);
  const current=()=>all().find(s=>s.id===selected);
  const visible=()=>data.workspaces.filter(w=>workspace==='*'||w.directory===workspace).flatMap(w=>w.sessions).filter(s=>(filter==='all'||(filter==='ready'?s.status==='ready':s.status!=='ready'))&&`${s.title} ${s.directory}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>b.lastActivityAt-a.lastActivityAt);
  const sourceHTML=(m,highlight)=>`<article class="message ${highlight?'evidence':''}"><header><span>${m.role==='user'?'人':'AI'}${highlight===null?'':highlight?' · 本节点原文':' · 相邻上下文'}</span><time>${when(m.createdAt)}</time></header>${body(m)}</article>`;
  function render(){
    if(!root?.isConnected)return;
    const sessions=all();
    root.innerHTML=`<section class="trajectory-page"><div class="heading trajectory-heading"><div><div class="eyebrow">WORKSPACE / CONVERSATIONS</div><h1>看见协作的来路</h1><p class="muted">按工作空间浏览会话，把一次次人机往返整理成可回看的轨迹。</p></div><button class="primary" id="sync-sessions">↻ 同步会话</button></div><div id="trajectory-job" aria-live="polite"></div><div class="trajectory-metrics"><div><span>工作空间</span><strong>${data.workspaces.length.toString().padStart(2,'0')}</strong></div><div><span>会话记录</span><strong>${sessions.length.toString().padStart(2,'0')}</strong></div><div><span>已生成轨迹</span><strong>${sessions.filter(s=>s.generatedAt).length.toString().padStart(2,'0')}</strong></div><div><span>有新内容</span><strong>${sessions.filter(s=>s.status==='stale').length.toString().padStart(2,'0')}</strong></div></div><div class="workspace-heading"><h2>工作空间</h2><span>WORKSPACES</span></div><div class="workspace-grid"><button data-workspace="*" class="workspace-tile ${workspace==='*'?'selected':''}" aria-pressed="${workspace==='*'}"><span class="workspace-icon">▦</span><b>全部工作空间</b><span class="workspace-path">所有已采集的主会话</span><small>${sessions.length} 个会话</small></button>${data.workspaces.map(w=>`<button data-workspace="${esc(w.directory)}" class="workspace-tile ${workspace===w.directory?'selected':''}" aria-pressed="${workspace===w.directory}"><span class="workspace-icon">⌑</span><b>${esc(w.name)}</b><span class="workspace-path" title="${esc(w.directory)}">${esc(w.directory||'导入记录未包含路径')}</span><small>${w.sessions.length} 个会话 · ${w.sessions.filter(s=>s.generatedAt).length} 个轨迹</small></button>`).join('')}</div><div class="conversation-layout"><section class="conversation-library" aria-label="会话列表"><div class="conversation-tools"><h2>会话 <span id="conversation-count"></span></h2><input id="conversation-search" type="search" placeholder="搜索标题或项目路径" aria-label="搜索会话" value="${esc(query)}"><div class="conversation-filters" aria-label="解析状态">${[['all','全部'],['pending','待解析 / 更新'],['ready','已解析']].map(([id,label])=>`<button data-filter="${id}" aria-pressed="${filter===id}" class="${filter===id?'selected':''}">${label}</button>`).join('')}</div></div><div id="conversation-list"></div></section><section class="trajectory-detail" id="trajectory-detail" aria-label="会话详情"></section></div><p class="trajectory-footnote">同步只读取 OpenCode 历史。点击“解析轨迹”后，才会将该会话交给你配置的模型。这里展示跨天的完整会话。</p></section>`;
    renderList();renderJob();
  }
  function renderList(){
    const list=visible();
    root.querySelector('#conversation-count').textContent=list.length;
    root.querySelector('#conversation-list').innerHTML=list.map(s=>`<button class="conversation-item ${s.id===selected?'selected':''}" data-conversation="${esc(s.id)}" aria-pressed="${s.id===selected}"><span class="conversation-top"><span class="parse-state ${s.status}">${s.run?.status==='running'?'解析中':s.run?.status==='failed'?'解析失败':labels[s.status]}</span><time>${s.lastActivityAt?when(s.lastActivityAt).split(' ')[0]:''}</time></span><b>${esc(s.title)}</b><span class="conversation-project">${esc(s.directory.replace(/[\\/]+$/,'').split(/[\\/]/).at(-1)||'未标记项目')}</span><span class="conversation-bottom">${s.messageCount} 条消息 <span>${s.nodeCount?`${s.nodeCount} 个节点`:'尚未生成轨迹'} →</span></span></button>`).join('')||`<div class="conversation-empty"><b>${all().length?'没有匹配的会话':'还没有会话记录'}</b><p>${all().length?'换一个工作空间或搜索条件。':'点击“同步会话”，或在设置中导入 OpenCode JSON。'}</p>${all().length?'':'<button data-nav="settings">设置采集目录</button>'}</div>`;
  }
  function renderJob(){
    if(!root?.isConnected)return;
    const run=data.activeRun;
    root.querySelector('#trajectory-job').innerHTML=run?`<div class="trajectory-progress" role="status"><span class="activity-dot"></span><b>${run.kind==='collect'?'正在同步':run.kind==='trajectory'?'正在解析轨迹':'复盘任务执行中'}</b><span>${esc(run.stage)}</span><small>可以继续浏览</small></div>`:'';
    root.querySelector('#sync-sessions').disabled=!!run||posting;
    const parse=root.querySelector('#parse-trajectory');if(parse)parse.disabled=!!run||posting;
  }
  function emptyDetail(){
    root.querySelector('#trajectory-detail').innerHTML='<div class="trajectory-placeholder"><div class="placeholder-mark">↳</div><h2>从一次真实的协作开始</h2><p>选择左侧会话，查看原文或手动生成轨迹。</p><div class="role-preview"><span>人</span><i></i><span>AI</span><i></i><span>人</span><i></i><span>AI</span></div></div>';
  }
  async function select(id){
    const request=++selection,life=epoch;selected=id;report=null;renderList();
    const detail=root.querySelector('#trajectory-detail');
    if(!id){emptyDetail();return;}
    detail.innerHTML='<div class="loading">读取会话轨迹…</div>';
    try{
      const result=await api(`/api/trajectories/${encodeURIComponent(id)}`);
      if(life!==epoch||request!==selection)return;
      report=result;renderDetail();if(tab==='source')await renderSource();
    }catch(error){if(life===epoch&&request===selection)detail.innerHTML=`<div class="error">${esc(error.message)}</div>`;}
  }
  function renderDetail(){
    const s=current();if(!s){emptyDetail();return;}
    root.querySelector('#trajectory-detail').innerHTML=`<div class="trajectory-detail-head"><div class="eyebrow">CONVERSATION / ${report?'已整理':'待解析'}</div><h2>${esc(s.title)}</h2><div class="trajectory-path">${esc(s.directory)}<br><span>${s.messageCount} 条消息 · ${s.userCount} 次人的表达${report?` · ${when(report.generatedAt)} 生成`:''}</span></div><div class="trajectory-toolbar"><div class="trajectory-tabs" role="tablist" aria-label="会话视图"><button role="tab" data-trajectory-tab="trajectory" aria-selected="${tab==='trajectory'}" class="${tab==='trajectory'?'selected':''}">协作轨迹</button><button role="tab" data-trajectory-tab="source" aria-selected="${tab==='source'}" class="${tab==='source'?'selected':''}">完整原文</button></div><button id="parse-trajectory" class="primary">${report?'重新解析':'解析轨迹'}</button></div></div><div id="trajectory-alert">${s.run?.status==='failed'?`<div class="error">上次解析失败：${esc(s.run.error)}${report?'。上次成功的轨迹仍然保留。':''}</div>`:''}${report?.stale?'<div class="notice">会话内容已变化。当前轨迹和节点原文保留上次解析时的快照，重新解析可更新。</div>':''}</div><div id="trajectory-content"></div>`;
    renderJob();
    if(tab==='source')return;
    const content=root.querySelector('#trajectory-content');
    if(!report){content.innerHTML='<div class="trajectory-placeholder"><div class="placeholder-mark">✦</div><h3>把长对话，读成清晰的过程</h3><p>每次人的发言保留为一个节点，<br>AI 的连续回复与工具操作合并呈现。</p><div class="role-preview"><span>人</span><i></i><span>AI</span><i></i><span>人</span><i></i><span>AI</span></div><p class="small muted">点击右上方“解析轨迹”开始。</p></div>';return;}
    let lastDay='';
    content.innerHTML=`<div class="timeline-caption"><span><i class="human-dot"></i> 人的表达</span><span><i class="machine-dot"></i> AI 的行动</span><span>${report.nodes.length} 个节点 · 原顺序保留</span></div><ol class="collaboration-timeline">${report.nodes.map((node,index)=>{
      const day=when(node.startedAt).split(' ')[0],separator=day!==lastDay?`<div class="timeline-date">${esc(day)}</div>`:'';lastDay=day;
      return `<li class="timeline-entry ${node.role==='user'?'human':'machine'}">${separator}<div class="timeline-node"><div class="node-avatar">${node.role==='user'?'人':'AI'}</div><article class="node-card"><header><b>${node.role==='user'?'人的表达':'AI 的行动'}</b><span>${String(index+1).padStart(2,'0')} / ${when(node.startedAt).split(' ').slice(1).join(' ')}</span></header><p class="node-summary">${esc(node.summary)}</p>${node.details.length?`<details class="node-details"><summary>展开细节</summary><ul>${node.details.map(text=>`<li>${esc(text)}</li>`).join('')}</ul></details>`:''}<footer><span>${node.messageIds.length} 条消息${node.toolCount?` · ${node.toolCount} 次工具调用`:''}${when(node.endedAt).split(' ')[0]!==day?` · 延续至 ${when(node.endedAt)}`:''}</span><button data-node-source="${esc(node.id)}" aria-expanded="false">展开原文 ↗</button></footer><div class="node-source" data-source-for="${esc(node.id)}" hidden></div></article></div></li>`;
    }).join('')}</ol><details class="trajectory-limitations"><summary>原文覆盖与说明</summary><p>${report.mode==='demo'?'此轨迹由演示适配器生成，未调用真实模型。':'摘要由模型归纳，可展开原文核对。'}</p>${report.limitations.map(text=>`<p>${esc(text)}</p>`).join('')}</details>`;
  }
  async function renderSource(){
    const request=++selection,life=epoch,id=selected,content=root.querySelector('#trajectory-content');
    content.innerHTML='<div class="loading">读取完整原文…</div>';
    try{
      const source=await api(`/api/sessions/${encodeURIComponent(id)}`);
      if(life!==epoch||request!==selection||tab!=='source')return;
      content.innerHTML=`<p class="source-explanation">最近一次同步的完整原文 · ${source.messages.length} 条消息</p><div class="trajectory-original">${source.messages.map(m=>sourceHTML(m,null)).join('')}</div>`;
    }catch(error){if(life===epoch&&request===selection)content.innerHTML=`<div class="error">${esc(error.message)}</div>`;}
  }
  async function expand(button){
    const panel=button.closest('.node-card').querySelector('.node-source');
    if(!panel.hidden){panel.hidden=true;button.setAttribute('aria-expanded','false');button.textContent='展开原文 ↗';return;}
    panel.hidden=false;button.setAttribute('aria-expanded','true');button.textContent='收起原文 ↑';
    if(panel.dataset.loaded)return;
    panel.innerHTML='<p class="muted">读取解析时的原文…</p>';
    const id=selected,snapshot=report.snapshotId;
    try{
      const context=await api(`/api/trajectories/${encodeURIComponent(id)}/context?${new URLSearchParams({node:button.dataset.nodeSource,snapshot})}`);
      if(!panel.isConnected)return;
      panel.innerHTML='<p class="source-explanation">解析时的原文快照 · 包含相邻上下文</p>'+context.messages.map(m=>sourceHTML(m,context.highlight.includes(m.id))).join('');panel.dataset.loaded='1';
    }catch(error){if(panel.isConnected)panel.innerHTML=`<div class="error">${esc(error.message)}</div>`;}
  }
  async function refresh(){
    const life=epoch;const result=await api('/api/workspaces');if(life!==epoch||!root?.isConnected)return;
    data=result;if(workspace!=='*'&&!data.workspaces.some(w=>w.directory===workspace))workspace='*';
    render();const list=visible();await select(list.some(s=>s.id===selected)?selected:list[0]?.id||'');
    if(data.activeRun)schedule();
  }
  function schedule(){clearTimeout(timer);timer=setTimeout(poll,1500);}
  async function poll(){
    const life=epoch;
    try{
      const runs=await api('/api/runs');if(life!==epoch||!root?.isConnected)return;
      const previous=data.activeRun,run=runs.find(r=>r.id===previous?.id);
      if(run?.status==='running'){data.activeRun=run;renderJob();schedule();return;}
      if(previous)toast(run?.status==='succeeded'?'处理完成':run?.error||'任务状态已更新',run?.status==='failed');
      await refresh();
    }catch(error){if(life===epoch){toast(error.message,true);schedule();}}
  }
  async function run(kind){
    if(posting||data.activeRun)return;
    const life=epoch,id=selected;posting=true;renderJob();
    try{
      const job=await api('/api/runs','POST',{kind,...(kind==='trajectory'?{sessionId:id}:{})});
      if(life!==epoch)return;
      data.activeRun={id:job.id,kind,scope:id,status:'running',stage:'准备中'};renderJob();schedule();
    }finally{posting=false;if(life===epoch)renderJob();}
  }
  async function click(event){
    const b=event.target.closest('button');if(!b)return;
    try{
      if(b.dataset.workspace!==undefined){workspace=b.dataset.workspace;selected='';render();await select(visible()[0]?.id||'');}
      else if(b.dataset.filter){filter=b.dataset.filter;render();await select(visible().some(s=>s.id===selected)?selected:visible()[0]?.id||'');}
      else if(b.dataset.conversation)await select(b.dataset.conversation);
      else if(b.dataset.trajectoryTab){tab=b.dataset.trajectoryTab;selection++;renderDetail();if(tab==='source')await renderSource();}
      else if(b.dataset.nodeSource)await expand(b);
      else if(b.id==='parse-trajectory')await run('trajectory');
      else if(b.id==='sync-sessions')await run('collect');
    }catch(error){toast(error.message,true);}
  }
  function search(event){if(event.target.id!=='conversation-search')return;query=event.target.value;renderList();if(!visible().some(s=>s.id===selected)){selected='';selection++;emptyDetail();}}
  return {
    async mount(element){const life=++epoch;root=element;root.addEventListener('click',click);root.addEventListener('input',search);root.innerHTML='<div class="loading">读取工作空间…</div>';try{await refresh();}catch(error){if(life===epoch&&root?.isConnected)root.innerHTML=`<div class="error">${esc(error.message)}</div>`;}},
    unmount(){epoch++;selection++;clearTimeout(timer);root?.removeEventListener('click',click);root?.removeEventListener('input',search);root=null;}
  };
}
