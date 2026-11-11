import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoReceiver } from '../receiver/video.mjs';

const settle = () => new Promise(setImmediate);
const config = { codec: 'avc1.42c01e', codedWidth: 640, codedHeight: 480, optimizeForLatency: true };
const chunk = (timestamp, type = 'key') => ({ timestamp, type, data: new Uint8Array([1]) });

function fixture(t) {
  const decoders = [], probes = [], acks = [], frames = [], errors = [], timers = new Map();
  let support = async () => ({ supported: true }), requests = 0, timerId = 0;
  class Decoder {
    state = 'unconfigured'; decodeQueueSize = 0; chunks = [];
    static isConfigSupported(value) { probes.push(value); return support(value); }
    constructor(callbacks) { this.callbacks = callbacks; decoders.push(this); }
    configure(value) { this.config = value; this.state = 'configured'; }
    decode(value) { this.chunks.push(value); this.decodeQueueSize++; }
    close() { this.state = 'closed'; }
    error(name) { this.state = 'closed'; this.callbacks.error({ name }); }
    output(timestamp) {
      this.decodeQueueSize = Math.max(0, this.decodeQueueSize - 1);
      const frame = { timestamp, closed: false, close() { this.closed = true; } };
      this.callbacks.output(frame); return frame;
    }
  }
  const video = createVideoReceiver({ Decoder,
    onFrame: (frame) => frames.push(frame.timestamp), onAck: (pts) => acks.push(pts),
    onError: (error) => errors.push(error), onKeyframe: () => requests++,
    setTimer: (fn, delay) => { fn.delay = delay; timers.set(++timerId, fn); return timerId; },
    clearTimer: (id) => timers.delete(id),
  });
  t.after(() => video.close());
  return { video, decoders, probes, acks, frames, errors, timers,
    support(fn) { support = fn; }, get requests() { return requests; },
    expire() { const fn = timers.values().next().value; assert.ok(fn); fn(); },
    expireAfter(delay) { const entry = [...timers].find(([,fn]) => fn.delay === delay); assert.ok(entry); timers.delete(entry[0]); entry[1](); },
  };
}

test('preflight discards rather than stores frames and decoding begins only at a fresh keyframe', async (t) => {
  const h = fixture(t); let resolve;
  h.support(() => new Promise((done) => { resolve = done; }));
  h.video.configure(config); h.video.decode(chunk(1));
  assert.equal(h.decoders.length, 0); assert.deepEqual(h.acks, [1]);
  assert.deepEqual(h.probes[0], config);
  resolve({ supported: true }); await settle();
  assert.equal(h.requests, 1);
  h.video.decode(chunk(2, 'delta')); h.video.decode(chunk(3));
  assert.deepEqual(h.decoders[0].chunks.map((x) => x.timestamp), [3]);
  assert.equal(h.decoders[0].output(3).closed, true);
  assert.deepEqual(h.frames, [3]); assert.deepEqual(h.acks, [1, 2, 3]);
  assert.equal(h.timers.size, 0);
});

test('unsupported configuration fails before allocating a decoder', async (t) => {
  const h = fixture(t); h.support(async () => ({ supported: false }));
  h.video.configure(config); await settle();
  assert.equal(h.decoders.length, 0); assert.equal(h.requests, 0);
  assert.match(h.errors[0], /does not support/); assert.equal(h.timers.size, 0);
});

test('hardware error permits one supported software retry and ignores old callbacks', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  const old = h.decoders[0]; h.video.decode(chunk(10)); old.error('EncodingError');
  h.video.decode(chunk(11, 'delta')); await settle();
  assert.equal(h.probes[1].hardwareAcceleration, 'prefer-software');
  assert.deepEqual(h.acks, [10, 11]);
  assert.equal(old.output(10).closed, true); old.error('EncodingError');
  assert.equal(h.decoders.length, 2); assert.equal(h.errors.length, 0);
  h.video.decode(chunk(12, 'delta')); assert.equal(h.decoders[1].chunks.length, 0);
  h.video.decode(chunk(13)); h.decoders[1].output(13);
  assert.deepEqual(h.frames, [13]);
  h.decoders[1].error('EncodingError'); await settle();
  assert.equal(h.errors.length, 1); assert.equal(h.decoders.length, 2);
});

test('unsupported software fallback fails without configuring another decoder', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  h.support(async () => ({ supported: false })); h.decoders[0].error('EncodingError');
  await settle();
  assert.equal(h.decoders.length, 1); assert.match(h.errors[0], /Software H.264/);
});

