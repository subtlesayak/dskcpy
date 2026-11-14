const phases = ['host-check', 'install-start', 'install-ready', 'launch-start', 'launch-ready', 'socket-wait', 'socket-ready', 'transport-ready'];
const failures = new Set(['install-failed', 'launch-failed', 'socket-failed', 'control-failed', 'metadata-failed']);
const copy = value => value && ({ attempt: value.attempt, status: value.status, startedAt: value.startedAt,
  endedAt: value.endedAt, phase: value.phase, failure: value.failure, events: value.events.map(event => ({ ...event })) });

// Preserve fixed startup facts independently of the bounded raw-log ring.
// No raw lines, addresses, APK paths, scids, device names or error text survive.
export function createNativeStartupHistory({ now = () => new Date().toISOString() } = {}) {
  let current = null, previous = [];
  function clear() { if (current) current.closed = true; current = null; previous = []; }
  function begin({ retry = false } = {}) {
    if (retry && current) { current.closed = true; previous.push(copy(current)); previous = previous.slice(-3); }
    else clear();
    const record = { attempt: retry && previous.length ? Math.min(previous.at(-1).attempt + 1, 999) : 1,
      status: 'starting', startedAt: now(), endedAt: null, phase: 'host-check', failure: null, order: 0, events: [], closed: false };
    record.events.push({ phase: 'host-check', at: record.startedAt }); current = record;
    return {
      spawned() {
        if (current !== record || record.closed || record.order) return false;
        record.status = 'unreported'; return true;
      },
      observe(line) {
        if (current !== record || record.closed || record.status === 'failed' || typeof line !== 'string' || line.length > 256) return false;
        const match = /^(?:INFO|DEBUG|WARN|ERROR): Reverse startup: ([a-z-]+)$/.exec(line.replace(/\x1b\[[0-9;]*m/g, '').trim());
        if (!match) return false;
        const phase = match[1], order = phases.indexOf(phase);
        if (order > record.order) {
          record.order = order; record.phase = phase; record.events.push({ phase, at: now() });
          record.status = phase === 'transport-ready' ? 'connected' : 'starting';
          return true;
        }
        if (failures.has(phase) && record.status !== 'connected') {
          record.failure = phase; record.status = 'failed'; return true;
        }
        return false;
      },
      finish({ stopped = false, preflight = false } = {}) {
        if (current !== record || record.closed) return false;
        record.closed = true; record.endedAt = now();
        if (stopped) record.status = 'stopped';
        else if (preflight) { record.status = 'failed'; record.failure = 'host-check-failed'; }
        else if (!record.order) record.status = 'unreported';
        else if (record.status === 'connected') record.status = 'ended';
        else { record.status = 'failed'; record.failure ||= record.order ? 'connection-ended' : 'host-check-failed'; }
        return true;
      },
    };
  }
  return { begin, clear, snapshot: () => current ? { current: copy(current), previous: previous.map(copy) } : null };
}
