import { daySummaryKey } from './day-summary.mjs';

const busy = () => ({status: 'busy', message: '正在处理其他任务，稍后继续定时整理。'});
const incomplete = data => data.errors.length > 0 || data.unknownTimeCount > 0;
const needsAnalysis = session => session.humans.some(human => !human.analysis);

// Journal claims its job before the first await. Keep this particular job's
// handle so cancelling the schedule cannot abort a subsequent manual job.
async function finishOwnedJob(journal, slot, start, signal) {
  signal.throwIfAborted();
  const started = start();
  const job = journal[slot];
  const stop = () => job?.abort.abort(signal.reason);
  signal.addEventListener('abort', stop, {once: true});
  try {
    await started;
    await job.pending;
    signal.throwIfAborted();
    return job.run;
  } finally {
    signal.removeEventListener('abort', stop);
    await job?.pending;
  }
}

export async function runScheduledWork(journal, scope, signal) {
  const occupied = () => journal.active || journal.dailyActive;
  if (occupied()) return busy();
  let data = await journal.collectDaySummary(scope, signal);
  signal.throwIfAborted();
  if (incomplete(data)) return {status: 'failed', message: data.reason};
  if (!data.coverage.humanCount) return {status: 'skipped', message: '当天没有人的表达。'};

  let saved = 0;
  const failures = [];
  const sessions = data.input.sessions.filter(needsAnalysis);
  for (const session of sessions) {
    signal.throwIfAborted();
    if (occupied()) return busy();
    if (journal.ctx.workspaceRegistry.archivedSessionIds.includes(session.sessionId)) continue;
    try {
      const run = await finishOwnedJob(journal, 'active', () =>
        journal.startInteractions(session.sessionId, {date: scope.date, timeZone: scope.timeZone}, {scheduled: true}), signal);
      saved += run.completed;
      if (run.status === 'cancelled') return {status: 'failed', message: '介入整理已暂停，已保存的结果可继续阅读。'};
      if (run.status !== 'completed') {
        const protectedInput = run.errors.some(error => error.code === 'SCHEDULE_PROTECTED_INPUT');
        failures.push({id: session.sessionId, protectedInput});
      }
    } catch (error) {
      signal.throwIfAborted();
      if (error.status === 409) return busy();
      failures.push({id: session.sessionId, protectedInput: false});
    }
  }
  if (failures.length) {
    const reason = failures.some(failure => failure.protectedInput) ? '部分介入的前文含本机登录凭证，已跳过。' : '';
    return {status: 'failed', message:
      `已整理 ${saved} 次介入，${failures.length} 段会话未能整理完（${failures[0].id}）。${reason}当日总结未更新。`};
  }

  if (sessions.length) data = await journal.collectDaySummary(scope, signal);
  signal.throwIfAborted();
  if (occupied()) return busy();
  if (incomplete(data)) return {status: 'failed', message: data.reason};
  if (!data.coverage.humanCount) return {status: 'skipped', message: '当天没有人的表达。'};
  if (data.input.sessions.some(needsAnalysis)) {
    return {status: 'busy', message: '整理期间有新的介入，稍后继续。'};
  }
  const previous = journal.domain.table('day_summaries').get(daySummaryKey(scope));
  if (previous?.sourceFingerprint === data.sourceFingerprint) {
    return {status: 'skipped', message: '当天的介入和总结已是最新。'};
  }
  if (data.reason) return {status: 'failed', message: data.reason};
  const run = await finishOwnedJob(journal, 'dailyActive', () =>
    journal.generateDaySummary(scope, data), signal);
  if (run.status !== 'completed') {
    return {status: 'failed', message: `介入已整理，当日总结未更新。${run.error || run.stage}`};
  }
  return {status: 'completed', message: saved
    ? `已整理 ${saved} 次介入，并更新当日总结。` : '当天的介入已是最新，已更新当日总结。'};
}
