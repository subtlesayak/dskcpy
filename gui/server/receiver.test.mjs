import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as protocol from '../receiver/protocol.mjs';
import { validBrowserInput } from './browser-protocol.mjs';

const source = (await readFile(new URL('../receiver/receiver.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/, '');
const parameters = new Uint8Array([0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 1, 0x68, 42]);

// Deterministic lifecycle tests against the actual receiver script. These model
// delayed browser callbacks; rendered/device QA is separate from this harness.
function receiver(t, { portrait = false, lockFails = false } = {}) {
  const timers = new Set(), sockets = [], decoders = [], orientation = [];
  class Target {
    listeners = new Map(); attrs = new Map(); hidden = false; value = ''; textContent = ''; style = {};
    width = 640; height = 480; clientWidth = 800; clientHeight = 500;
    constructor() {
      const classes = new Set();
      this.classList = { contains: (name) => classes.has(name), add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) };
    }
    addEventListener(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list); }
    emit(name, event = {}) { let result; for (const fn of this.listeners.get(name) || []) result = fn({ preventDefault() {}, ...event }); return result; }
    setAttribute(name, value) { this.attrs.set(name, value); }
    removeAttribute(name) { this.attrs.delete(name); }
    focus() { document.activeElement = this; }
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 500 }; }
    getContext() { return { drawImage() {}, clearRect() {} }; }
    async requestFullscreen() { document.fullscreenElement = this; orientation.push('fullscreen'); document.emit('fullscreenchange'); }
  }
  const elements = new Map();
  const $ = (id) => { if (!elements.has(id)) elements.set(id, new Target()); return elements.get(id); };
  const document = new Target(); document.body = new Target(); document.getElementById = $;
  document.exitFullscreen = async () => { document.fullscreenElement = null; document.emit('fullscreenchange'); };
  class Socket extends Target {
    static OPEN = 1; readyState = 1; sent = [];
    constructor() { super(); sockets.push(this); }
    send(data) { this.sent.push(typeof data === 'string' ? data : Buffer.from(data)); }
    close(code) { this.readyState = 3; this.emit('close', { code }); }
  }
  class Decoder extends Target {
    state = 'unconfigured'; decodeQueueSize = 0; chunks = [];
    constructor(callbacks) { super(); this.callbacks = callbacks; decoders.push(this); }
    configure() { this.state = 'configured'; }
    decode(chunk) { this.decodeQueueSize++; this.chunks.push(chunk); }
    reset() { this.decodeQueueSize = 0; }
    close() { this.state = 'closed'; }
    output(timestamp) { this.decodeQueueSize = Math.max(0, this.decodeQueueSize - 1); this.callbacks.output({ timestamp, close() {} }); }
  }
  const window = new Target(); window.isSecureContext = true; window.VideoDecoder = Decoder; window.EncodedVideoChunk = true;
  const context = vm.createContext({ ...protocol, window, document, WebSocket: Socket, VideoDecoder: Decoder,
    EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
    ResizeObserver: class { observe() {} }, getComputedStyle: () => ({ paddingTop: '0', paddingRight: '0', paddingBottom: '0', paddingLeft: '0' }),
    location: { protocol: 'https:', host: 'receiver.test' }, performance: { now: () => 2000 }, AbortSignal,
    innerWidth: portrait ? 390 : 844, innerHeight: portrait ? 844 : 390,
    screen: { orientation: { async lock(value) { orientation.push(value); if (lockFails) throw new Error('Unsupported'); }, unlock() { orientation.push('unlock'); } } },
    fetch: async () => ({ ok: true, json: async () => ({ resumable: false }) }),
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(source, context, { filename: 'receiver.mjs' });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  $('session-key').value = 'x'.repeat(32); $('join-form').emit('submit');
  const socket = sockets[0]; socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ type: 'authenticated' }) });
  const header = new ArrayBuffer(16), view = new DataView(header);
  view.setUint32(0, 0x53524431); view.setUint32(4, 1); view.setUint32(8, 640); view.setUint32(12, 480);
  socket.emit('message', { data: header });
  function media(pts, flags, payload = new Uint8Array([0, 0, 1, 0x65, 42])) {
    const bytes = new ArrayBuffer(16 + payload.length), view = new DataView(bytes);
    view.setUint32(0, payload.length); view.setBigUint64(4, BigInt(pts)); view.setUint32(12, flags);
    new Uint8Array(bytes, 16).set(payload); socket.emit('message', { data: bytes });
  }
  media(0, 1, parameters);
  return { $, document, window, socket, decoders, media, orientation };
}

