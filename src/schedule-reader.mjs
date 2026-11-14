export const scheduleSavedEvent = 'dsh-collab-journal:schedule-saved';

// A foreground reader asks only for the latest schedule record. Opening the
// reader already loads its content, so a historical terminal run is a baseline.
export function observeSchedule({ request, onTerminal, page = document, host = window }) {
  let observed = false;
  let lastTerminal = '';
  let enabled;
  let activeRequest;
  let timer;
  let stopped = false;

  function stopReading() {
    host.clearTimeout(timer);
    activeRequest?.abort();
    activeRequest = null;
  }

  async function check() {
    if (stopped || page.hidden || activeRequest) return;
    host.clearTimeout(timer);
    const controller = new AbortController();
    activeRequest = controller;
    let interval = 30000;
    try {
      const result = await request('getSchedule', {}, controller.signal);
      if (controller.signal.aborted) return;
      enabled = result.enabled;
      const run = result.lastRun;
      if (run?.status === 'running' || run?.status === 'waiting') {
        interval = 5000;
      } else if (run) {
        const key = JSON.stringify([run.date, run.status, run.at]);
        if (observed && key !== lastTerminal) onTerminal();
        lastTerminal = key;
      }
      observed = true;
    } catch {
      // A temporary status read failure does not affect the visible reader.
    } finally {
      if (activeRequest === controller) {
        activeRequest = null;
        if (enabled !== false && !stopped && !page.hidden) timer = host.setTimeout(check, interval);
      }
    }
  }

  function visibilityChanged() {
    if (page.hidden) stopReading();
    else void check();
  }
  function settingsSaved() {
    stopReading();
    void check();
  }
  host.addEventListener('focus', check);
  host.addEventListener(scheduleSavedEvent, settingsSaved);
  page.addEventListener('visibilitychange', visibilityChanged);
  void check();
  return () => {
    stopped = true;
    stopReading();
    host.removeEventListener('focus', check);
    host.removeEventListener(scheduleSavedEvent, settingsSaved);
    page.removeEventListener('visibilitychange', visibilityChanged);
  };
}
