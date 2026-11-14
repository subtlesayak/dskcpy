// Original dskcpy decoder lifecycle implementation. No encoded frames are kept
// for replay: recovery discards pending input and asks the host for a fresh IDR.
export function createVideoReceiver({
  Decoder = globalThis.VideoDecoder, onFrame, onAck, onKeyframe, onError, onRecovery = () => {},
  suspended = false, setTimer = setTimeout, clearTimer = clearTimeout, now = () => performance.now(),
}) {
  let decoder, configuration, timer, drainTimer, epoch = 0, closed = false, flushing = false;
  let waitingKey = true, software = false, recoveries = 0;
  const pending = new Set();
  const submitted = new Map();
  let decoded = 0, discarded = 0, totalDecodeMs = 0;
  const timeoutMs = 5000, maximumRecoveries = 3;

  function retire() {
    ++epoch;
    clearTimer(timer); timer = undefined;
    clearTimer(drainTimer); drainTimer = undefined; flushing = false;
    const previous = decoder; decoder = undefined;
    if (previous && previous.state !== 'closed') previous.close();
    for (const timestamp of pending) onAck(timestamp);
    pending.clear(); waitingKey = true;
    discarded += submitted.size; submitted.clear();
  }
  function close() {
    if (closed) return;
    closed = true; retire();
  }
  function fail(message) {
    if (closed) return;
    close(); onError(message);
  }
  function active(mine) { return !closed && !suspended && mine === epoch; }
  function scheduleDrain(mine) {
    clearTimer(drainTimer); drainTimer = undefined;
    if (!pending.size || flushing || typeof decoder?.flush !== 'function') return;
    // The native sender allows only two unacknowledged pictures. A platform
    // decoder may buffer both despite optimizeForLatency, leaving sender and
    // decoder waiting for each other. Drain only after output has stalled;
    // normal decoders never pay for a flush or an extra keyframe.
    drainTimer = setTimer(() => {
      drainTimer = undefined;
      if (!active(mine) || !pending.size || flushing) return;
      flushing = true; waitingKey = true; deadline(mine);
      try {
        Promise.resolve(decoder.flush()).then(() => {
          if (!active(mine)) return;
          flushing = false;
          if (pending.size) { recover({ name: 'EncodingError' }, mine); return; }
          // flush() requires the next accepted chunk to be a keyframe. Drop
          // and acknowledge in-flight deltas, then request a fresh host IDR.
          deadline(mine); onKeyframe();
        }).catch((error) => recover(error, mine));
      } catch (error) { recover(error, mine); }
    }, 100);
  }
  function deadline(mine) {
    clearTimer(timer);
    timer = setTimer(() => {
      if (!active(mine)) return;
      // Some platform decoders accept input but never return a first frame.
      // Treat that as a decoder failure, just like an explicit EncodingError,
      // and try software once. A stalled probe or missing host keyframe is a
      // different failure: recreating the decoder cannot produce missing input.
      if (decoder && pending.size && !software && recoveries < maximumRecoveries) {
        recover({ name: 'EncodingError' }, mine);
      } else fail('Video recovery timed out. Reconnect or try a lower resolution.');
    }, timeoutMs);
  }
  function recover(error, mine) {
    if (!active(mine)) return;
    const reclaimed = error?.name === 'QuotaExceededError' || error?.name === 'InvalidStateError';
    const fallback = error?.name === 'EncodingError' && !software;
    if ((!reclaimed && !fallback) || recoveries >= maximumRecoveries) {
      fail('This browser could not decode the host H.264 stream. Try a lower resolution or another encoder.');
      return;
    }
    recoveries++;
    if (fallback) { software = true; onRecovery('Retrying video with software decoding…'); }
    void start();
  }
  async function start() {
    retire();
    if (closed || suspended || !configuration) return;
    const mine = epoch;
    const config = { ...configuration, ...(software ? { hardwareAcceleration: 'prefer-software' } : {}) };
    deadline(mine);
    try {
      const support = await Decoder.isConfigSupported(config);
      if (!active(mine)) return;
      if (!support.supported) {
        fail(software ? 'Software H.264 decoding is unavailable for this stream. Try a lower resolution.'
          : 'This browser does not support the host H.264 configuration. Try a lower resolution or another encoder.');
        return;
      }
      const current = new Decoder({
        error: (error) => recover(error, mine),
        output: (frame) => {
          try {
            if (!active(mine) || !pending.delete(frame.timestamp)) return;
            const at = submitted.get(frame.timestamp); submitted.delete(frame.timestamp);
            if (Number.isFinite(at)) { decoded++; totalDecodeMs += Math.max(0,now()-at); }
            if (!flushing) { clearTimer(timer); timer = undefined; }
            onFrame(frame); onAck(frame.timestamp);
            scheduleDrain(mine);
          } catch {
            fail('This browser could not display the decoded video. Reconnect to try again.');
          } finally { frame.close(); }
        },
      });
      decoder = current;
      current.configure(config);
      // A synchronous error callback may have retired this decoder.
      if (!active(mine)) return;
      deadline(mine); onKeyframe();
    } catch (error) { recover(error, mine); }
  }
  function configure(config) {
    if (closed) return;
    configuration = { ...config };
    void start();
  }
  function decode(chunk) {
    if (closed) return;
    if (suspended || !decoder || flushing || (waitingKey && chunk.type !== 'key')) {
      onAck(chunk.timestamp); return;
    }
    if (decoder.decodeQueueSize >= 3 || pending.size >= 3) {
      recover({ name: 'QuotaExceededError' }, epoch);
      onAck(chunk.timestamp); return;
    }
    const mine = epoch;
    pending.add(chunk.timestamp);
    submitted.set(chunk.timestamp, now());
    try {
      decoder.decode(chunk);
      if (active(mine)) { waitingKey = false; scheduleDrain(mine); }
    } catch (error) { recover(error, mine); }
  }
  function suspend() {
    if (closed || suspended) return;
    suspended = true; retire();
  }
  function resume() {
    if (closed || !suspended) return;
    suspended = false; void start();
  }
  return { configure, decode, suspend, resume, close, metrics: () => ({epoch,frames:decoded,dropped:discarded,totalDecodeMs,queue:pending.size}) };
}