test('suspension drains queued frames and ignores stale decoder callbacks after resume', (t) => {
  const h = receiver(t);
  h.media(10, 2); const old = h.decoders.at(-1);
  h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(old.state, 'closed');
  h.media(20, 0); old.output(10);
  h.document.hidden = false; h.document.emit('visibilitychange');
  old.callbacks.error(new Error('Delayed closed decoder error'));
  assert.equal(h.socket.readyState, 1);
  h.media(30, 2); h.decoders.at(-1).output(30);
  assert.equal(h.$('status').textContent, 'Streaming');
  const acks = h.socket.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 4).map((data) => Number(data.readBigUInt64BE(1)));
  assert.deepEqual(acks, [10, 20, 30]);
  h.$('disconnect').emit('click');
});

test('media acknowledgement ordering is cumulative and independent for video and audio', () => {
  const sent = [], sender = protocol.createMediaAcknowledger((packet) => sent.push(packet));
  sender.acknowledge(4, 20); sender.acknowledge(4, 10); sender.acknowledge(4, 20);
  sender.acknowledge(6, 10); sender.acknowledge(6, 5);
  assert.equal(sent.length, 2);
  sender.reset(); sender.acknowledge(4, 1); assert.equal(sent.length, 3);
});

for (const portrait of [true, false]) test(`fullscreen requests landscape after entering fullscreen from ${portrait ? 'portrait' : 'landscape'}`, async (t) => {
  const h = receiver(t, { portrait });
  await h.$('fullscreen').emit('click');
  assert.deepEqual(h.orientation, ['fullscreen', 'landscape']);
  await h.$('fullscreen').emit('click');
  assert.equal(h.orientation.at(-1), 'unlock');
  h.$('disconnect').emit('click');
});

test('refused orientation lock keeps fullscreen usable and explains manual rotation', async (t) => {
  const h = receiver(t, { portrait: true, lockFails: true });
  await h.$('fullscreen').emit('click');
  assert.equal(h.document.fullscreenElement, h.$('stream-panel'));
  assert.equal(h.$('orientation-help').hidden, false);
  assert.match(h.$('orientation-help').textContent, /Turn your phone sideways/);
  h.$('disconnect').emit('click');
});

test('show-controls reserves a separate row only when neither letterbox margin fits its hit area', () => {
  assert.equal(protocol.needsControlsRow(1920, 1080, 1920, 1080), true);
  assert.equal(protocol.needsControlsRow(1920, 1080, 844, 390), false);
  assert.equal(protocol.needsControlsRow(1920, 1080, 390, 844), false);
  assert.equal(protocol.needsControlsRow(1920, 1080, 820, 460), true);
});

test('main-bar Volume and Window disclose one tray at a time and Escape restores focus', (t) => {
  const h = receiver(t);
  h.$('volume').emit('click');
  assert.equal(h.$('volume-controls').hidden, false);
  assert.equal(h.$('volume').attrs.get('aria-expanded'), 'true');
  assert.equal(h.document.activeElement, h.$('volume-down'));
  h.$('volume-down').emit('click'); h.$('volume-up').emit('click');
  h.$('window').emit('click');
  assert.equal(h.$('volume-controls').hidden, true);
  assert.equal(h.$('window-controls').hidden, false);
  h.$('minimize').emit('click'); h.$('maximize').emit('click');
  assert.deepEqual(h.socket.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 5).slice(-4).map((data) => data[1]), [0, 1, 3, 4]);
  h.document.emit('keydown', { key: 'Escape' });
  assert.equal(h.$('window-controls').hidden, true);
  assert.equal(h.document.activeElement, h.$('window'));
  h.$('volume').emit('click'); h.$('hide-controls').emit('click');
  assert.equal(h.$('volume-controls').hidden, true);
  h.$('show-controls').emit('click');
  assert.equal(h.$('volume').attrs.get('aria-expanded'), 'false');
  h.$('more').emit('click'); assert.equal(h.$('more-controls').hidden, false);
  h.$('window').emit('click'); assert.equal(h.$('more-controls').hidden, true);
  h.$('disconnect').emit('click'); assert.equal(h.$('window-controls').hidden, true);
});

test('closing a Volume tray stops hold-to-repeat', async (t) => {
  const h = receiver(t); h.$('volume').emit('click');
  h.$('volume-up').emit('pointerdown', { button: 0, pointerId: 10 });
  await new Promise((resolve) => setTimeout(resolve, 590));
  const count = () => h.socket.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 5 && data[1] === 1).length;
  assert.ok(count() >= 2);
  h.$('window').emit('click'); const stopped = count();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(count(), stopped); h.$('disconnect').emit('click');
});

