// Advisory measurements never select arbitrary encoder settings. The native
// host owns three levels, each bounded by its immutable manual launch limits.
export function validVideoFeedback(s) {
  return s && typeof s === 'object' && !Array.isArray(s)
    && Object.keys(s).every(k => ['type', 'sequence', 'durationMs', 'frames', 'dropped', 'decodeMs', 'queue', 'lossPct', 'rttMs'].includes(k))
    && s.type === 'video-feedback' && Number.isSafeInteger(s.sequence) && s.sequence > 0
    && Number.isFinite(s.durationMs) && s.durationMs >= 500 && s.durationMs <= 5000
    && ['frames','dropped'].every(k => Number.isInteger(s[k]) && s[k] >= 0 && s[k] <= 2000)
    && Number.isInteger(s.queue) && s.queue >= 0 && s.queue <= 32
    && [['decodeMs', 1000], ['lossPct',100], ['rttMs',5000]].every(([k,max]) => s[k] === null || Number.isFinite(s[k]) && s[k] >= 0 && s[k] <= max);
}

export function createAdaptiveVideo({ now = () => Date.now(), level = 0 } = {}) {
  let sequence = 0, sampled = -Infinity, changed = -Infinity, bad = 0, good = 0, baseRtt = null;
  function reset() { sequence = 0; sampled = -Infinity; bad = good = 0; baseRtt = null; }
  function sample(s, bufferedBytes = 0) {
    if (!validVideoFeedback(s) || s.sequence <= sequence) return null;
    const time = now();
    if (!Number.isFinite(time) || time - sampled < 750) return null;
    sequence = s.sequence; sampled = time;
    if (s.rttMs !== null) baseRtt = baseRtt === null ? s.rttMs : Math.min(baseRtt, s.rttMs);
    const risingRtt = s.rttMs !== null && s.rttMs - baseRtt >= Math.max(200, baseRtt);
    // An idle desktop is not a slow decoder. Require actual frame work before
    // raising quality; queue/network pressure can still lower it independently.
    const work = s.frames + s.dropped;
    const congested = bufferedBytes >= 262144 || s.queue >= 3 || s.lossPct >= 5
      || risingRtt || work >= 5 && (s.dropped / work >= 0.15 || s.decodeMs >= 60);
    const healthy = work >= 5 && s.queue <= 1 && (s.lossPct === null || s.lossPct < 1)
      && (s.rttMs === null || s.rttMs - baseRtt < 100) && (s.decodeMs === null || s.decodeMs < 25)
      && s.dropped / work < 0.02 && bufferedBytes < 65536;
    bad = congested ? bad + 1 : 0; good = healthy ? good + 1 : 0;
    if (time - changed < 5000) return null;
    if (bad >= 2 && level < 2) { level++; changed = time; bad = good = 0; return level; }
    if (good >= 10 && level > 0) { level--; changed = time; bad = good = 0; return level; }
    return null;
  }
  function manual() { level = 0; changed = now(); reset(); return 0; }
  return { sample, reset, manual, get level() { return level; } };
}