test('suspension invalidates an in-flight probe and resume probes again', async (t) => {
  const h = fixture(t); let resolve;
  h.support(() => new Promise((done) => { resolve = done; }));
  h.video.configure(config); h.video.suspend();
  resolve({ supported: true }); await settle();
  assert.equal(h.decoders.length, 0); assert.equal(h.timers.size, 0);
  h.support(async () => ({ supported: true })); h.video.resume(); await settle();
  assert.equal(h.decoders.length, 1); assert.equal(h.requests, 1);
});

test('disconnect invalidates late probe success and rejection', async (t) => {
  for (const rejectProbe of [false, true]) {
    const h = fixture(t); let finish;
    h.support(() => new Promise((resolve, reject) => { finish = rejectProbe ? reject : resolve; }));
    h.video.configure(config); h.video.close();
    finish(rejectProbe ? new Error('late failure') : { supported: true }); await settle();
    assert.equal(h.decoders.length, 0); assert.equal(h.errors.length, 0);
    assert.equal(h.requests, 0); assert.equal(h.timers.size, 0);
  }
});

test('an obsolete unsupported probe cannot reject a newer supported configuration', async (t) => {
  const h = fixture(t), finishes = [];
  h.support(() => new Promise((resolve) => finishes.push(resolve)));
  h.video.configure(config); h.video.configure({ ...config, codedWidth: 320 });
  finishes[0]({ supported: false }); finishes[1]({ supported: true }); await settle();
  assert.equal(h.errors.length, 0); assert.equal(h.decoders.length, 1);
  assert.equal(h.decoders[0].config.codedWidth, 320);
});

test('a stalled decoder drains acknowledgements and restarts only with a new keyframe', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  h.video.decode(chunk(1)); h.video.decode(chunk(2, 'delta')); h.video.decode(chunk(3, 'delta'));
  h.video.decode(chunk(4, 'delta')); await settle();
  assert.deepEqual(h.acks, [1, 2, 3, 4]); assert.equal(h.decoders[0].state, 'closed');
  h.decoders[0].output(1); h.video.decode(chunk(5, 'delta')); h.video.decode(chunk(6));
  h.decoders[1].output(6);
  assert.deepEqual(h.frames, [6]); assert.deepEqual(h.acks, [1, 2, 3, 4, 5, 6]);
  assert.equal(h.errors.length, 0);
});

test('repeated reclamation has a finite session-wide recovery budget', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  for (let i = 0; i < 4; ++i) { h.decoders.at(-1).error('QuotaExceededError'); await settle(); }
  assert.equal(h.decoders.length, 4); assert.equal(h.errors.length, 1);
  h.video.resume(); h.video.configure(config); await settle();
  assert.equal(h.decoders.length, 4); assert.equal(h.timers.size, 0);
});

test('software fallback remains selected through pause and configuration changes', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  h.decoders[0].error('EncodingError'); await settle();
  h.video.suspend(); h.video.resume(); await settle();
  h.video.configure({ ...config, codedWidth: 320 }); await settle();
  assert.ok(h.probes.slice(1).every((probe) => probe.hardwareAcceleration === 'prefer-software'));
  h.decoders.at(-1).error('EncodingError'); await settle();
  assert.equal(h.errors.length, 1);
});

test('a support query or missing first output cannot leave recovery waiting forever', async (t) => {
  const pending = fixture(t); pending.support(() => new Promise(() => {}));
  pending.video.configure(config); pending.expire();
  assert.match(pending.errors[0], /timed out/); assert.equal(pending.timers.size, 0);
  const ready = fixture(t); ready.video.configure(config); await settle();
  ready.video.decode(chunk(1, 'delta')); ready.expire();
  assert.match(ready.errors[0], /timed out/); assert.equal(ready.decoders[0].state, 'closed');
});

test('malformed-data errors fail without attempting software fallback', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  h.decoders[0].error('DataError'); await settle();
  assert.equal(h.probes.length, 1); assert.equal(h.errors.length, 1);
});

test('a decoder accepting input without output gets one bounded software retry', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  const hardware = h.decoders[0];
  h.video.decode(chunk(1)); h.video.decode(chunk(2, 'delta'));
  h.expire(); await settle();
  assert.equal(hardware.state, 'closed');
  assert.deepEqual(h.acks, [1, 2]);
  assert.equal(h.probes[1].hardwareAcceleration, 'prefer-software');
  assert.equal(h.requests, 2); assert.equal(h.errors.length, 0);
  hardware.output(1); assert.deepEqual(h.frames, []);
  h.video.decode(chunk(3, 'delta'));
  assert.equal(h.decoders[1].chunks.length, 0);
  h.video.decode(chunk(4)); h.decoders[1].output(4);
  assert.deepEqual(h.frames, [4]); assert.equal(h.timers.size, 0);
});

