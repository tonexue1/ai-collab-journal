import test from 'node:test';
import assert from 'node:assert/strict';
import { DailySchedule } from '../src/schedule.mjs';

const shanghai = { enabled: true, time: '21:00', timeZone: 'Asia/Shanghai' };
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { resolve, promise };
}
function harness({ saved, perform } = {}) {
  const disk = saved ?? new Map();
  const journal = {};
  const calls = [];
  const timers = new Set();
  let now = Date.parse('2026-11-14T12:59:20Z');
  const table = {
    get: key => structuredClone(disk.get(key)),
    put: async (key, value) => { disk.set(key, structuredClone(value)); },
  };
  const work = async (_journal, scope, signal) => {
    calls.push({ scope, signal });
    if (perform) return perform(scope, signal);
    return { status: 'completed', message: '已整理当天交互并生成总结。' };
  };
  const schedule = new DailySchedule(table, journal, work, {
    now: () => now,
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer),
  });
  return { disk, journal, calls, timers, schedule, table,
    at: iso => { now = Date.parse(iso); },
    async fire() {
      assert.equal(timers.size, 1);
      const [timer] = timers;
      timers.delete(timer);
      await timer.callback();
    },
  };
}

test('settings default off, validate user input and survive restart without starting work on save', async () => {
  const h = harness(); await h.schedule.start();
  assert.deepEqual(h.schedule.get(), { enabled: false, time: '21:00', timeZone: '', lastRun: null });
  assert.equal(h.timers.size, 0);
  for (const settings of [{ ...shanghai, time: '24:00' }, { ...shanghai, timeZone: 'bad/zone' }, { ...shanghai, enabled: 'false' }]) {
    await assert.rejects(h.schedule.set(settings), error => error.status === 400);
  }
  assert.deepEqual(await h.schedule.set(shanghai), { ...shanghai, lastRun: null });
  assert.equal(h.calls.length, 0);
  await h.fire(); assert.equal(h.calls.length, 0);
  await h.schedule.close(); assert.equal(h.timers.size, 0);
  const reopened = harness({ saved: h.disk }); await reopened.schedule.start();
  assert.deepEqual(reopened.schedule.get(), { ...shanghai, lastRun: null });
  await reopened.schedule.close();
});

test('a reached wall clock time processes only the current local day, at most once across ticks and cold restart', async () => {
  const h = harness(); await h.schedule.start(); await h.schedule.set(shanghai);
  h.at('2026-11-14T13:00:00Z'); await Promise.all([h.schedule.tick(), h.schedule.tick()]);
  assert.deepEqual(h.calls.map(call => call.scope), [{ date: '2026-11-14', timeZone: 'Asia/Shanghai', includeArchived: false }]);
  assert.equal(h.schedule.get().lastRun.status, 'completed');
  await h.schedule.close();
  const reopened = harness({ saved: h.disk }); reopened.at('2026-11-14T15:30:00Z'); await reopened.schedule.start();
  await reopened.fire(); assert.equal(reopened.calls.length, 0);
  reopened.at('2026-11-17T13:40:00Z'); await reopened.fire();
  assert.deepEqual(reopened.calls.map(call => call.scope.date), ['2026-11-17']);
  await reopened.schedule.close();
});

test('enabling after the chosen time or moving it into the past starts with the next day', async () => {
  const h = harness(); h.at('2026-11-14T13:00:20Z'); await h.schedule.start(); await h.schedule.set(shanghai);
  await h.fire(); assert.equal(h.calls.length, 0);
  await h.schedule.set({ ...shanghai, time: '22:00' });
  await h.schedule.set({ ...shanghai, time: '19:00' });
  await h.fire(); assert.equal(h.calls.length, 0);
  h.at('2026-11-15T11:00:00Z'); await h.fire(); assert.equal(h.calls.length, 1);
  await h.schedule.close();
});

test('manual ownership defers work, and a late conflict retries without consuming the day', async () => {
  let first = true;
  const h = harness({ perform: async () => {
    if (first) { first = false; return { status: 'busy', message: '等待正在运行的任务' }; }
    return { status: 'skipped', message: '当天内容已是最新。' };
  } });
  await h.schedule.start(); await h.schedule.set(shanghai); h.at('2026-11-14T13:00:00Z');
  h.journal.active = {}; await h.fire(); assert.equal(h.calls.length, 0); assert.equal(h.schedule.get().lastRun.status, 'waiting');
  h.journal.active = null; await h.fire(); assert.equal(h.schedule.get().lastRun.status, 'waiting');
  await h.fire(); assert.equal(h.schedule.get().lastRun.status, 'skipped');
  await h.fire(); assert.equal(h.calls.length, 2); await h.schedule.close();
});

