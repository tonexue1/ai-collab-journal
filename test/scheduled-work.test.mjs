import test from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../src/service.mjs';
import { DailySchedule } from '../src/schedule.mjs';
import { runScheduledWork } from '../src/scheduled-work.mjs';
import { daySummaryKey } from '../src/day-summary.mjs';

const scope = {date: '2026-11-14', timeZone: 'UTC', includeArchived: false};
const time = Date.parse('2026-11-14T08:00:00Z');

function human(seq, text) {
  return {seq, time: time + seq, type: 'user/message', data: {
    source: {kind: 'user'}, content: [{type: 'text', text}],
  }};
}
function reply(seq) {
  return {seq, time: time + seq, type: 'assistant/message', data: {message: {
    source: {provider: 'fixture', model: 'one'}, content: [{type: 'text', text: '尚未完成。'}],
  }}};
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function modelOutput(input) {
  if (input.kind === 'day-summary') {
    return {items: [{id: 'day', summary: '今天讨论了需要跟进的任务。', details: []}]};
  }
  const evidence = [{seq: input.anchor.seq, quote: input.anchor.text}];
  return {title: '安排任务', categories: [{label: '新任务', evidence}],
    before: {text: '前文证据不足，无法确定介入前状态。', evidence: []}, contribution: {text: '提出任务。', evidence}, certainty: 'unclear'};
}

function fixture() {
  const logs = new Map([
    ['a', [human(1, '请检查入口。'), reply(2)]],
    ['archived', [human(1, '归档的任务。'), reply(2)]],
  ]);
  const tables = new Map(), calls = [], hooks = {};
  const domain = {
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map());
      const records = tables.get(name);
      return {
        get: key => structuredClone(records.get(key)),
        async put(key, value) {
          assert.ok(!domain.closed, 'journal writes finished before storage closed');
          records.set(key, structuredClone(value));
        },
      };
    },
    close() { domain.closed = true; },
  };
  const ctx = {
    workspaceRegistry: {list: () => [{id: 'w', title: '工作区', sessionIds: [...logs.keys()]}], archivedSessionIds: ['archived']},
    sessionQuery: {
      listSessions: async () => [...logs.keys()].map(id => ({header: {id, origin: 'main'}})),
      readSession: async id => ({session: {id}, events: structuredClone(logs.get(id))}),
    },
    llm: {prepareCall: async config => ({config, async *stream(request) {
      const input = JSON.parse(request.messages[0].content[0].text);
      const call = {kind: input.kind === 'day-summary' ? 'summary' : 'intervention', input,
        sessionId: request.sessionId, signal: request.signal};
      calls.push(call);
      await hooks.onCall?.(call);
      yield {type: 'text-delta', index: 0, text: JSON.stringify(modelOutput(input))};
      yield {type: 'finish', reason: {kind: 'stop'}};
    }})},
  };
  const journal = new Journal(ctx, domain);
  return {journal, domain, logs, calls, hooks, tables, run: (signal = new AbortController().signal) => runScheduledWork(journal, scope, signal)};
}

test('classifies each selected human before summarizing, then reuses both levels until the day changes', async () => {
  const h = fixture();
  h.logs.set('b', [human(1, '请补充另一项说明。'), reply(2)]);
  assert.equal((await h.run()).status, 'completed');
  assert.deepEqual(h.calls.map(c => [c.kind, c.sessionId]), [['intervention', 'a'], ['intervention', 'b'], ['summary', 'a']]);
  const humans = h.calls.at(-1).input.sessions.flatMap(s => s.humans);
  assert.deepEqual(humans.map(item => [item.text, item.analysis.categories[0].evidence[0].quote]),
    [['请检查入口。', '请检查入口。'], ['请补充另一项说明。', '请补充另一项说明。']]);
  const original = await h.journal.daySummary(scope);
  assert.equal((await h.run()).status, 'skipped');
  assert.equal(h.calls.length, 3);
  assert.deepEqual((await h.journal.daySummary(scope)).summary, original.summary);
  h.logs.get('a').push(human(3, '请等我确认。'));
  assert.equal((await h.run()).status, 'completed');
  assert.deepEqual(h.calls.slice(3).map(c => [c.kind, c.input.anchor?.seq]), [['intervention', 3], ['summary', undefined]]);
  assert.equal((await h.journal.daySummary(scope)).summary.humanCount, 3);
});

test('one failed intervention keeps successful siblings and the previous day summary, then retries only the missing expression', async () => {
  const h = fixture();
  assert.equal((await h.run()).status, 'completed');
  const original = (await h.journal.daySummary(scope)).summary;
  h.logs.get('a').push(human(3, '保留两项。'), reply(4), human(5, '请继续核查。'));
  h.hooks.onCall = ({input}) => { if (input.anchor?.seq === 3) throw Error('fixture model unavailable'); };
  const failed = await h.run();
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /a/);
  assert.equal(h.calls.filter(c => c.kind === 'summary').length, 1);
  assert.deepEqual((await h.journal.daySummary(scope)).summary, original);
  const listing = await h.journal.interactions('a', scope);
  assert.deepEqual(listing.items.map(item => !!item.analysis), [true, false, true]);
  assert.equal(listing.analysisRun.errors[0].interactionId, 'h3');
  delete h.hooks.onCall;
  const beforeRetry = h.calls.length;
  assert.equal((await h.run()).status, 'completed');
  assert.deepEqual(h.calls.slice(beforeRetry).map(c => [c.kind, c.input.anchor?.seq]), [['intervention', 3], ['summary', undefined]]);
});