test('silent software stalls terminate instead of retrying indefinitely', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  h.video.decode(chunk(1)); h.expire(); await settle();
  h.video.decode(chunk(2)); h.expire(); await settle();
  assert.equal(h.decoders.length, 2); assert.equal(h.errors.length, 1);
  assert.deepEqual(h.acks, [1, 2]); assert.equal(h.timers.size, 0);
});

test('buffered two-frame output is drained without acknowledging undecoded frames or admitting deltas after flush', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  const decoder = h.decoders[0]; let finish, flushes = 0;
  decoder.flush = () => { flushes++; return new Promise((resolve) => { finish = resolve; }); };
  h.video.decode(chunk(1)); h.video.decode(chunk(2, 'delta'));
  assert.deepEqual(h.acks, []);
  h.expireAfter(100); assert.equal(flushes, 1);
  h.video.decode(chunk(3)); assert.deepEqual(h.acks, [3]);
  decoder.output(1); decoder.output(2);
  assert.deepEqual(h.frames, [1, 2]);
  finish(); await settle(); assert.equal(h.requests, 2);
  h.video.decode(chunk(4, 'delta'));
  assert.deepEqual(decoder.chunks.map((x) => x.timestamp), [1, 2]);
  h.video.decode(chunk(5)); decoder.output(5);
  assert.deepEqual(h.frames, [1, 2, 5]); assert.equal(h.timers.size, 0);
  assert.equal(h.probes.length, 1); assert.equal(h.errors.length, 0);
});

test('a late flush cannot request frames after suspension, replacement or disconnect', async (t) => {
  for (const action of ['suspend', 'configure', 'close']) {
    const h = fixture(t); h.video.configure(config); await settle(); let finish;
    h.decoders[0].flush = () => new Promise((resolve) => { finish = resolve; });
    h.video.decode(chunk(1)); h.expireAfter(100);
    action === 'configure' ? h.video.configure(config) : h.video[action]();
    await settle(); const requests = h.requests;
    finish(); await settle();
    assert.equal(h.requests, requests); assert.equal(h.errors.length, 0);
  }
});

test('a hung drain remains bounded even after it emits its pending frames', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  h.decoders[0].flush = () => new Promise(() => {});
  h.video.decode(chunk(1)); h.expireAfter(100); h.decoders[0].output(1);
  h.expireAfter(5000);
  assert.match(h.errors[0], /timed out/); assert.equal(h.timers.size, 0);
});

test('missing output is bounded even when the browser reports an empty decode queue', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  for (let pts = 1; pts <= 4; ++pts) {
    h.video.decode(chunk(pts, pts === 1 ? 'key' : 'delta'));
    h.decoders[0].decodeQueueSize = 0;
  }
  await settle();
  assert.deepEqual(h.acks, [1, 2, 3, 4]); assert.equal(h.decoders.length, 2);
  assert.equal(h.decoders[0].state, 'closed');
});

test('a synchronous decoder error cannot admit deltas into its replacement', async (t) => {
  const h = fixture(t); h.video.configure(config); await settle();
  const old = h.decoders[0]; old.decode = () => old.error('EncodingError');
  h.video.decode(chunk(1)); await settle(); h.video.decode(chunk(2, 'delta'));
  assert.equal(h.decoders[1].chunks.length, 0); assert.deepEqual(h.acks, [1, 2]);
});

test('a rendering failure closes the frame and reports a terminal error', async (t) => {
  let callbacks, frameClosed = false, failure;
  class Decoder {
    static async isConfigSupported() { return { supported: true }; }
    state = 'configured'; decodeQueueSize = 0;
    constructor(value) { callbacks = value; }
    configure() {} decode() {} close() { this.state = 'closed'; }
  }
  const video = createVideoReceiver({ Decoder, onAck() {}, onKeyframe() {},
    onFrame() { throw new Error('Canvas unavailable'); }, onError: (message) => { failure = message; } });
  t.after(() => video.close()); video.configure(config); await settle(); video.decode(chunk(1));
  callbacks.output({ timestamp: 1, close() { frameClosed = true; } });
  assert.equal(frameClosed, true); assert.match(failure, /could not display/);
});
