// Original dskcpy decoder lifecycle implementation. No encoded frames are kept
// for replay: recovery discards pending input and asks the host for a fresh IDR.
export function createVideoReceiver({
  Decoder = globalThis.VideoDecoder, onFrame, onAck, onKeyframe, onError,
  suspended = false, setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let decoder, configuration, timer, epoch = 0, closed = false;
  let waitingKey = true, software = false, recoveries = 0;
  const pending = new Set();
  const timeoutMs = 5000, maximumRecoveries = 3;

  function retire() {
    ++epoch;
    clearTimer(timer); timer = undefined;
    const previous = decoder; decoder = undefined;
    if (previous && previous.state !== 'closed') previous.close();
    for (const timestamp of pending) onAck(timestamp);
    pending.clear(); waitingKey = true;
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
  function deadline(mine) {
    clearTimer(timer);
    timer = setTimer(() => {
      if (active(mine)) fail('Video recovery timed out. Reconnect or try a lower resolution.');
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
    if (fallback) software = true;
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
            clearTimer(timer); timer = undefined;
            onFrame(frame); onAck(frame.timestamp);
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
    if (suspended || !decoder || (waitingKey && chunk.type !== 'key')) {
      onAck(chunk.timestamp); return;
    }
    if (decoder.decodeQueueSize >= 3 || pending.size >= 3) {
      recover({ name: 'QuotaExceededError' }, epoch);
      onAck(chunk.timestamp); return;
    }
    const mine = epoch;
    pending.add(chunk.timestamp);
    try {
      decoder.decode(chunk);
      if (active(mine)) waitingKey = false;
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
  return { configure, decode, suspend, resume, close };
}
