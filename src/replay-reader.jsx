import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

export function useFavorites(request) {
  const [ids, setIds] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const version = ++generation.current;
    request('replayFavorites', {}, controller.signal).then(value => {
      if (!controller.signal.aborted && version === generation.current) {
        setIds(new Set(value.ids));
        setError('');
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [request, attempt]);
  const save = useCallback(async (id, enabled) => {
    // A favorite belongs to the catalog. Finish the write even if the reader
    // switches to another conversation before the host acknowledges it.
    await request(enabled ? 'replayFavorite' : 'replayUnfavorite', {id});
    generation.current++;
    setError('');
    setIds(previous => {
      const next = new Set(previous);
      if (enabled) next.add(id);
      else next.delete(id);
      return next;
    });
  }, [request]);
  return { ids, error, save, reload: () => setAttempt(value => value + 1) };
}

export function ReplayReader({ id, request, favorites }) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const mounted = useRef(false);
  const collected = favorites.ids?.has(id) ?? false;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function favorite(enabled) {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      await favorites.save(id, enabled);
      if (mounted.current && !enabled) setOpen(false);
    } catch (cause) {
      if (mounted.current) setError(cause.message);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return <div className="cj-replay">
    <div className="cj-replay-links">
      {collected ? <button className="cj-replay-toggle" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen(value => !value)}><Bookmark filled/>已收藏 · 工作区复演<span aria-hidden="true">{open ? '⌃' : '⌄'}</span></button> :
        <button disabled={saving || !favorites.ids} onClick={() => favorite(true)}><Bookmark/>{saving ? '正在收藏…' : '收藏会话'}</button>}
      {open && <button disabled={saving} onClick={() => favorite(false)}>取消收藏</button>}
      {error && <span role="alert">{error}</span>}
      {!favorites.ids && favorites.error && <button onClick={favorites.reload}>重新读取收藏</button>}
    </div>
    {open && <section className="cj-replay-panel" aria-label="工作区复演" id={panelId}>
      <ReplayPanel key={reload} id={id} request={request} retry={() => setReload(value => value + 1)}/>
    </section>}
  </div>;
}

function Bookmark({ filled = false }) {
  return <svg width="13" height="15" viewBox="0 0 16 18" aria-hidden="true">
    <path d="M3.5 2.5h9v13L8 12.25 3.5 15.5z" fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4"/>
  </svg>;
}

function ReplayPanel({ id, request, retry }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(false);
  const lifetime = useRef(null);
  const latestRead = useRef(0);
  const writing = useRef(false);

  const read = useCallback(async () => {
    const signal = lifetime.current.signal;
    const version = ++latestRead.current;
    try {
      const value = await request('replayState', { id }, signal);
      if (!signal.aborted && latestRead.current === version) {
        setData(value);
        setError('');
      }
    } catch (cause) {
      if (!signal.aborted && latestRead.current === version) setError(cause.message);
    }
  }, [id, request]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void read();
    return () => controller.abort();
  }, [read]);

  const running = data?.run?.status === 'running';
  useEffect(() => {
    if (!running) return;
    let stopped = false, timer;
    async function poll() {
      if (!writing.current) await read();
      if (!stopped) timer = setTimeout(poll, 1500);
    }
    timer = setTimeout(poll, 1500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, read]);

  async function act(action, params = {}) {
    if (writing.current) return false;
    writing.current = true;
    latestRead.current++;
    const signal = lifetime.current.signal;
    setBusy(action);
    setError('');
    try {
      await request(action, { id, ...params }, signal);
      if (signal.aborted) return false;
      await read();
      return !signal.aborted;
    } catch (cause) {
      if (!signal.aborted) setError(cause.message);
      return false;
    } finally {
      writing.current = false;
      if (!signal.aborted) setBusy('');
    }
  }

  const result = data?.run?.status === 'completed' ? data.run : data?.previous;
  const canStart = !!(data?.scene && data.route && !running && !busy && !editing);
  return <>
    <header className="cj-replay-heading"><h3>工作区复演</h3><span>整段会话 · 文件对照</span></header>
    {error && <div className="cj-alert" role="alert">{error}<button onClick={data ? read : retry}>重读状态</button></div>}
    {!data && !error && <p role="status">正在读取收藏的场景…</p>}
    {data && <>
      {!data.scene && !editing && <div className="cj-replay-start">
        <p>已收藏 {data.humans.length} 次人的表达。要再做一次，先指出开工时的代码和你认可的交付。</p>
        <button onClick={() => setEditing(true)}>准备复演</button>
      </div>}
      {editing && <SceneEditor id={id} data={data} request={request} saving={!!busy}
        onCancel={() => setEditing(false)} onSave={async scene => {
          if (await act('replayConfigure', scene)) setEditing(false);
        }}/>}
      {data.scene && !editing && <div className="cj-replay-ready">
        <details>
          <summary>已选复演材料 · {data.scene.paths.length} 个文件</summary>
          <SceneInfo scene={data.scene}/>
          <RequestList humans={data.humans} extraSeqs={data.scene.extraSeqs}/>
          <details><summary>开工时的 AGENTS.md</summary>
            {data.scene.baseRules ? <pre tabIndex={0}>{data.scene.baseRules}</pre> : <p className="cj-replay-hint">这个版本没有记录项目规则正文。</p>}
          </details>
        </details>
        <div className="cj-replay-actions">
          <button className="cj-primary" disabled={!canStart} onClick={() => act('replayStart')}>{result ? '再次试一条规则' : '试一条工作区规则'}</button>
          <button disabled={running || !!busy} onClick={() => setEditing(true)}>调整复演材料</button>
        </div>
        <p className="cj-replay-hint">{data.route ? `${data.route.provider} / ${data.route.model} · 最多 4 次模型调用。先从这段对话的全部真人表达和介入前的 AI 摘录中选一个问题，再单凭问题类别起草规则。两次重做只读取选入的要求、开工文件和各自的 AGENTS.md。` : '这段会话还缺少可用的 DSH 模型。'}</p>
        <p className="cj-replay-hint">复演只生成文件。要求现场运行命令或查看其他文件时，模型可能无法完成。</p>
      </div>}
      {data.run && data.run.status !== 'completed' && <div className="cj-replay-progress" role="status">
        <p><b>{{running:'正在复演',failed:'复演未完成',interrupted:'复演已中断',skipped:'这次没有适合的规则'}[data.run.status] || data.run.status}</b>
          {data.run.stage && ` · ${data.run.stage}`} · 已调用 {data.run.modelCalls ?? 0} 次</p>
        {data.run.error && <p>{data.run.error}</p>}
        {data.run.status === 'failed' && <p>{result ? '已保留上次完成的文件和评价。' : '这轮没有生成完整对照，已保留收藏和复演材料。'}</p>}
        {data.run.reason && <p>{data.run.reason}</p>}
        {running && <button disabled={!!busy} onClick={() => act('replayCancel')}>停止复演</button>}
      </div>}
      {result && <Result key={result.runId} run={result} current={data.scene} previous={result.runId !== data.run?.runId}
        saving={!!busy} onReview={values => act('replayReview', {runId:result.runId, ...values})}/>}
    </>}
  </>;
}

const shortSha = sha => sha.slice(0, 8);
const isCommit = value => /^[0-9a-f]{40}$/i.test(value);

function SceneInfo({ scene }) {
  return <p className="cj-replay-hint">开工 <code title={scene.base}>{shortSha(scene.base)}</code> · 认可交付 <code title={scene.reference}>{shortSha(scene.reference)}</code> · {scene.paths.join('、')}</p>;
}

function RequestList({ humans, extraSeqs }) {
  const selected = [humans[0], ...humans.slice(1).filter(item => extraSeqs.includes(item.seq))].filter(Boolean);
  return <div className="cj-replay-requests">{selected.map((item, index) => <details key={item.seq}>
    <summary>{index ? '新增要求' : '原始要求'} · #{item.seq}</summary><pre>{item.text}</pre>
  </details>)}</div>;
}

function SceneEditor({ id, data, request, saving, onSave, onCancel }) {
  const scene = data.scene;
  const [base, setBase] = useState(scene?.base || '');
  const [reference, setReference] = useState(scene?.reference || '');
  const [paths, setPaths] = useState(scene?.paths || []);
  const [extraSeqs, setExtraSeqs] = useState(scene?.extraSeqs || []);
  const [commitChoices, setCommitChoices] = useState([]);
  const [commitError, setCommitError] = useState('');
  const [index, setIndex] = useState(null);
  const [search, setSearch] = useState('');
  const [attempt, setAttempt] = useState(0);
  const fieldId = useId();
  const readId = JSON.stringify([base, reference]);
  const versionsReady = isCommit(base) && isCommit(reference) && base !== reference;
  const matches = index?.id === readId ? index : null;
  const ready = versionsReady && !!matches?.choices && paths.length > 0 && paths.every(path => matches.choices.includes(path)) && data.humans.length > 0;
  const fileLimit = 8;

  useEffect(() => {
    const controller = new AbortController();
    request('replayCommits', {id}, controller.signal).then(value => {
      if (!controller.signal.aborted) setCommitChoices(value.commits);
    }).catch(cause => { if (!controller.signal.aborted) setCommitError(cause.message); });
    return () => controller.abort();
  }, [id, request]);
  useEffect(() => {
    if (!versionsReady) return;
    const controller = new AbortController();
    request('replayPaths', {id, base, reference}, controller.signal).then(value => {
      if (!controller.signal.aborted) setIndex({id:readId, choices:value.paths});
    }).catch(cause => {
      if (!controller.signal.aborted) setIndex({id:readId, error:cause.message});
    });
    return () => controller.abort();
  }, [id, request, base, reference, readId, versionsReady, attempt]);

  function changeVersion(setter, value) {
    setter(value.trim().toLowerCase());
    setPaths([]);
    setSearch('');
    setIndex(null);
  }
  function toggle(value, selected, setSelected) {
    setSelected(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]);
  }
  const versions = [
    {label:'开工时的代码', id:'base', value:base, change:setBase},
    {label:'我认可的交付', id:'reference', value:reference, change:setReference}
  ];
  const filteredPaths = matches?.choices?.filter(path => path.toLowerCase().includes(search.toLowerCase())) || [];
  return <form className="cj-replay-form" onSubmit={event => {
    event.preventDefault();
    if (ready && !saving) onSave({base, reference, paths, extraSeqs});
  }}>
    <fieldset disabled={saving}><legend>确认两个版本</legend>
      <p className="cj-replay-hint">从这段会话附近的 Git 提交中选择，也可以粘贴完整提交号。复演只还原所选提交里保存的文件。</p>
      {commitError && <p className="cj-replay-hint" role="status">{commitError}</p>}
      <div className="cj-replay-pair">{versions.map(version => <div key={version.id}>
        <label htmlFor={fieldId + version.id}>{version.label}</label>
        {commitChoices.length > 0 && <select aria-label={version.label + '的提交列表'}
          value={commitChoices.some(commit => commit.sha === version.value) ? version.value : ''}
          onChange={event => changeVersion(version.change, event.target.value)}>
          <option value="">选择一次提交</option>
          {commitChoices.map(commit => <option key={commit.sha} value={commit.sha}>{new Date(commit.date).toLocaleDateString('zh-CN')} · {commit.title} · {shortSha(commit.sha)}</option>)}
        </select>}
        <input id={fieldId + version.id} placeholder="粘贴 40 位提交号" spellCheck={false}
          value={version.value} onChange={event => changeVersion(version.change, event.target.value)}/>
      </div>)}</div>
      {isCommit(base) && base === reference && <p role="status" className="cj-replay-hint">开工版本和认可交付相同，请核对提交。</p>}
    </fieldset>
    {versionsReady && <fieldset disabled={saving}><legend>哪些文件体现了这次交付？</legend>
      {matches?.error ? <p role="alert">{matches.error} <button type="button" onClick={() => {setIndex(null); setAttempt(value => value + 1);}}>重读文件</button></p> :
        !matches ? <p className="cj-replay-hint" role="status">正在读取两个提交的文件…</p> : <>
          <p className="cj-replay-hint">已选 {paths.length} / {fileLimit}。可选择开工时已有的代码文件。模型会从这些文件的开工版本生成两份交付。</p>
          {matches.choices.length > 12 && <input aria-label="筛选复演文件" type="search" value={search} placeholder="按文件名筛选…" onChange={e => setSearch(e.target.value)}/>}
          <div className="cj-replay-choices">{filteredPaths.map(path => <label key={path}>
            <input type="checkbox" checked={paths.includes(path)} disabled={!paths.includes(path) && paths.length >= fileLimit}
              onChange={() => toggle(path, paths, setPaths)}/><span>{path}</span>
          </label>)}</div>
          {!filteredPaths.length && <p className="cj-replay-hint">{search ? '没有匹配的文件' : '开工版本中没有可用于复演的小型文本文件。'}</p>}
        </>}
    </fieldset>}
    <fieldset disabled={saving}><legend>复演时给 AI 的要求</legend>
      {data.humans.length ? <RequestList humans={[data.humans[0]]} extraSeqs={[]}/> : <p className="cj-replay-hint">这段会话没有可复演的人的表达。</p>}
      {data.humans.length > 1 && <details className="cj-replay-followups"><summary>选择后来新增的要求 · 已选 {extraSeqs.length} 条</summary>
        <p className="cj-replay-hint">只勾选后来才提出的需求或背景。这些原话会随首条要求一起交给 AI。原来的纠偏和验收反馈可留作对照。</p>
        <div className="cj-replay-choices">{data.humans.slice(1).map(item => <label key={item.seq}>
          <input type="checkbox" checked={extraSeqs.includes(item.seq)} onChange={() => toggle(item.seq, extraSeqs, setExtraSeqs)}/>
          <span><small>#{item.seq}</small> {item.text}</span>
        </label>)}</div>
      </details>}
    </fieldset>
    <div className="cj-replay-actions"><button type="submit" className="cj-primary" disabled={!ready || saving}>{saving ? '正在保存…' : '保存复演材料'}</button>
      <button type="button" disabled={saving} onClick={onCancel}>取消</button></div>
  </form>;
}