function pointer(h, name, id, x, y, pointerType = 'touch') {
  h.$('display').emit(name, { pointerId: id, clientX: x, clientY: y, pointerType, button: 0 });
}
function inputs(h) { return h.socket.sent.filter((data) => Buffer.isBuffer(data) && [3, 7].includes(data[0])); }

test('one-finger swipe scrolls without pressing/selecting; a stationary tap still clicks', (t) => {
  const h = receiver(t);
  pointer(h, 'pointerdown', 1, 200, 200); pointer(h, 'pointermove', 1, 200, 160); pointer(h, 'pointerup', 1, 200, 160);
  assert.equal(inputs(h).length, 1); assert.equal(inputs(h)[0][0], 7);
  assert.equal(inputs(h)[0].readInt32BE(17), 40);
  assert.equal(validBrowserInput(inputs(h)[0], 640, 480), true);
  pointer(h, 'pointerdown', 2, 100, 100); pointer(h, 'pointerup', 2, 100, 100);
  assert.deepEqual(inputs(h).slice(-2).map((data) => [data[0], data[1]]), [[3, 0], [3, 1]]);
  h.$('disconnect').emit('click');
});

test('two-finger scroll emits no touch-down and never clicks with the remaining finger', (t) => {
  const h = receiver(t);
  pointer(h, 'pointerdown', 1, 100, 200); pointer(h, 'pointerdown', 2, 200, 200);
  pointer(h, 'pointermove', 1, 100, 160); pointer(h, 'pointermove', 2, 200, 160);
  pointer(h, 'pointerup', 2, 200, 160); pointer(h, 'pointermove', 1, 100, 120); pointer(h, 'pointerup', 1, 100, 120);
  assert.equal(inputs(h).length, 2); assert.ok(inputs(h).every((data) => data[0] === 7));
  assert.equal(inputs(h).reduce((sum, data) => sum + data.readInt32BE(17), 0), 40);
  h.$('disconnect').emit('click');
});

test('select-drag is explicit; adding a second finger cancels the pressed contact before scrolling', (t) => {
  const h = receiver(t); h.$('drag-mode').emit('click');
  assert.equal(h.$('drag-mode').textContent, 'Drag: select');
  pointer(h, 'pointerdown', 1, 100, 200); pointer(h, 'pointermove', 1, 100, 180);
  pointer(h, 'pointerdown', 2, 200, 180); pointer(h, 'pointermove', 2, 200, 140);
  assert.deepEqual(inputs(h).map((data) => data[0] === 3 ? data[1] : 'scroll'), [0, 2, 3, 'scroll']);
  h.document.hidden = true; h.document.emit('visibilitychange');
  const count = inputs(h).length; pointer(h, 'pointerup', 1, 100, 180);
  assert.equal(inputs(h).length, count);
  h.$('disconnect').emit('click');
});

test('touch off suppresses gestures and mouse drags retain ordinary contact behavior', (t) => {
  const h = receiver(t); h.$('touch').emit('click');
  pointer(h, 'pointerdown', 1, 100, 200); pointer(h, 'pointermove', 1, 100, 150); pointer(h, 'pointerup', 1, 100, 150);
  assert.equal(inputs(h).length, 0); h.$('touch').emit('click');
  pointer(h, 'pointerdown', 2, 100, 200, 'mouse'); pointer(h, 'pointermove', 2, 120, 200, 'mouse'); pointer(h, 'pointerup', 2, 120, 200, 'mouse');
  assert.deepEqual(inputs(h).map((data) => data[1]), [0, 2, 1]);
  h.$('disconnect').emit('click');
});

test('scroll framing validates signed deltas, dimensions and bounds; secondary touch transitions are valid', () => {
  const packet = Buffer.from(protocol.scrollPacket(100, 200, 640, 480, -12, 500));
  assert.equal(validBrowserInput(packet, 640, 480), true);
  assert.equal(packet.readInt32BE(13), -12); assert.equal(packet.readInt32BE(17), 120);
  assert.equal(validBrowserInput(packet, 800, 480), false);
  packet.writeInt32BE(-121, 17); assert.equal(validBrowserInput(packet, 640, 480), false);
  packet.writeInt32BE(0, 17); packet.writeUInt32BE(640, 1); assert.equal(validBrowserInput(packet, 640, 480), false);
  for (const action of [5, 6]) assert.equal(validBrowserInput(Buffer.from(protocol.touchPacket(action, 1, 20, 20, 640, 480)), 640, 480), true);
});
