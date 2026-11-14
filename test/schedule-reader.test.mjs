import assert from 'node:assert/strict';
import test from 'node:test';
import { observeSchedule, scheduleSavedEvent } from '../src/schedule-reader.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const done = { date: '2026-11-14', at: 100, status: 'completed' };

function reader(request) {
  const host = new EventTarget(), page = new EventTarget(), timers = new Set();
  host.setTimeout = callback => { timers.add(callback); return callback; };
  host.clearTimeout = timer => timers.delete(timer);
  let refreshes = 0;
  const stop = observeSchedule({host, page, request, onTerminal: () => { refreshes++; }});
  return {
    host, page, timers, stop, get refreshes() { return refreshes; },
    async fire() {
      assert.equal(timers.size, 1);
      const [callback] = timers;
      timers.delete(callback);
      await callback();
    },
  };
}

test('reader refreshes once per new finished schedule, even when the job ran between polls', async () => {
  let state = {enabled: false, lastRun: done};
  const calls = [];
  const h = reader(async action => { calls.push(action); return state; });
  await settle();
  assert.equal(h.refreshes, 0);
  assert.equal(h.timers.size, 0);
  state = {...state, enabled: true};
  h.host.dispatchEvent(new Event(scheduleSavedEvent)); await settle();
  assert.equal(h.timers.size, 1);
  state.lastRun = {...done, date: '2026-11-15', at: 200, status: 'running'};
  await h.fire();
  assert.equal(h.refreshes, 0);
  state.lastRun = {...done, date: '2026-11-15', at: 300};
  await h.fire(); await h.fire();
  assert.equal(h.refreshes, 1);
  state.lastRun = {...done, date: '2026-11-16', at: 500, status: 'failed'};
  await h.fire(); assert.equal(h.refreshes, 2);
  state.enabled = false;
  h.host.dispatchEvent(new Event(scheduleSavedEvent)); await settle();
  assert.equal(h.timers.size, 0);
  assert.ok(calls.every(action => action === 'getSchedule'));
  h.stop();
});

test('backgrounding cancels an inflight check and resuming compares against the last visible result', async () => {
  let state = {enabled: true, lastRun: null}, hold = false, release, pendingSignal, calls = 0;
  const h = reader(async (_action, _params, signal) => {
    calls++;
    if (hold) {
      pendingSignal = signal;
      return new Promise(resolve => { release = resolve; });
    }
    return state;
  });
  await settle();
  hold = true; const pending = h.fire();
  h.page.hidden = true; h.page.dispatchEvent(new Event('visibilitychange'));
  assert.equal(pendingSignal.aborted, true);
  hold = false; state = {...state, lastRun: done};
  h.page.hidden = false; h.page.dispatchEvent(new Event('visibilitychange')); await settle();
  release({enabled: true, lastRun: {...done, at: 99}}); await pending;
  assert.equal(h.refreshes, 1);
  assert.equal(h.timers.size, 1);
  h.stop();
  h.host.dispatchEvent(new Event('focus')); await settle();
  assert.equal(calls, 3);
  assert.equal(h.timers.size, 0);
});