const decisions = [
  ['candidate','这版我会收'],
  ['reference','更喜欢原版'],
  ['tie','两版都可以'],
  ['neither','两版都需改']
];

function FileText({ file }) {
  if (!file) return <p className="cj-replay-hint">没有该文件的快照</p>;
  if (file.text === null) return <p className="cj-replay-hint">该版本没有此文件</p>;
  if (file.text === '') return <p className="cj-replay-hint">空文件</p>;
  return <pre tabIndex={0}>{file.text}</pre>;
}

function Result({ run, current, previous, saving, onReview }) {
  const [path, setPath] = useState(run.scene.paths[0]);
  const [choice, setChoice] = useState(run.review?.choice || '');
  const [note, setNote] = useState(run.review?.note || '');
  const saved = run.review;
  const changed = choice !== (saved?.choice || '') || note !== (saved?.note || '');
  const scene = run.scene;
  const different = !current || ['base','reference'].some(key => current[key] !== scene[key]) ||
    ['paths','extraSeqs'].some(key => JSON.stringify(current[key]) !== JSON.stringify(scene[key]));
  const humanChoice = decisions.find(([key]) => key === saved?.choice)?.[1];
  return <section className="cj-replay-result" aria-label="复演交付对照">
    <header className="cj-replay-heading"><h4>{previous ? '上次完成的文件对照' : '文件对照'}</h4><span>{run.modelCalls} 次模型调用</span></header>
    {different && <p className="cj-notice">这份结果使用了另一组复演材料。</p>}
    <details><summary>查看这次的规则与材料</summary><SceneInfo scene={scene}/>
      {run.rule && <><p className="cj-replay-hint">副本中追加到 {run.rule.path} 的规则</p><blockquote>{run.rule.text}</blockquote><p>{run.rule.reason}</p></>}
    </details>
    <label className="cj-replay-file-select">对照文件 <select value={path} onChange={event => setPath(event.target.value)}>
      {scene.paths.map(value => <option key={value}>{value}</option>)}</select></label>
    <div className="cj-replay-pair cj-replay-outputs">
      <section aria-label="原认可交付"><h5>原认可交付</h5><FileText file={scene.referencePaths.find(file => file.path === path)}/></section>
      <section aria-label="新规则交付"><h5>新规则交付</h5><FileText file={run.candidate.files.find(file => file.path === path)}/></section>
    </div>
    <details><summary>查看同一起点用旧规则重做的文件</summary><FileText file={run.baseline.files.find(file => file.path === path)}/></details>
    <p className="cj-replay-hint">这里对照文件内容。页面效果、构建和运行行为仍需实际验证。</p>
    <form className="cj-replay-review" onSubmit={event => {
      event.preventDefault();
      if (choice && changed && !saving) void onReview({choice, note});
    }}>
      <fieldset disabled={saving}><legend>如果当时拿到这版，你会收吗？</legend>
        <div className="cj-replay-votes">{decisions.map(([value, label]) => <label key={value}>
          <input type="radio" name={'review-' + run.runId} checked={choice === value} onChange={() => setChoice(value)}/>{label}
        </label>)}</div>
        <label className="cj-replay-note">评语（选填）<textarea rows={2} maxLength={1000} value={note} onChange={event => setNote(event.target.value)}/></label>
      </fieldset>
      <div className="cj-replay-actions"><button type="submit" disabled={!choice || !changed || saving}>保存我的判断</button>
        <span role="status">{humanChoice ? `已保存 · ${humanChoice}` : '尚未评价'}</span></div>
    </form>
  </section>;
}
