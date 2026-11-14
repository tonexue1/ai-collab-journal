import React, { useEffect, useId, useRef, useState } from 'react';
import { scheduleSavedEvent } from './schedule-reader.mjs';

export function PluginSettings({ request, timeZone, onClose }) {
  const id = useId();
  const dialog = useRef(null);
  const saveRequest = useRef(null);
  const saveVersion = useRef(0);
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [lastRun, setLastRun] = useState(null);
  const [statusUnavailable, setStatusUnavailable] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    request('getSchedule', {}, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const settings = { ...result, timeZone: result.timeZone || timeZone };
      setSaved(settings);
      setDraft(settings);
      setLastRun(result.lastRun);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [request, timeZone, readAttempt]);

  useEffect(() => () => saveRequest.current?.abort(), []);

  const loaded = saved !== null;
  useEffect(() => {
    if (!loaded || saving) return;
    const controller = new AbortController();
    let timer;
    async function refreshStatus() {
      const version = saveVersion.current;
      try {
        const result = await request('getSchedule', {}, controller.signal);
        if (!controller.signal.aborted && version === saveVersion.current) {
          setLastRun(result.lastRun);
          setStatusUnavailable(false);
        }
      } catch {
        if (!controller.signal.aborted && version === saveVersion.current) setStatusUnavailable(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refreshStatus, 10000);
      }
    }
    timer = setTimeout(refreshStatus, 10000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [loaded, request, saving]);

  const changed = !!draft && (draft.enabled !== saved.enabled || draft.time !== saved.time);

  function edit(changes) {
    setDraft(previous => ({ ...previous, ...changes }));
    setError('');
    setNotice('');
  }

  function cancel() {
    if (saveRequest.current) return;
    if (onClose) {
      dialog.current.close();
      onClose();
    } else {
      setDraft(saved);
      setError('');
      setNotice('');
    }
  }

  async function save(event) {
    event.preventDefault();
    if (!changed || saveRequest.current) return;
    const controller = new AbortController();
    saveVersion.current++;
    saveRequest.current = controller;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const { enabled, time, timeZone } = draft;
      const result = await request('setSchedule', { enabled, time, timeZone }, controller.signal);
      if (controller.signal.aborted) return;
      setSaved(result);
      setDraft(result);
      setLastRun(result.lastRun);
      setStatusUnavailable(false);
      window.dispatchEvent(new Event(scheduleSavedEvent));
      if (onClose) {
        dialog.current.close();
        onClose();
      } else {
        setNotice('设置已保存');
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message);
    } finally {
      saveRequest.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  const form = <form className="cj-settings-form" onSubmit={save}>
    {onClose && <h2 id={id + '-title'}>插件设置</h2>}
    {draft ? <>
      <div className="cj-settings-toggle">
        <div>
          <label htmlFor={id + '-enabled'}>每日定时整理</label>
          <p id={id + '-description'}>先整理当天新增或有变化的介入，再更新当日总结。</p>
        </div>
        <input type="checkbox" role="switch" className="cj-settings-switch" id={id + '-enabled'}
          aria-describedby={id + '-description'} checked={draft.enabled} disabled={saving}
          onChange={event => edit({ enabled: event.target.checked, time: draft.time || saved.time })}/>
      </div>
      {draft.enabled && <div className="cj-settings-time">
        <label htmlFor={id + '-time'}>每日运行时间</label>
        <input id={id + '-time'} type="time" step="60" required value={draft.time}
          disabled={saving} onInput={event => edit({ time: event.currentTarget.value })}/>
      </div>}
      <p className="cj-settings-hint">全部工作区 · 不含归档 · {draft.timeZone}<br/>定时整理需要 DSH 保持运行。</p>
      <div aria-live="polite">
        {lastRun && <p className="cj-settings-last">最近运行 · {lastRun.date} · {lastRun.message}</p>}
        {statusUnavailable && <p className="cj-settings-last">暂时无法更新运行状态。</p>}
      </div>
    </> : !error && <p role="status">正在读取设置…</p>}
    {error && <div className="cj-settings-error" role="alert">
      <p>{error}</p>
      {!draft && <button type="button" onClick={() => setReadAttempt(attempt => attempt + 1)}>重新读取</button>}
    </div>}
    <footer className="cj-settings-actions">
      <span role="status">{notice}</span>
      <button type="button" disabled={saving || (!onClose && !changed)} onClick={cancel}>取消</button>
      <button type="submit" className="cj-primary" disabled={!changed || saving}>{saving ? '正在保存…' : '保存设置'}</button>
    </footer>
  </form>;

  if (!onClose) return <section className="cj-root cj-native-settings" aria-label="插件设置">{form}</section>;
  return <dialog ref={dialog} className="cj-settings-dialog" aria-labelledby={id + '-title'}
    onCancel={event => { event.preventDefault(); cancel(); }}>{form}</dialog>;
}