test('a failed or abruptly interrupted attempt stays visible without automatic retries that day', async () => {
  const h = harness({ perform: async () => { throw Error('internal detail'); } });
  await h.schedule.start(); await h.schedule.set(shanghai); h.at('2026-11-14T13:00:00Z');
  await h.fire(); await h.fire(); assert.equal(h.calls.length, 1); assert.equal(h.schedule.get().lastRun.status, 'failed');
  await h.schedule.close();
  const [key, row] = [...h.disk][0]; row.lastRun.status = 'running'; h.disk.set(key, row);
  const reopened = harness({ saved: h.disk }); reopened.at('2026-11-14T14:00:00Z'); await reopened.schedule.start();
  await reopened.fire(); assert.equal(reopened.calls.length, 0); assert.equal(reopened.schedule.get().lastRun.status, 'interrupted');
  await reopened.schedule.close();
});

test('disabling cancels owned work and a late completion cannot overwrite the saved settings', async () => {
  const gate = deferred();
  const h = harness({ perform: () => gate.promise }); await h.schedule.start(); await h.schedule.set(shanghai);
  h.at('2026-11-14T13:00:00Z'); const pending = h.schedule.tick(); await turn();
  assert.equal(h.calls.length, 1); assert.equal(h.schedule.get().lastRun.status, 'running');
  await h.schedule.set({ ...shanghai, enabled: false }); assert.equal(h.calls[0].signal.aborted, true);
  assert.equal(h.timers.size, 0); gate.resolve({ status: 'completed', message: '过期的完成通知' }); await pending;
  assert.equal(h.schedule.get().lastRun.status, 'interrupted'); assert.equal(h.schedule.get().enabled, false);
  await h.schedule.close();
});

test('shutdown drains owned work and never dispatches a job before the day claim is durably written', async () => {
  const gate = deferred(), h = harness({ perform: () => gate.promise });
  await h.schedule.start(); await h.schedule.set(shanghai); h.at('2026-11-14T13:00:00Z');
  const put = h.table.put; h.table.put = async () => { throw Error('disk failure'); };
  await assert.rejects(h.schedule.tick()); assert.equal(h.calls.length, 0);
  h.table.put = put; const pending = h.schedule.tick(); await turn();
  let closed = false; const closing = h.schedule.close().then(() => { closed = true; }); await turn();
  assert.equal(closed, false); assert.equal(h.calls[0].signal.aborted, true);
  gate.resolve({ status: 'completed', message: '完成' }); await pending; await closing;
  assert.equal(h.schedule.get().lastRun.status, 'interrupted'); assert.equal(h.timers.size, 0);
});

test('retrying a terminal write never repeats model work and preserves the true outcome across settings changes', async () => {
  for (const next of ['tick', 'settings', 'next-date', 'close']) {
    const h = harness(); await h.schedule.start(); await h.schedule.set(shanghai);
    h.at('2026-11-14T13:00:00Z'); const put = h.table.put;
    h.table.put = async (key, row) => {
      if (row.lastRun?.status === 'completed') throw Error('disk temporarily unavailable');
      return put(key, row);
    };
    await assert.rejects(h.schedule.tick()); assert.equal(h.calls.length, 1);
    assert.equal([...h.disk.values()][0].lastRun.status, 'running');
    assert.equal(h.schedule.get().lastRun.status, 'completed', 'the previous work already finished');
    if (next === 'next-date') h.at('2026-11-15T13:00:00Z');
    h.table.put = put;
    if (next === 'settings') await h.schedule.set({ ...shanghai, enabled: false });
    else if (next === 'close') await h.schedule.close();
    else await h.schedule.tick();
    assert.equal(h.calls.length, 1, 'the retry only writes the pending state');
    const row = [...h.disk.values()][0]; assert.equal(row.lastRun.status, 'completed');
    assert.equal(row.lastRun.date, '2026-11-14'); assert.equal(row.enabled, next !== 'settings');
    if (next === 'next-date') { await h.schedule.tick(); assert.equal(h.calls.length, 2); }
    await h.schedule.close();
  }
});
