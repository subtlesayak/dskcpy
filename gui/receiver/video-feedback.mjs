// Per-socket counters only. No device/network identifiers, SDP, addresses,
// storage, audio statistics or remote input are collected.
export function createVideoFeedback({ read, active, send, now = () => performance.now(), setTimer = setInterval, clearTimer = clearInterval }) {
  let stopped = false, busy = false, previous, sequence = 0, revision = 0;
  function reset() { revision++; previous = undefined; }
  async function poll() {
    if (stopped || busy) return;
    if (!active()) { reset(); return; }
    const mine = revision;
    busy = true;
    try {
      const value = await read(), time = now();
      if (stopped || mine !== revision || !active()) { previous = undefined; return; }
      if (!value) { previous = undefined; return; }
      const before = previous; previous = { ...value, time };
      if (!before || value.epoch !== before.epoch) return;
      const durationMs = time - before.time, frames = value.frames - before.frames, dropped = value.dropped - before.dropped;
      if (!Number.isFinite(durationMs) || durationMs < 500 || durationMs > 5000 || !Number.isInteger(frames) || !Number.isInteger(dropped) || frames < 0 || dropped < 0 || frames > 2000 || dropped > 2000) return;
      const decodeMs = frames && value.totalDecodeMs >= before.totalDecodeMs ? (value.totalDecodeMs - before.totalDecodeMs) / frames : null;
      const packets = value.packets - before.packets, lost = value.lost - before.lost;
      const lossPct = Number.isFinite(packets) && packets >= 0 && lost >= 0 && packets + lost > 0 ? 100 * lost / (packets + lost) : null;
      send({type:'video-feedback',sequence:++sequence,durationMs,frames,dropped,
        decodeMs: decodeMs === null ? null : Math.min(1000,decodeMs), queue:Math.min(32,Math.max(0,Math.trunc(value.queue || 0))),lossPct,
        rttMs:Number.isFinite(value.rttMs) && value.rttMs >= 0 ? Math.min(5000,value.rttMs) : null});
    } catch { previous = undefined; } finally { busy = false; }
  }
  const timer = setTimer(poll, 2000);
  return { poll, reset, close() { stopped = true; reset(); clearTimer(timer); } };
}
