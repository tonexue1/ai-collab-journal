import { JournalError } from './service.mjs';
import { shiftDay } from './day-navigation.mjs';

const key = 'daily';
const defaults = { enabled: false, time: '21:00', timeZone: '', firstEligibleDate: '', lastRun: null };

function localClock(timestamp, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function validate({ enabled, time, timeZone }) {
  if (typeof enabled !== 'boolean') throw new JournalError('请选择定时开关');
  if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new JournalError('运行时间须为 00:00 至 23:59');
  }
  if (typeof timeZone !== 'string' || !timeZone) throw new JournalError('请选择有效的时区');
  try {
    timeZone = new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone;
  } catch {
    throw new JournalError('请选择有效的时区');
  }
  return { enabled, time, timeZone };
}

/** Owns the daily claim and clock for one DSH host. The work function owns only its own journal jobs. */
export class DailySchedule {
  constructor(table, journal, work, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.table = table;
    this.journal = journal;
    this.work = work;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = defaults;
    this.changes = Promise.resolve();
    this.closed = false;
  }

  async start() {
    this.state = this.table.get(key) ?? defaults;
    if (this.state.lastRun?.status === 'running') {
      await this.persist({ ...this.state, lastRun: { ...this.state.lastRun, status: 'interrupted',
        at: this.now(), message: '上次定时任务随宿主退出而中断，已保存的结果仍可阅读。' } });
    }
    this.arm(true);
  }

  get() {
    const { enabled, time, timeZone } = this.state;
    const lastRun = this.unsavedRun
      ? { ...this.unsavedRun, message: `${this.unsavedRun.message}（运行记录待保存）` }
      : this.state.lastRun;
    return { enabled, time, timeZone, lastRun: structuredClone(lastRun) };
  }

  // Serialize setting edits and claim/result writes, without holding the queue during a model request.
  change(operation) {
    const pending = this.changes.then(operation);
    this.changes = pending.catch(() => {});
    return pending;
  }

  async persist(state) {
    await this.table.put(key, state);
    this.state = state;
    this.unsavedRun = null;
  }

  async set(input) {
    const settings = validate(input);
    return this.change(async () => {
      if (this.closed) throw new JournalError('插件正在卸载', 503);
      const previous = this.state;
      if (settings.enabled === previous.enabled && settings.time === previous.time && settings.timeZone === previous.timeZone) {
        return this.get();
      }
      const now = this.now(), clock = localClock(now, settings.timeZone);
      const firstEligibleDate = clock.time < settings.time ? clock.date : shiftDay(clock.date, 1);
      let lastRun = this.unsavedRun ?? previous.lastRun;
      if (lastRun?.status === 'running') {
        lastRun = { ...lastRun, status: 'interrupted', message: '设置已更改，本次定时任务已停止。', at: now };
      } else if (lastRun?.status === 'waiting') {
        lastRun = null;
      }
      await this.persist({ ...settings, firstEligibleDate, lastRun });
      this.control?.abort(new Error('定时设置已更改'));
      this.arm();
      return this.get();
    });
  }

  arm(immediate = false) {
    this.clearTimer(this.timer);
    if (this.closed || !this.state.enabled) return;
    const delay = immediate ? 0 : 60_000 - this.now() % 60_000;
    this.timer = this.setTimer(async () => {
      try { await this.tick(); }
      catch { console.warn('[dsh-collab-journal] 定时任务记录写入失败，请检查 DSH 存储。'); }
      finally { this.arm(); }
    }, delay);
    this.timer?.unref?.();
  }

  tick() {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.resolve();
    const control = new AbortController();
    this.control = control;
    this.pending = this.execute(control.signal).finally(() => {
      this.pending = null;
      this.control = null;
    });
    return this.pending;
  }

  async execute(signal) {
    const scope = await this.change(async () => {
      const state = this.state;
      // A completed job is not a new attempt. Drain its record before claiming
      // any other day, even if the previous write failed across midnight.
      if (this.unsavedRun) {
        await this.persist({ ...state, lastRun: this.unsavedRun });
        return;
      }
      if (signal.aborted || !state.enabled) return;
      const now = this.now(), { date, time } = localClock(now, state.timeZone);
      if (date < state.firstEligibleDate || time < state.time) return;
      if (state.lastRun?.date >= date && state.lastRun.status !== 'waiting') return;
      if (this.journal.active || this.journal.dailyActive) {
        if (state.lastRun?.date !== date || state.lastRun.status !== 'waiting') {
          await this.persist({ ...state, lastRun: { date, at: now, status: 'waiting', message: '正在等待当前任务结束。' } });
        }
        return;
      }
      // A crash after this write consumes today's attempt. Never double-send a model request on restart.
      await this.persist({ ...state, lastRun: { date, at: now, status: 'running', message: '正在整理当天的介入和总结。' } });
      return { date, timeZone: state.timeZone, includeArchived: false };
    });
    if (!scope) return;
    let result;
    try {
      signal.throwIfAborted();
      result = await this.work(this.journal, scope, signal);
    } catch {
      result = { status: 'failed', message: '定时整理未完成，已保存的结果仍可阅读。' };
    }
    return this.change(async () => {
      const state = this.state;
      if (state.lastRun?.status !== 'running' || state.lastRun.date !== scope.date) return;
      let { status, message } = result;
      if (signal.aborted) {
        status = 'interrupted';
        message = '定时任务已停止，已保存的结果仍可阅读。';
      } else if (status === 'busy') {
        status = 'waiting';
      }
      this.unsavedRun = { date: scope.date, at: this.now(), status, message };
      await this.persist({ ...state, lastRun: this.unsavedRun });
    });
  }

  async close() {
    this.closed = true;
    this.clearTimer(this.timer);
    this.control?.abort(new Error('插件已卸载'));
    await Promise.allSettled([this.pending, this.changes]);
    if (this.unsavedRun) await this.persist({ ...this.state, lastRun: this.unsavedRun });
  }
}