test('a date without human expressions skips both model stages', async () => {
  const h = fixture();
  const result = await runScheduledWork(h.journal, {...scope, date: '2026-11-13'}, new AbortController().signal);
  assert.equal(result.status, 'skipped');
  assert.equal(h.calls.length, 0);
});

test('a failed summary preserves the previous version and reuses the saved interventions on retry', async () => {
  const h = fixture();
  assert.equal((await h.run()).status, 'completed');
  const original = (await h.journal.daySummary(scope)).summary;
  h.logs.get('a').push(human(3, '再确认检查结果。'));
  h.hooks.onCall = ({kind}) => { if (kind === 'summary') throw Error('summary provider unavailable'); };
  assert.equal((await h.run()).status, 'failed');
  const retained = await h.journal.daySummary(scope);
  assert.deepEqual(retained.summary, original);
  assert.equal(retained.stale, true);
  const beforeRetry = h.calls.length;
  delete h.hooks.onCall;
  assert.equal((await h.run()).status, 'completed');
  assert.deepEqual(h.calls.slice(beforeRetry).map(c => c.kind), ['summary']);
});

test('a preparing session without a model does not prevent other sessions from keeping their valid results', async () => {
  const h = fixture();
  h.logs.get('a').pop();
  h.logs.set('b', [human(1, '检查另一个任务。'), reply(2)]);
  const result = await h.run();
  assert.equal(result.status, 'failed');
  assert.match(result.message, /a/);
  assert.deepEqual(h.calls.map(c => [c.kind, c.sessionId]), [['intervention', 'b']]);
  assert.equal(h.journal.active, null);
  assert.equal((await h.journal.daySummary(scope)).summary, null);
});

test('a pending manual analysis keeps its slot and is reused once it finishes', {timeout: 3000}, async () => {
  const h = fixture(), started = deferred(), release = deferred();
  h.hooks.onCall = async call => { started.resolve(call); await release.promise; };
  await h.journal.startInteractions('a', scope);
  const manual = h.journal.active, call = await started.promise;
  const controller = new AbortController();
  assert.equal((await h.run(controller.signal)).status, 'busy');
  controller.abort();
  assert.equal(call.signal.aborted, false);
  assert.equal(h.calls.length, 1);
  release.resolve();
  await manual.pending;
  assert.equal((await h.run()).status, 'completed');
  assert.deepEqual(h.calls.map(c => c.kind), ['intervention', 'summary']);
});

test('cancelling while a subsequent manual job owns the slot never aborts that new job', {timeout: 3000}, async () => {
  const h = fixture(), manualStarted = deferred(), releaseManual = deferred();
  const start = h.journal.startInteractions.bind(h.journal);
  // Keep the scheduled caller in its start promise while another real job takes the freed slot.
  h.journal.startInteractions = async (...args) => {
    await start(...args);
    await h.journal.active.pending;
    await start('archived', scope);
    await manualStarted.promise;
  };
  h.hooks.onCall = async call => {
    if (call.sessionId === 'archived') {
      manualStarted.resolve(call);
      await releaseManual.promise;
    }
  };
  const controller = new AbortController(), scheduled = h.run(controller.signal);
  const call = await manualStarted.promise, manual = h.journal.active;
  controller.abort(new Error('settings changed'));
  await assert.rejects(scheduled, /settings changed/);
  assert.equal(call.signal.aborted, false);
  assert.equal(manual.abort.signal.aborted, false);
  releaseManual.resolve();
  await manual.pending;
  assert.equal(manual.run.status, 'completed');
  assert.equal(h.calls.filter(c => c.kind === 'summary').length, 0);
});

for (const stage of ['intervention', 'summary']) {
  test(`closing the schedule drains its active ${stage} call before closing journal storage`, {timeout: 3000}, async () => {
    const h = fixture(), started = deferred(), release = deferred();
    h.hooks.onCall = async call => {
      if (call.kind === stage) { started.resolve(call); await release.promise; }
    };
    let clock = Date.parse('2026-11-14T20:59:00Z');
    const schedule = new DailySchedule(h.domain.table('schedule'), h.journal, runScheduledWork,
      {now: () => clock, setTimer: () => null, clearTimer() {}});
    await schedule.start();
    await schedule.set({enabled: true, time: '21:00', timeZone: 'UTC'});
    clock += 60_000;
    const running = schedule.tick();
    const call = await started.promise;
    const closing = schedule.close().then(() => h.journal.close());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(call.signal.aborted, true);
    assert.ok(!h.domain.closed);
    release.resolve();
    await Promise.all([running, closing]);
    assert.equal(h.domain.closed, true);
    assert.equal(schedule.get().lastRun.status, 'interrupted');
    assert.ok(!h.tables.get('day_summaries')?.has(daySummaryKey(scope)));
    assert.deepEqual(h.calls.map(c => c.kind), stage === 'summary' ? ['intervention', 'summary'] : ['intervention']);
  });
}
