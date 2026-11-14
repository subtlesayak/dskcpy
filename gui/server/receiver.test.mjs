import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createBrowserClipboard } from '../receiver/clipboard.mjs';
import { createKeyboardShortcuts, shortcutLabel } from '../receiver/shortcuts.mjs';
import { createDesktopView } from '../receiver/view.mjs';
import { createTypingView } from '../receiver/typing-view.mjs';
import { createRelativeTrackpad } from '../receiver/trackpad.mjs';
import { rememberedBrowser } from '../receiver/remembered.mjs';
import { receiverIsAway } from '../receiver/lifecycle.mjs';
import * as protocol from '../receiver/protocol.mjs';
import { createVideoReceiver } from '../receiver/video.mjs';
import { createVideoFeedback } from '../receiver/video-feedback.mjs';
import { createWindowChooser } from '../receiver/window-chooser.mjs';
import { createVideoPreference } from '../receiver/video-preference.mjs';
import { createBrowserKeyboard, keyboardUsage, keyPacket } from '../receiver/keyboard.mjs';
import { validBrowserInput } from './browser-protocol.mjs';

const source = (await readFile(new URL('../receiver/receiver.mjs', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const parameters = new Uint8Array([0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 1, 0x68, 42]);

// Deterministic lifecycle tests against the actual receiver script. These model
// delayed browser callbacks; rendered/device QA is separate from this harness.
function receiver(t, { portrait = false, lockFails = false, webRtc = false, webCodecs = true, qrKey = '', keyboard = false, viewOnly = false, visualHeight = 0, webAudio = false, textFocus = false, keyboardStatus = false, clipboard = false, clipboardAPI = undefined, virtualKeyboard = null, now = () => Date.now(), resumable = false, mediaFallback = false, adaptiveVideo = false, windowSwitch = false, rtcOffer = async () => {} } = {}) {
  const timers = new Set(), sockets = [], decoders = [], orientation = [], rtcReceivers = [];
  let resize;
  const animationFrames = [];
  const flushResize = () => { for (const callback of animationFrames.splice(0)) callback(); };
  const locationState = { protocol: 'https:', host: 'receiver.test', pathname: qrKey ? '/join' : '/', search: '', hash: qrKey ? `#connect=${qrKey}` : '' };
  const historyChanges = [];
  class Target {
    dataset = {}; children = [];
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    listeners = new Map(); attrs = new Map(); hidden = false; value = ''; textContent = ''; style = {};
    width = 640; height = 480; clientWidth = 800; clientHeight = 500;
    constructor() {
      const classes = new Set();
      this.classList = { contains: (name) => classes.has(name), add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)), toggle: (name, on) => on ? classes.add(name) : classes.delete(name) };
    }
    addEventListener(name, fn) { const list = this.listeners.get(name) || []; list.push(fn); this.listeners.set(name, list); }
    emit(name, event = {}) { let result; for (const fn of this.listeners.get(name) || []) result = fn({ preventDefault() {}, stopPropagation() {}, ...event }); return result; }
    requestSubmit() { return this.emit('submit'); }
    setAttribute(name, value) { this.attrs.set(name, value); }
    removeAttribute(name) { this.attrs.delete(name); }
    focus() {
      if (this === $('keyboard-input') && $('control-panels').hidden) return;
      document.activeElement = this;
    }
    setPointerCapture() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 500 }; }
    getContext() { return { drawImage() {}, clearRect() {} }; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    async requestFullscreen() { document.fullscreenElement = this; orientation.push('fullscreen'); document.emit('fullscreenchange'); }
  }
  const elements = new Map();
  const $ = (id) => { if (!elements.has(id)) elements.set(id, new Target()); return elements.get(id); };
  const cssVariables = new Map();
  const document = new Target(); document.body = new Target(); document.documentElement = new Target();
  document.documentElement.style.setProperty = (key, value) => cssVariables.set(key, value); document.getElementById = $; document.createElement = () => new Target();
  document.exitFullscreen = async () => { document.fullscreenElement = null; document.emit('fullscreenchange'); };
  class Socket extends Target {
    static OPEN = 1; readyState = 1; sent = [];
    constructor(url, protocols = []) { super(); this.protocols = protocols; this.url = url; this.fragmentAtConnect = locationState.hash; sockets.push(this); }
    send(data) { this.sent.push(typeof data === 'string' ? data : Buffer.from(data)); }
    close(code, reason) { this.readyState = 3; this.emit('close', { code, reason }); }
  }
  class Decoder extends Target {
    static async isConfigSupported() { return { supported: true }; }
    state = 'unconfigured'; decodeQueueSize = 0; chunks = [];
    constructor(callbacks) { super(); this.callbacks = callbacks; decoders.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) { this.decodeQueueSize++; this.chunks.push(chunk); }
    reset() { this.decodeQueueSize = 0; }
    close() { this.state = 'closed'; }
    output(timestamp) { this.decodeQueueSize = Math.max(0, this.decodeQueueSize - 1); this.callbacks.output({ timestamp, close() {} }); }
  }
  const soundDecoders = [], audioSources = [], audioContexts = [];
  class SoundDecoder extends Target {
    state = 'unconfigured'; decodeQueueSize = 0;
    constructor(callbacks) { super(); this.callbacks = callbacks; soundDecoders.push(this); }
    configure() { this.state = 'configured'; }
    decode() { this.emit('dequeue'); }
    close() { this.state = 'closed'; }
    output(frames = 480) {
      const data = { numberOfChannels: 2, numberOfFrames: frames, sampleRate: 48000,
        closed: false, copyTo(target) { target.fill(.01); }, close() { this.closed = true; } };
      this.callbacks.output(data); return data;
    }
  }
  class AudioContext {
    state = 'running'; currentTime = 0;
    constructor() { audioContexts.push(this); }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
    createBuffer(channels, frames, rate) {
      const planes = Array.from({ length: channels }, () => new Float32Array(frames));
      return { duration: frames / rate, getChannelData: channel => planes[channel] };
    }
    createBufferSource() {
      const source = { stopped: false, connect() {}, start(at) { this.startAt = at; },
        stop() { this.stopped = true; this.onended?.(); } };
      audioSources.push(source); return source;
    }
  }
  const window = new Target(); window.isSecureContext = true;
  if (webAudio) window.AudioDecoder = SoundDecoder;
  if (visualHeight) { window.visualViewport = new Target(); window.visualViewport.height = visualHeight; }
  if (webCodecs) { window.VideoDecoder = Decoder; window.EncodedVideoChunk = true; }
  if (webRtc) window.RTCPeerConnection = true;
  window.history = { replaceState(_state, _title, url) { locationState.hash = ''; historyChanges.push(url); } };
  const context = vm.createContext({ ...protocol,
    createWindowChooser, createVideoPreference,
    createVideoFeedback: options => createVideoFeedback({...options,setTimer:(fn,ms)=>{const timer=setInterval(fn,ms);timers.add(timer);return timer},clearTimer:clearInterval}),
    createKeyboardShortcuts, shortcutLabel, createDesktopView, createTypingView, createRelativeTrackpad, createBrowserKeyboard, keyboardUsage, keyPacket, receiverIsAway,
    createBrowserClipboard: options => createBrowserClipboard({ ...options, setTimer: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimer: clearTimeout }),
    rememberedBrowser: options => rememberedBrowser({ ...options, document, location: locationState,
      fetch: (...args) => context.fetch(...args),
      setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout }),
    createVideoReceiver: (options) => createVideoReceiver({ ...options, Decoder }),
    createRtcReceiver: options => { const value = { ...options, closed: false, offer: async description => rtcOffer(description), close() { this.closed = true; } }; rtcReceivers.push(value); return value; },
    navigator: { virtualKeyboard, clipboard: clipboardAPI }, window, document, WebSocket: Socket, VideoDecoder: Decoder, AudioDecoder: SoundDecoder, AudioContext,
    EncodedAudioChunk: class { constructor(value) { Object.assign(this, value); } },
    EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
    ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} }, requestAnimationFrame: callback => animationFrames.push(callback), getComputedStyle: () => ({ paddingTop: '0', paddingRight: '0', paddingBottom: '0', paddingLeft: '0', zoom: '1' }),
    Date: class extends Date { static now() { return now(); } },
    location: locationState, performance: { now: () => 2000 }, AbortSignal,
    innerWidth: portrait ? 390 : 844, innerHeight: portrait ? 844 : 390,
    screen: { orientation: { async lock(value) { orientation.push(value); if (lockFails) throw new Error('Unsupported'); }, unlock() { orientation.push('unlock'); } } },
    fetch: async () => ({ ok: true, json: async () => ({ resumable }) }),
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
    setInterval: (fn, ms) => { const timer = setInterval(fn, ms); timers.add(timer); return timer; }, clearInterval,
  });
  vm.runInContext(source, context, { filename: 'receiver.mjs' });
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  if (!qrKey) { $('session-key').value = 'x'.repeat(32); $('join-form').emit('submit'); }
  const socket = sockets[0]; socket.emit('open');
  socket.emit('message', { data: JSON.stringify({ type: 'authenticated', keyboard, viewOnly, textFocus, keyboardStatus, clipboard, mediaFallback, adaptiveVideo, windowSwitch, mediaMode: webRtc ? 'webrtc' : 'webcodecs' }) });
  const header = new ArrayBuffer(16), view = new DataView(header);
  view.setUint32(0, 0x53524431); view.setUint32(4, 1); view.setUint32(8, 640); view.setUint32(12, 480);
  socket.emit('message', { data: header });
  function media(pts, flags, payload = new Uint8Array([0, 0, 1, 0x65, 42])) {
    const bytes = new ArrayBuffer(16 + payload.length), view = new DataView(bytes);
    view.setUint32(0, payload.length); view.setBigUint64(4, BigInt(pts)); view.setUint32(12, flags);
    new Uint8Array(bytes, 16).set(payload); socket.emit('message', { data: bytes });
  }
  media(0, 1, parameters);
  return { context, $, document, window, socket, sockets, locationState, decoders, rtcReceivers, media, orientation, historyChanges, cssVariables, soundDecoders, audioSources, audioContexts,
    notifyResize: () => resize(), flushResize, animationFrames, reflow: () => { resize(); flushResize(); } };
}

test('stage resize notifications coalesce outside observer delivery and use the latest viewport without releasing keys', t => {
  const h = receiver(t, {keyboard:true,visualHeight:400});
  h.$('keyboard').emit('click');h.$('keyboard-input').emit('keydown',{code:'ControlLeft',key:'Control'});
  const before=h.socket.sent.filter(Buffer.isBuffer).filter(p=>p[0]===8).length;
  h.window.visualViewport.height=250;h.notifyResize();h.notifyResize();
  assert.equal(h.animationFrames.length,1);assert.equal(h.cssVariables.get('--receiver-height'),'400px');
  h.window.visualViewport.height=220;h.flushResize();
  assert.equal(h.cssVariables.get('--receiver-height'),'220px');assert.equal(h.animationFrames.length,0);
  assert.equal(h.socket.sent.filter(Buffer.isBuffer).filter(p=>p[0]===8).length,before);
  h.$('keyboard-input').emit('keyup',{code:'ControlLeft',key:'Control'});
  assert.equal(h.socket.sent.filter(Buffer.isBuffer).filter(p=>p[0]===8).at(-1)[1],1);
});

test('suspension drains queued frames and ignores stale decoder callbacks after resume', async (t) => {
  const h = receiver(t);
  await new Promise(setImmediate);
  h.media(10, 2); const old = h.decoders.at(-1);
  h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(old.state, 'closed');
  h.media(20, 0); old.output(10);
  h.document.hidden = false; h.document.emit('visibilitychange');
  await new Promise(setImmediate);
  old.callbacks.error(new Error('Delayed closed decoder error'));
  assert.equal(h.socket.readyState, 1);
  h.media(30, 2); h.decoders.at(-1).output(30);
  assert.equal(h.$('status').textContent, 'Streaming');
  const acks = h.socket.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 4).map((data) => Number(data.readBigUInt64BE(1)));
  assert.deepEqual(acks, [10, 20, 30]);
  h.$('disconnect').emit('click');
});

test('WebCodecs recovery keeps the authorized socket and requests a fresh host keyframe', async (t) => {
  const h = receiver(t); await new Promise(setImmediate);
  const old = h.decoders[0]; h.media(10, 2);
  old.state = 'closed'; old.callbacks.error({ name: 'EncodingError' });
  h.media(20, 0); await new Promise(setImmediate);
  assert.equal(h.socket.readyState, 1);
  assert.equal(h.decoders.at(-1).config.hardwareAcceleration, 'prefer-software');
  h.media(30, 2); h.decoders.at(-1).output(30);
  assert.equal(h.$('status').textContent, 'Streaming');
  const acks = h.socket.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 4).map((data) => Number(data.readBigUInt64BE(1)));
  assert.deepEqual(acks, [10, 20, 30]);
  assert.ok(h.socket.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 5 && data[1] === 8).length >= 3);
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

test('Options groups secondary actions and Close/Escape restore focus to the right rail', (t) => {
  const h = receiver(t);
  h.$('more').emit('click');
  assert.equal(h.$('more-controls').hidden, false);
  assert.equal(h.document.activeElement, h.$('close-options'));
  h.$('volume-down').emit('click'); h.$('volume-up').emit('click');
  h.$('minimize').emit('click'); h.$('maximize').emit('click');
  assert.deepEqual(h.socket.sent.filter(data => Buffer.isBuffer(data) && data[0] === 5).slice(-4).map(data => data[1]), [0, 1, 3, 4]);
  h.$('close-options').emit('click');
  assert.equal(h.$('more-controls').hidden, true);
  assert.equal(h.document.activeElement, h.$('more'));
  h.$('more').emit('click'); h.document.emit('keydown', { key: 'Escape' });
  assert.equal(h.$('more-controls').hidden, true);
  assert.equal(h.document.activeElement, h.$('more'));
  h.$('more').emit('click'); h.$('hide-controls').emit('click');
  assert.equal(h.$('more-controls').hidden, true);
  h.$('show-controls').emit('click');
  assert.equal(h.$('more').attrs.get('aria-expanded'), 'false');
  h.$('disconnect').emit('click');
});

test('closing a native volume disclosure stops hold-to-repeat', async (t) => {
  const h = receiver(t); h.$('more').emit('click');
  h.$('volume-up').emit('pointerdown', { button: 0, pointerId: 10 });
  await new Promise(resolve => setTimeout(resolve, 590));
  const count = () => h.socket.sent.filter(data => Buffer.isBuffer(data) && data[0] === 5 && data[1] === 1).length;
  assert.ok(count() >= 2);
  h.$('volume').emit('toggle'); const stopped = count();
  await new Promise(resolve => setTimeout(resolve, 180));
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
  assert.equal(h.$('drag-mode').attrs.get('aria-label'), 'Select and drag');
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

test('browser-native mode connects without WebCodecs and forwards explicit audio mute intent', async (t) => {
  const h = receiver(t, { webRtc: true, webCodecs: false });
  assert.match(h.socket.url, /\/stream\/webrtc$/);
  assert.equal(h.decoders.length, 0);
  assert.equal(h.$('stream-panel').hidden, false);
  await h.$('audio').emit('click');
  assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio on');
  assert.equal(h.$('rtc-display').muted, false);
  h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(h.$('rtc-display').muted, true);
  assert.equal(h.$('rtc-display').paused, true);
  h.document.hidden = false; h.document.emit('visibilitychange');
  assert.equal(h.$('rtc-display').paused, false);
  await h.$('audio').emit('click');
  assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio off');
  assert.equal(h.$('rtc-display').muted, true);
  const commands = h.socket.sent.filter((data) => Buffer.isBuffer(data) && data[0] === 5).map((data) => data[1]);
  assert.ok(commands.includes(10)); assert.equal(commands.at(-1), 11);
  h.$('disconnect').emit('click');
});

test('late browser audio rejection cannot change a disconnected receiver', async (t) => {
  const h = receiver(t, { webRtc: true, webCodecs: false });
  let rejectPlay;
  h.$('rtc-display').play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  const enabling = h.$('audio').emit('click');
  h.$('disconnect').emit('click');
  rejectPlay(new Error('Playback interrupted by teardown'));
  await enabling;
  assert.equal(h.$('error').textContent, '');
  assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio off');
});

test('a superseded audio enable cannot report an error after the user mutes again', async (t) => {
  const h = receiver(t, { webRtc: true, webCodecs: false });
  let rejectPlay;
  h.$('rtc-display').play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  const enabling = h.$('audio').emit('click');
  await h.$('audio').emit('click');
  rejectPlay(new Error('Playback interrupted by mute'));
  await enabling;
  assert.equal(h.$('error').textContent, '');
  assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio off');
  assert.equal(h.$('rtc-display').muted, true);
  h.$('disconnect').emit('click');
});

test('late return-to-tab playback failure cannot report into a disconnected receiver', async (t) => {
  const h = receiver(t, { webRtc: true, webCodecs: false });
  h.document.hidden = true; h.document.emit('visibilitychange');
  let rejectPlay;
  h.$('rtc-display').play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  h.document.hidden = false; h.document.emit('visibilitychange');
  h.$('disconnect').emit('click');
  rejectPlay(new Error('Playback interrupted after return'));
  await new Promise(setImmediate);
  assert.equal(h.$('error').textContent, '');
  assert.match(h.$('status').textContent, /^Disconnected/);
});

test('hiding during audio enable preserves mute intent and its accessible button state on return', async (t) => {
  const h = receiver(t, { webRtc: true, webCodecs: false });
  let rejectPlay;
  h.$('rtc-display').play = () => new Promise((_resolve, reject) => { rejectPlay = reject; });
  const enabling = h.$('audio').emit('click');
  h.document.hidden = true; h.document.emit('visibilitychange');
  rejectPlay(new Error('Playback interrupted by backgrounding'));
  await enabling;
  h.$('rtc-display').play = () => Promise.resolve();
  h.document.hidden = false; h.document.emit('visibilitychange');
  assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio on');
  assert.equal(h.$('audio').attrs.get('aria-pressed'), 'true');
  assert.equal(h.$('rtc-display').muted, false);
  assert.equal(h.$('error').textContent, '');
  h.$('disconnect').emit('click');
});

test('a current browser playback denial still mutes audio and offers a retry', async (t) => {
  const h = receiver(t, { webRtc: true, webCodecs: false });
  h.$('rtc-display').play = () => Promise.reject(new Error('Playback denied'));
  await h.$('audio').emit('click');
  assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio off');
  assert.equal(h.$('audio').attrs.get('aria-pressed'), 'false');
  assert.equal(h.$('rtc-display').muted, true);
  assert.match(h.$('error').textContent, /Audio could not start/);
  const commands = h.socket.sent.filter(data => Buffer.isBuffer(data) && data[0] === 5).map(data => data[1]);
  assert.deepEqual(commands.slice(-2), [10, 11]);
  h.$('disconnect').emit('click');
});

test('scanning a QR invitation removes the fragment before opening the authenticated socket', (t) => {
  const key = 'z'.repeat(32), h = receiver(t, { webRtc: true, webCodecs: false, qrKey: key });
  assert.deepEqual(h.historyChanges, ['/join']);
  assert.equal(h.socket.fragmentAtConnect, '');
  assert.equal(h.socket.sent[0], key);
  assert.equal(h.$('session-key').value, '');
  h.$('disconnect').emit('click');
});

test('QR links reused in an existing receiver tab scrub before connecting and cannot replace a live viewer', (t) => {
  const h = receiver(t);
  h.$('disconnect').emit('click');
  const key = 'y'.repeat(32);
  h.locationState.hash = `#connect=${key}`;
  h.window.emit('hashchange');
  const next = h.sockets.at(-1);
  assert.notEqual(next, h.socket);
  assert.equal(next.fragmentAtConnect, '');
  next.emit('open');
  assert.equal(next.sent[0], key);
  assert.equal(h.$('session-key').value, '');
  const count = h.sockets.length;
  h.locationState.hash = `#connect=${'z'.repeat(32)}`;
  h.window.emit('hashchange');
  assert.equal(h.locationState.hash, '');
  assert.equal(h.sockets.length, count);
  assert.equal(next.readyState, 1);
  assert.equal(h.$('session-key').value, '');
  h.$('disconnect').emit('click');
});

test('malformed reused-tab QR invitations are removed without authentication', (t) => {
  const h = receiver(t);
  h.$('disconnect').emit('click');
  const count = h.sockets.length;
  h.locationState.hash = `#connect=${'y'.repeat(32)}&other=1`;
  h.window.emit('hashchange');
  assert.equal(h.locationState.hash, '');
  assert.equal(h.sockets.length, count);
});

test('negotiated keyboard input stays on the authenticated socket and releases on blur and suspension', (t) => {
  const h = receiver(t, { keyboard: true, webRtc: true, webCodecs: false });
  assert.equal(h.$('keyboard').hidden, false); h.$('keyboard').emit('click');
  assert.equal(h.$('keyboard-controls').hidden, false);
  h.$('keyboard-input').emit('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
  h.window.emit('blur');
  const keys = () => h.socket.sent.filter((p) => Buffer.isBuffer(p) && p[0] === 8);
  assert.deepEqual(keys().map((p) => p[1]), [2, 0, 2]);
  assert.deepEqual([...keys()[0]], [8,2,0,0,0]);
  h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(h.$('keyboard-controls').hidden, true);
  h.$('keyboard-input').emit('keydown', { code: 'Enter', key: 'Enter' });
  assert.equal(keys().length, 3); h.$('disconnect').emit('click');
});

test('window view-only policy disables touch, keyboard, audio and desktop window controls', async (t) => {
  const h = receiver(t, { keyboard: true, viewOnly: true, webRtc: true, webCodecs: false });
  assert.equal(h.$('keyboard').hidden, true); assert.equal(h.$('touch').disabled, true);
  assert.equal(h.$('audio').disabled, true); assert.equal(h.$('window').hidden, true);
  assert.equal(h.$('drag-mode').disabled, true); h.$('drag-mode').emit('click');
  assert.notEqual(h.$('drag-mode').attrs.get('aria-pressed'), 'true');
  h.$('touch').emit('click'); h.$('keyboard').emit('click'); await h.$('audio').emit('click');
  pointer(h, 'pointerdown', 1, 100, 100); pointer(h, 'pointerup', 1, 100, 100);
  assert.equal(inputs(h).length, 0);
  assert.equal(h.socket.sent.some((p) => Buffer.isBuffer(p) && p[0] === 5 && p[1] === 10), false);
  h.$('disconnect').emit('click');
});

test('soft-keyboard viewport reflow preserves pending physical key pairing', (t) => {
  const h = receiver(t, { keyboard: true, webRtc: true, webCodecs: false });
  h.$('keyboard').emit('click');
  h.$('keyboard-input').emit('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
  h.reflow(); h.$('keyboard-input').emit('keyup', { code: 'ControlLeft', key: 'Control' });
  const keys = h.socket.sent.filter((p) => Buffer.isBuffer(p) && p[0] === 8);
  assert.deepEqual(keys.map((p) => p[1]), [2, 0, 1]);
  h.$('hide-controls').emit('click'); assert.equal(h.$('keyboard-controls').hidden, true);
  h.$('disconnect').emit('click');
});

test('keyboard and Options panels are exclusive; close restores the keyboard trigger', (t) => {
  const h = receiver(t, { keyboard: true });
  h.$('keyboard').emit('click');
  assert.equal(h.$('keyboard-controls').hidden, false);
  assert.equal(h.$('control-panels').hidden, false);
  assert.equal(h.document.activeElement, h.$('keyboard-input'));
  h.$('more').emit('click');
  assert.equal(h.$('keyboard-controls').hidden, true);
  assert.equal(h.$('more-controls').hidden, false);
  h.$('keyboard').emit('click');
  assert.equal(h.$('more-controls').hidden, true);
  assert.equal(h.$('keyboard-controls').hidden, false);
  h.$('close-keyboard').emit('click');
  assert.equal(h.$('keyboard-controls').hidden, true);
  assert.equal(h.document.activeElement, h.$('keyboard'));
  h.$('disconnect').emit('click');
});

test('a shrinking visual viewport keeps typing fitted without breaking paired key releases', (t) => {
  const h = receiver(t, { keyboard: true, visualHeight: 600 });
  h.$('keyboard').emit('click');
  h.$('keyboard-input').emit('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
  h.window.visualViewport.height = 240; h.window.visualViewport.emit('resize');
  assert.equal(h.cssVariables.get('--receiver-height'), '240px');
  h.$('keyboard-input').emit('keyup', { code: 'ControlLeft', key: 'Control' });
  const keys = h.socket.sent.filter(data => Buffer.isBuffer(data) && data[0] === 8);
  assert.deepEqual(keys.map(data => [data[1], data.readUInt16BE(2)]), [[2,0], [0, 224], [1, 224]]);
  assert.equal(h.$('keyboard-controls').hidden, false);
  h.$('disconnect').emit('click');
});

test('keyboard fitting retains viewport offset through fullscreen and does not force page scrolling', async (t) => {
  const h = receiver(t, { keyboard: true, visualHeight: 600 }); let scrolls = 0;
  h.$('keyboard-input').scrollIntoView = () => scrolls++;
  h.$('keyboard').emit('click');
  h.window.visualViewport.height = 180; h.window.visualViewport.offsetTop = 12;
  h.window.visualViewport.emit('resize');
  assert.equal(h.cssVariables.get('--receiver-height'), '180px');
  assert.equal(h.cssVariables.get('--receiver-top'), '12px');
  await h.$('fullscreen').emit('click');
  assert.equal(h.cssVariables.get('--receiver-height'), '180px');
  assert.equal(h.$('fullscreen').attrs.get('aria-label'), 'Exit full screen');
  assert.equal(scrolls, 0); assert.equal(h.$('keyboard-controls').hidden, false);
  h.$('disconnect').emit('click');
});

test('pinch zoom does not refit away the user magnification', (t) => {
  const h = receiver(t, { keyboard: true, visualHeight: 600 });
  h.window.visualViewport.scale = 2; h.window.visualViewport.height = 300;
  h.window.visualViewport.offsetTop = 50; h.window.visualViewport.emit('resize');
  assert.equal(h.cssVariables.get('--receiver-height'), '600px');
  assert.equal(h.cssVariables.get('--receiver-top'), '0px');
  h.$('disconnect').emit('click');
});

test('host capture denial explains the Mac recovery action instead of requesting another code alone', (t) => {
  const h = receiver(t);
  h.socket.readyState = 3; h.socket.emit('close', { code: 1008, reason: 'capture-permission' });
  assert.match(h.$('error').textContent, /allow Screen & System Audio Recording/);
  assert.match(h.$('error').textContent, /restart dskcpy/);
  assert.match(h.$('status').textContent, /^Disconnected/);
});


test('rail pause/resume releases typing and retains an explicit accessible playback state', (t) => {
  const h = receiver(t, { keyboard: true });
  h.$('keyboard').emit('click');
  h.$('keyboard-input').emit('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
  h.$('pause').emit('click');
  assert.equal(h.$('keyboard-controls').hidden, true);
  assert.equal(h.$('pause').attrs.get('aria-label'), 'Resume video');
  assert.equal(h.$('pause').attrs.get('aria-pressed'), 'true');
  assert.equal(h.socket.sent.filter(p => Buffer.isBuffer(p) && p[0] === 8).at(-1)[1], 2);
  h.$('pause').emit('click');
  assert.equal(h.$('pause').attrs.get('aria-label'), 'Pause video');
  assert.equal(h.$('pause').attrs.get('aria-pressed'), 'false');
  const commands = h.socket.sent.filter(p => Buffer.isBuffer(p) && p[0] === 5).map(p => p[1]);
  assert.ok(commands.includes(7)); assert.deepEqual(commands.slice(-2), [8, 11]);
  h.$('disconnect').emit('click');
});


async function audioReceiver(t) {
  const h = receiver(t, { webAudio: true });
  h.media(0, 4, new Uint8Array(19));
  await h.$('audio').emit('click');
  return h;
}

test('WebCodecs audio preserves a fresh 100ms burst without canceling scheduled sound', async (t) => {
  const h = await audioReceiver(t);
  for (let i = 0; i < 10; i++) h.soundDecoders[0].output();
  assert.equal(h.audioSources.length, 10);
  assert.equal(h.audioSources.filter(s => s.stopped).length, 0);
  for (let i = 1; i < h.audioSources.length; i++) {
    const before = h.audioSources[i - 1], after = h.audioSources[i];
    assert.ok(Math.abs(after.startAt - before.startAt - before.buffer.duration) < 1e-9);
  }
  const last = h.audioSources.at(-1);
  assert.ok(last.startAt + last.buffer.duration < .25);
  h.$('disconnect').emit('click');
});

test('WebCodecs audio appends a slightly late packet while prior sound is still scheduled', async (t) => {
  const h = await audioReceiver(t); h.soundDecoders[0].output();
  const before = h.audioSources[0], expected = before.startAt + before.buffer.duration;
  h.audioContexts[0].currentTime = expected - .002;
  h.soundDecoders[0].output();
  assert.ok(Math.abs(h.audioSources[1].startAt - expected) < 1e-9);
  h.$('disconnect').emit('click');
});

test('WebCodecs audio mute and backgrounding cancel sound and ignore old decoder output', async (t) => {
  const h = await audioReceiver(t), old = h.soundDecoders[0]; old.output();
  await h.$('audio').emit('click');
  assert.equal(h.audioSources[0].stopped, true);
  old.output(); assert.equal(h.audioSources.length, 1);
  await h.$('audio').emit('click'); const current = h.soundDecoders.at(-1); current.output();
  h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(h.audioSources.at(-1).stopped, true);
  assert.equal(current.output().closed, true); assert.equal(h.audioSources.length, 2);
  h.$('disconnect').emit('click');
});

test('WebCodecs audio remains bounded during excessive input and recovers after an underrun', async (t) => {
  const h = await audioReceiver(t);
  for (let i = 0; i < 80; i++) h.soundDecoders[0].output();
  const active = h.audioSources.filter(s => !s.stopped);
  assert.ok(active.length <= 24);
  assert.ok(active.at(-1).startAt + active.at(-1).buffer.duration < .25);
  h.audioContexts[0].currentTime = 3;
  h.soundDecoders[0].output();
  assert.ok(h.audioSources.at(-1).startAt > 3 && h.audioSources.at(-1).startAt < 3.1);
  h.$('disconnect').emit('click');
});

test('WebCodecs audio closes oversized output instead of allocating an unbounded playback buffer', async (t) => {
  const h = await audioReceiver(t);
  assert.equal(h.soundDecoders[0].output(48000).closed, true);
  assert.equal(h.audioSources.length, 0);
  h.soundDecoders[0].output(); assert.equal(h.audioSources.length, 1);
  h.$('disconnect').emit('click');
});


test('PiP keeps browser-native video and audio running while the original page is hidden', async t => {
  const h = receiver(t, { webRtc: true, webCodecs: false });
  await h.$('audio').emit('click');
  h.document.pictureInPictureElement = h.$('rtc-display');
  h.document.hidden = true; h.document.emit('visibilitychange');
  assert.equal(h.$('rtc-display').paused, false);
  assert.equal(h.$('rtc-display').muted, false);
  assert.equal(h.socket.sent.at(-3), 'resume');
  assert.deepEqual(h.socket.sent.slice(-2),[Buffer.from([5,8]),Buffer.from([5,10])]);
  assert.ok(!h.socket.sent.includes('suspend'));
  h.document.pictureInPictureElement = null; h.$('rtc-display').emit('leavepictureinpicture');
  assert.equal(h.$('rtc-display').paused, true);
  assert.ok(h.socket.sent.includes('suspend'));
  h.$('disconnect').emit('click');
});

test('transport loss with an expired session uses a saved credential; explicit Disconnect suppresses retry', async t => {
  const h = receiver(t, { webRtc: true, webCodecs: false });
  await new Promise(setImmediate);
  let requests = [];
  h.context.fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => url.endsWith('/session') ? { resumable: false }
      : url.endsWith('/remember/status') ? { status: 'approved', paused: false } : { key: 'r'.repeat(32) } };
  };
  h.socket.readyState = 3; h.socket.emit('close', { code: 1006 });
  await new Promise(resolve => setTimeout(resolve, 280));
  assert.ok(requests.includes('/stream/trusted/connect'));
  assert.equal(h.sockets.length, 2);
  h.sockets[1].emit('open'); assert.equal(h.sockets[1].sent[0], 'r'.repeat(32));
  h.$('disconnect').emit('click'); const before = h.sockets.length;
  h.document.emit('visibilitychange'); h.window.emit('pageshow'); await new Promise(setImmediate);
  assert.equal(h.sockets.length, before);
});


test('arrow pad sends complete direction pairs without opening the soft keyboard', t => {
  const h = receiver(t, { keyboard: true });
  assert.equal(h.$('arrows').hidden, false); assert.equal(h.$('arrows').disabled, false);
  h.$('arrows').emit('click'); assert.equal(h.$('arrow-controls').hidden, false);
  assert.equal(h.document.activeElement, h.$('arrow-up'));
  assert.equal(h.$('keyboard-controls').hidden, true);
  for (const id of ['arrow-up','arrow-left','arrow-down','arrow-right']) h.$(id).emit('click');
  const keys = h.socket.sent.filter(b => Buffer.isBuffer(b) && b[0] === 8);
  assert.deepEqual(keys.map(b => [b[1], b.readUInt16BE(2), b[4]]), [[0,82,0],[1,82,0],[0,80,0],[1,80,0],[0,81,0],[1,81,0],[0,79,0],[1,79,0]]);
  h.$('arrow-controls').emit('keydown', { code: 'ArrowLeft', shiftKey: true });
  assert.deepEqual(h.socket.sent.slice(-2).map(b => [b[1], b.readUInt16BE(2), b[4]]), [[0,80,2],[1,80,0]]);
  h.$('close-arrows').emit('click'); assert.equal(h.$('arrow-controls').hidden, true);
  assert.equal(h.document.activeElement, h.$('arrows'));
  h.$('arrow-up').emit('click'); assert.equal(h.socket.sent.filter(b => Buffer.isBuffer(b) && b[0] === 8).length, 10);
  h.$('disconnect').emit('click');
});

test('arrow actions are blocked while paused, hidden, touch-disabled or disconnected', t => {
  const h = receiver(t, { keyboard: true }); h.$('arrows').emit('click');
  const count = () => h.socket.sent.filter(b => Buffer.isBuffer(b) && b[0] === 8).length;
  h.$('pause').emit('click'); let before = count(); h.$('arrow-up').emit('click');
  assert.equal(count(), before); assert.equal(h.$('arrow-up').disabled, true);
  h.$('pause').emit('click'); h.$('touch').emit('click'); before = count(); h.$('arrow-up').emit('click'); assert.equal(count(), before);
  h.$('touch').emit('click'); h.document.hidden = true; h.document.emit('visibilitychange'); before = count();
  h.$('arrow-controls').emit('keydown', { code: 'ArrowDown' }); assert.equal(count(), before);
  h.document.hidden = false; h.document.emit('visibilitychange'); h.$('disconnect').emit('click'); before = count();
  h.$('arrow-up').emit('click'); assert.equal(count(), before); assert.equal(h.$('arrows').hidden, true);
});

for (const mode of [{ keyboard: false }, { keyboard: true, viewOnly: true }]) test('arrow pad respects authenticated keyboard capability and view-only policy '+JSON.stringify(mode), t => {
  const h = receiver(t, mode); const before = h.socket.sent.length;
  assert.equal(h.$('arrows').hidden, true); h.$('arrows').emit('click'); h.$('arrow-up').emit('click');
  assert.equal(h.socket.sent.length, before); h.$('disconnect').emit('click');
});

test('arrow pad and typing panel are exclusive and Escape restores the arrow trigger', t => {
  const h = receiver(t, { keyboard: true }); h.$('keyboard').emit('click');
  h.$('keyboard-input').emit('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true });
  h.$('arrows').emit('click'); assert.equal(h.$('keyboard-controls').hidden, true);
  assert.ok(h.socket.sent.some(b => Buffer.isBuffer(b) && b[0] === 8 && b[1] === 2));
  h.document.emit('keydown', { key: 'Escape' }); assert.equal(h.$('arrow-controls').hidden, true);
  assert.equal(h.document.activeElement, h.$('arrows'));
  h.$('arrows').emit('click'); h.$('keyboard').emit('click'); assert.equal(h.$('arrow-controls').hidden, true);
  h.$('disconnect').emit('click');
});


for (const [elapsed, expectedSockets] of [[180000,2],[300001,1]]) {
  test(`browser recovery ${elapsed}ms away honors host recovery and remembered-access policy`, async (t) => {
    let clock=1000;
    const h=receiver(t,{now:()=>clock,resumable:true});
    await new Promise(setImmediate); // Let the initial unauthenticated probe finish.
    h.document.hidden=true;h.document.emit('visibilitychange');
    h.socket.readyState=3;h.socket.emit('close',{code:1006});
    clock+=elapsed;
    // This candidate trusts the host's expiry and can separately request a new
    // remembered grant. No remembered ticket is available in this fixture.
    h.context.fetch=async()=>({ok:true,json:async()=>({resumable:elapsed<300000})});
    h.document.hidden=false;h.document.emit('visibilitychange');
    await new Promise(setImmediate);
    assert.equal(h.sockets.length,expectedSockets);
    if(expectedSockets===1)assert.match(h.$('error').textContent,/session ended/);
  });
}


test('editable-focus hints open typing only after opt-in and never refocus an open IME', (t) => {
  let shown=0; const h=receiver(t,{keyboard:true,textFocus:true,virtualKeyboard:{show(){shown++;},boundingRect:{height:0}}});
  assert.equal(h.socket.sent.filter(m => m === 'text-focus-subscribe').length, 1);
  const hint=focused=>h.socket.emit('message',{data:JSON.stringify({type:'text-focus',focused})});
  hint(true);assert.notEqual(h.$('keyboard').attrs.get('aria-expanded'),'true');
  h.$('auto-keyboard').checked=true;h.$('auto-keyboard').emit('change');
  hint(null);hint(false);assert.equal(shown,0);
  hint(true);assert.equal(h.$('keyboard').attrs.get('aria-expanded'),'true');assert.equal(shown,1);
  assert.equal(h.document.activeElement,h.$('keyboard-input'));
  h.$('keyboard-input').value='composing';hint(true);
  assert.equal(h.$('keyboard-input').value,'composing');assert.equal(shown,1);
  h.document.activeElement=h.$('display');hint(true);assert.equal(shown,2);
  assert.equal(h.document.activeElement,h.$('keyboard-input'));
  h.$('close-keyboard').emit('click');h.$('pause').emit('click');hint(true);assert.equal(shown,2);
  h.$('pause').emit('click');h.$('touch').emit('click');hint(true);assert.equal(shown,2);
  h.$('touch').emit('click');h.document.hidden=true;hint(true);assert.equal(shown,2);
  h.document.hidden=false;h.$('disconnect').emit('click');assert.equal(h.$('auto-keyboard').checked,false);
});

test('auto keyboard keeps manual fallback without VirtualKeyboard API and cannot bypass view-only or absent capability', t=>{
  const h=receiver(t,{keyboard:true,textFocus:true});h.$('auto-keyboard').checked=true;h.$('auto-keyboard').emit('change');
  h.socket.emit('message',{data:JSON.stringify({type:'text-focus',focused:true})});
  assert.equal(h.$('keyboard').attrs.get('aria-expanded'),'true');assert.equal(h.$('auto-keyboard-feedback').hidden,false);
  for(const policy of [{keyboard:true},{keyboard:true,textFocus:true,viewOnly:true}]){
    const denied=receiver(t,policy);denied.$('auto-keyboard').checked=true;denied.$('auto-keyboard').emit('change');
    assert.equal(denied.socket.sent.includes('text-focus-subscribe'), false);
    denied.socket.emit('message',{data:JSON.stringify({type:'text-focus',focused:true})});
    assert.notEqual(denied.$('keyboard').attrs.get('aria-expanded'),'true');
    assert.equal(denied.$('auto-keyboard-setting').hidden,true);
  }
});


test('negotiated keyboard failure clears the local context; a deliberate reopen sends a fresh release barrier',t=>{
 const h=receiver(t,{keyboard:true,keyboardStatus:true,textFocus:true});
 assert.ok(h.socket.sent.includes('keyboard-status-subscribe'));
 h.$('keyboard').emit('click');h.$('keyboard-input').value='pending';
 h.socket.emit('message',{data:JSON.stringify({type:'keyboard-status',status:'blocked'})});
 assert.equal(h.$('keyboard-controls').hidden,true);assert.equal(h.$('keyboard-input').value,'');
 assert.match(h.$('error').textContent,/could not accept all keyboard input/);
 const blockedCount=h.socket.sent.length;
 assert.equal(h.$('arrows').disabled,true);
 h.$('arrows').emit('click');h.$('arrow-right').emit('click');
 h.$('auto-keyboard').checked=true;h.$('auto-keyboard').emit('change');
 h.socket.emit('message',{data:JSON.stringify({type:'text-focus',focused:true})});
 h.$('keyboard-input').value='stale';h.$('keyboard-input').emit('input');
 assert.equal(h.$('keyboard-controls').hidden,true);
 assert.equal(h.socket.sent.length,blockedCount);
 const before=h.socket.sent.length;h.$('keyboard').emit('click');
 assert.equal(h.$('keyboard-controls').hidden,false);
 assert.ok(h.socket.sent.slice(before).some(p=>Buffer.isBuffer(p)&&p.equals(Buffer.from([8,2,0,0,0]))));
 h.socket.emit('message',{data:JSON.stringify({type:'keyboard-status',status:'ready'})});
 assert.equal(h.$('error').textContent,'');
});

test('legacy hosts get no new keyboard-status subscription',t=>{
 const h=receiver(t,{keyboard:true});assert.equal(h.socket.sent.includes('keyboard-status-subscribe'),false);
});

test('fresh capture recovery clears old typing and adopts new dimensions without enabling disabled touch', async t=>{
 const h=receiver(t,{keyboard:true,resumable:true});
 h.$('keyboard').emit('click');h.$('keyboard-input').value='old composition';
 h.$('touch').emit('click');
 h.socket.readyState=3;h.socket.emit('close',{code:1012,reason:'capture-restart'});
 assert.equal(h.$('keyboard-controls').hidden,true);assert.equal(h.$('keyboard-input').value,'');
 assert.match(h.$('status').textContent,/Restoring/);
 await new Promise(resolve=>setTimeout(resolve,300));
 assert.equal(h.sockets.length,2);const next=h.sockets[1];next.emit('open');
 next.emit('message',{data:JSON.stringify({type:'authenticated',keyboard:true,viewOnly:false})});
 const header=new ArrayBuffer(16),view=new DataView(header);
 view.setUint32(0,0x53524431);view.setUint32(4,1);view.setUint32(8,1280);view.setUint32(12,720);
 next.emit('message',{data:header});
 assert.equal(h.$('display').width,1280);assert.equal(h.$('display').height,720);
 assert.equal(h.$('touch').attrs.get('aria-pressed'),'false');
 assert.equal(h.$('keyboard-input').value,'');
 assert.ok(!next.sent.some(p=>Buffer.isBuffer(p)&&[3,8,9].includes(p[0])));
 h.$('disconnect').emit('click');
});

for(const code of [1000,1008])test('server-ended capture is terminal even when a remembered fallback could exist: '+code,async t=>{
 const h=receiver(t,{resumable:true});h.socket.readyState=3;h.socket.emit('close',{code,reason:'capture-ended'});
 assert.equal(h.$('join-panel').hidden,false);
 await new Promise(resolve=>setTimeout(resolve,300));assert.equal(h.sockets.length,1);
});

test('fresh WebRTC capture reapplies the explicit audio choice and respects video pause',async t=>{
 const h=receiver(t,{webRtc:true,webCodecs:false,resumable:true});
 await h.$('audio').emit('click');assert.equal(h.$('audio').attrs.get('aria-pressed'),'true');
 h.socket.readyState=3;h.socket.emit('close',{code:1012,reason:'capture-restart'});
 await new Promise(resolve=>setTimeout(resolve,300));const next=h.sockets[1];assert.ok(next);next.emit('open');
 next.emit('message',{data:JSON.stringify({type:'authenticated',mediaMode:'webrtc'})});
 const b=new ArrayBuffer(16),v=new DataView(b);v.setUint32(0,0x53524431);v.setUint32(4,1);v.setUint32(8,1280);v.setUint32(12,720);
 next.emit('message',{data:b});
 const commands=()=>next.sent.filter(p=>Buffer.isBuffer(p)&&p[0]===5).map(p=>p[1]);
 assert.equal(commands().at(-1),10); // New native defaults to muted until this explicit restoration.
 h.$('pause').emit('click');assert.equal(commands().at(-1),11);
 h.$('pause').emit('click');assert.equal(commands().at(-1),10);
 h.$('disconnect').emit('click');
});

test('clipboard is explicit, local preview only, and reset on touch-off and interruption', async t => {
  let reads=0,writes=[];const f=receiver(t,{keyboard:true,clipboard:true,clipboardAPI:{readText:async()=>{reads++;return 'local fixture';},writeText:async text=>{writes.push(text);}}});
  assert.equal(reads,0);assert.equal(f.$('clipboard-tools').hidden,false);assert.equal(f.$('clipboard-enable').checked,false);
  f.$('more').emit('click');f.$('clipboard-tools').open=true;f.$('clipboard-tools').emit('toggle');
  f.$('clipboard-enable').checked=true;f.$('clipboard-enable').emit('change');
  assert.ok(f.socket.sent.includes('clipboard-enable'));assert.equal(reads,0);
  await f.$('clipboard-read-local').emit('click');assert.equal(reads,1);assert.equal(f.$('clipboard-text').value,'local fixture');
  assert.equal(f.socket.sent.filter(x=>Buffer.isBuffer(x)&&x[0]===10).length,0);
  f.$('clipboard-copy-host').emit('click');let packets=f.socket.sent.filter(x=>Buffer.isBuffer(x)&&x[0]===10);
  assert.equal(packets.length,1);assert.equal(packets[0][1],1);assert.equal(packets[0].subarray(8).toString(),'local fixture');
  f.socket.emit('message',{data:JSON.stringify({type:'clipboard-result',op:1,id:1,status:0})});
  assert.match(f.$('clipboard-status').textContent,/copied to the computer/);assert.deepEqual(writes,[]);
  await f.$('clipboard-copy-local').emit('click');assert.deepEqual(writes,['local fixture']);
  f.$('touch').emit('click');assert.equal(f.$('clipboard-text').value,'');assert.equal(f.$('clipboard-enable').checked,false);assert.ok(f.socket.sent.includes('clipboard-disable'));
  f.socket.emit('message',{data:JSON.stringify({type:'clipboard-result',op:0,id:1,status:0,text:'stale fixture'})});assert.equal(f.$('clipboard-text').value,'');
});
test('clipboard preview and opt-in never survive a restored capture, and unadvertised tools stay hidden',t=>{
  const f=receiver(t,{keyboard:true,clipboard:true});f.$('clipboard-enable').checked=true;f.$('clipboard-enable').emit('change');f.$('clipboard-text').value='private fixture';
  f.window.emit('blur');assert.equal(f.$('clipboard-text').value,'');assert.equal(f.$('clipboard-enable').checked,false);
  const older=receiver(t,{keyboard:true});assert.equal(older.$('clipboard-tools').hidden,true);
});

test('browser clipboard denial has a manual fallback and late local reads cannot revive a cleared preview', async t => {
  let release;const f=receiver(t,{keyboard:true,clipboard:true,clipboardAPI:{readText:()=>new Promise(resolve=>{release=resolve;}),writeText:async()=>{throw Error('fixture denial');}}});
  f.$('clipboard-enable').checked=true;f.$('clipboard-enable').emit('change');f.$('clipboard-text').value='manual fixture';
  await f.$('clipboard-copy-local').emit('click');assert.match(f.$('clipboard-status').textContent,/copy manually/);
  const pending=f.$('clipboard-read-local').emit('click');assert.equal(f.$('clipboard-text').disabled,true);
  f.window.emit('blur');release('stale local fixture');await pending;
  assert.equal(f.$('clipboard-text').value,'');assert.equal(f.$('clipboard-enable').checked,false);assert.equal(f.socket.sent.filter(x=>Buffer.isBuffer(x)&&x[0]===10).length,0);
});

test('soft-keyboard viewport changes preserve clipboard preparation without weakening blur cleanup',t=>{
  const f=receiver(t,{keyboard:true,clipboard:true,visualHeight:600});f.$('clipboard-enable').checked=true;f.$('clipboard-enable').emit('change');f.$('clipboard-text').value='prepared fixture';
  f.reflow();f.window.visualViewport.height=220;f.window.visualViewport.emit('resize');
  assert.equal(f.$('clipboard-text').value,'prepared fixture');assert.equal(f.$('clipboard-enable').checked,true);
  f.window.emit('blur');assert.equal(f.$('clipboard-text').value,'');assert.equal(f.$('clipboard-enable').checked,false);
});


test('trackpad sends bounded hover, one tap and held drag, without direct-touch jumps', async t => {
  const h = receiver(t);
  h.$('trackpad-mode').emit('click');
  assert.equal(h.$('trackpad-mode').attrs.get('aria-pressed'), 'true');
  pointer(h, 'pointerdown', 1, 10, 20); pointer(h, 'pointermove', 1, 90, 20); pointer(h, 'pointerup', 1, 90, 20);
  await new Promise(r => setTimeout(r, 25));
  let packets = inputs(h); assert.equal(packets.length, 1); assert.equal(packets[0][0], 7);
  assert.equal(packets[0].readInt32BE(13), 0); assert.equal(packets[0].readInt32BE(17), 0);
  assert.equal(packets[0].readUInt32BE(1), 383);
  pointer(h, 'pointerdown', 2, 500, 250); pointer(h, 'pointerup', 2, 500, 250);
  packets = inputs(h); assert.deepEqual(packets.slice(-2).map(p => p[1]), [0, 1]);
  assert.ok(packets.every(p => validBrowserInput(p, 640, 480)));
  h.$('drag-mode').emit('click'); assert.equal(h.$('drag-mode-label').textContent, 'Release drag');
  pointer(h, 'pointerdown', 3, 300, 200); pointer(h, 'pointermove', 3, 340, 200); pointer(h, 'pointerup', 3, 340, 200);
  h.$('display').emit('lostpointercapture', { pointerId: 3 });
  await new Promise(r => setTimeout(r, 25));
  assert.equal(h.$('drag-mode').attrs.get('aria-pressed'), 'true', 'normal capture release after finger up must preserve deliberate drag');
  h.window.emit('blur'); assert.equal(inputs(h).at(-1)[1], 3); assert.equal(h.$('drag-mode').attrs.get('aria-pressed'), 'false');
});
test('trackpad keyboard alternative, gesture coalescing and lifecycle restrictions', async t => {
  const h = receiver(t);
  h.$('trackpad-mode').emit('click');
  for (let i = 0; i < 100; i++) h.$('display').emit('keydown', { key: 'ArrowRight' });
  await new Promise(r => setTimeout(r, 25)); assert.equal(inputs(h).length, 1);
  h.$('display').emit('keydown', { key: 'Enter', repeat: false });
  assert.deepEqual(inputs(h).slice(-2).map(p => p[1]), [0, 1]);
  h.$('display').emit('keydown', { key: 'Enter', repeat: true }); assert.equal(inputs(h).length, 3);
  h.$('drag-mode').emit('click'); h.$('pause').emit('click');
  const n = inputs(h).length; assert.equal(inputs(h).at(-1)[1], 3);
  h.$('display').emit('keydown', { key: 'Enter' }); pointer(h, 'pointerdown', 1, 10, 10); pointer(h, 'pointerup', 1, 10, 10);
  assert.equal(inputs(h).length, n);
  h.$('pause').emit('click'); h.$('touch').emit('click'); h.$('trackpad-mode').emit('click');
  h.$('display').emit('keydown', { key: 'Enter' }); assert.equal(inputs(h).length, n);
  const readOnly = receiver(t, { viewOnly: true });
  assert.equal(readOnly.$('trackpad-mode').hidden, true); readOnly.$('trackpad-mode').emit('click');
  pointer(readOnly, 'pointerdown', 1, 10, 10); pointer(readOnly, 'pointerup', 1, 10, 10); assert.equal(inputs(readOnly).length, 0);
});


test('trackpad clears queued motion and intentional hold across connection loss', async t => {
  const h = receiver(t); h.$('trackpad-mode').emit('click'); h.$('drag-mode').emit('click');
  h.$('display').emit('keydown', { key: 'ArrowRight' });
  h.socket.close(4001);
  const count = inputs(h).length;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(inputs(h).length, count); assert.equal(h.$('drag-mode').attrs.get('aria-pressed'), 'false');
  assert.equal(h.$('trackpad-mode').disabled, true); assert.equal(h.$('trackpad-cursor').hidden, true);
});


test('local view navigation never emits remote gestures and cancels stale contacts on blur and resize', async t => {
  const h = receiver(t, { keyboard: true });
  h.$('view').emit('click');
  assert.equal(h.$('view').attrs.get('aria-expanded'), 'true');
  const start = h.socket.sent.length;
  const stage = h.$('stage');
  stage.emit('pointerdown', { pointerId: 1, clientX: 200, clientY: 250, button: 0 });
  stage.emit('pointerdown', { pointerId: 2, clientX: 600, clientY: 250, button: 0 });
  stage.emit('pointermove', { pointerId: 2, clientX: 700, clientY: 250 });
  assert.match(h.$('display').style.transform, /scale\(1.25\)/);
  h.window.emit('blur');
  const after = h.$('display').style.transform;
  stage.emit('pointermove', { pointerId: 2, clientX: 750, clientY: 250 });
  assert.equal(h.$('display').style.transform, after);
  stage.emit('pointerdown', { pointerId: 4, clientX: 200, clientY: 200, button: 0 });
  h.reflow();
  const resized = h.$('display').style.transform;
  stage.emit('pointermove', { pointerId: 4, clientX: 400, clientY: 200 });
  assert.equal(h.$('display').style.transform, resized);
  h.$('view-in').emit('click'); h.$('view-right').emit('click'); h.$('view-fit').emit('click');
  assert.match(h.$('display').style.transform, /scale\(1\)/);
  assert.equal(h.socket.sent.length, start);
  h.$('close-view').emit('click');
  assert.equal(h.$('view').attrs.get('aria-expanded'), 'false');
  h.$('disconnect').emit('click');
});


test('phone shortcut controls send one balanced chord and obey pause, touch, view and keyboard gates', async t => {
  const h = receiver(t, { keyboard: true, textFocus: true });
  h.$('shortcuts').emit('click');
  assert.equal(h.$('shortcuts').attrs.get('aria-expanded'), 'true');
  h.$('shortcut-slot').value = '0'; h.$('shortcut-key').value = 'KeyS'; h.$('shortcut-mod-0').checked = true;
  h.$('shortcut-customize').open = true; h.$('shortcut-customize').emit('toggle');
  assert.equal(h.$('shortcut-key').value, 'KeyS', 'a delayed disclosure event cannot discard an edit');
  const before = h.socket.sent.length; h.$('shortcut-form').emit('submit'); assert.equal(h.socket.sent.length, before);
  h.$('shortcut-0').emit('click');
  assert.deepEqual(h.socket.sent.slice(-2).map(p => [...p]), [[8, 0, 0, 22, 1], [8, 1, 0, 22, 0]]);
  h.$('pause').emit('click'); const paused = h.socket.sent.length; h.$('shortcut-0').emit('click'); assert.equal(h.socket.sent.length, paused);
  h.$('pause').emit('click'); h.$('touch').emit('click'); const off = h.socket.sent.length; h.$('shortcut-0').emit('click'); assert.equal(h.socket.sent.length, off);
  h.$('touch').emit('click'); h.$('close-shortcuts').emit('click'); h.$('view').emit('click');
  const view = h.socket.sent.length; h.$('shortcut-0').emit('click'); assert.equal(h.socket.sent.length, view);
  h.$('close-view').emit('click'); h.$('shortcuts').emit('click'); h.$('auto-keyboard').checked = true; h.$('auto-keyboard').emit('change');
  h.socket.emit('message', { data: JSON.stringify({ type: 'text-focus', focused: true }) });
  assert.equal(h.$('shortcuts').attrs.get('aria-expanded'), 'true'); assert.equal(h.$('keyboard-controls').hidden, true);
  h.$('disconnect').emit('click');
});

test('a muted WebCodecs page reapplies native audio-off after resume', t => {
  const h = receiver(t, { webAudio: true });
  const resume = h.socket.sent.lastIndexOf('resume');
  assert.ok(resume >= 0);
  const after = h.socket.sent.slice(resume + 1).filter(p => Buffer.isBuffer(p) && p[0] === 5);
  assert.ok(after.some(p => p[1] === 11), 'mute must follow resume because suspended sessions reject earlier audio commands');
  assert.equal(after.some(p => p[1] === 10), false, 'a fresh muted page must not enable native audio');
});

test('WebCodecs resume enables audio only with prior consent and a running AudioContext', async t => {
  const h = await audioReceiver(t);
  h.$('pause').emit('click');
  let commands = h.socket.sent.filter(p => Buffer.isBuffer(p) && p[0] === 5);
  assert.equal(commands.at(-1)[1], 11);
  h.$('pause').emit('click');
  commands = h.socket.sent.filter(p => Buffer.isBuffer(p) && p[0] === 5);
  assert.equal(commands.at(-1)[1], 10);
  h.audioContexts[0].state = 'suspended';
  const before = h.socket.sent.length;
  h.window.emit('pageshow');
  commands = h.socket.sent.slice(before).filter(p => Buffer.isBuffer(p) && p[0] === 5);
  assert.equal(commands.some(p => p[1] === 10), false);
  assert.equal(commands.at(-1)[1], 11);
  assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio off');
});


function offerRtc(h) {
  h.socket.emit('message', { data: JSON.stringify({ type: 'rtc-offer', description: { type: 'offer', sdp: 'owned' } }) });
}

test('negotiated RTC failure releases typing, blocks stale input and resumes the existing cookie in WebCodecs', async t => {
  const h = receiver(t, { webRtc: true, keyboard: true, mediaFallback: true, rtcOffer: async () => { throw Error('owned RTC failure'); } });
  assert.deepEqual(Array.from(h.socket.protocols), [protocol.MEDIA_FALLBACK_PROTOCOL]);
  h.$('keyboard').emit('click'); h.$('keyboard-input').emit('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
  offerRtc(h); await new Promise(setImmediate);
  assert.equal(h.socket.sent.filter(x => x === 'media-fallback').length, 1);
  assert.equal(h.socket.readyState, 1); assert.equal(h.rtcReceivers[0].closed, true);
  assert.equal(h.$('keyboard-controls').hidden, true);
  assert.equal(h.socket.sent.filter(p => Buffer.isBuffer(p) && p[0] === 8).at(-1)[1], 2);
  const before = h.socket.sent.length;
  h.$('keyboard-input').value = 'must not send'; h.$('keyboard-input').emit('input');
  h.$('arrow-left').emit('click'); h.rtcReceivers[0].onFailure('late duplicate'); h.rtcReceivers[0].onPlaying();
  assert.equal(h.socket.sent.length, before); assert.match(h.$('status').textContent, /another video method/);
  h.context.fetch = async () => ({ ok: true, json: async () => ({ resumable: true, mediaMode: 'webcodecs' }) });
  h.socket.close(1012, 'media-fallback'); await new Promise(r => setTimeout(r, 300));
  assert.equal(h.sockets.length, 2); const next = h.sockets[1]; assert.match(next.url, /\/stream$/);
  assert.equal(next.sent.some(x => typeof x === 'string' && /^[A-Za-z0-9_-]{32}$/.test(x)), false);
  next.emit('message', { data: JSON.stringify({ type: 'authenticated', keyboard: true, mediaMode: 'webcodecs' }) });
  const header = new ArrayBuffer(16), view = new DataView(header);
  view.setUint32(0, 0x53524431); view.setUint32(4, 1); view.setUint32(8, 640); view.setUint32(12, 480);
  next.emit('message', { data: header });
  assert.equal(h.$('join-panel').hidden, true); assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio off');
  assert.equal(next.sent.some(p => Buffer.isBuffer(p) && p[0] === 5 && p[1] === 10), false);
  h.rtcReceivers[0].onPlaying(); h.rtcReceivers[0].onFailure('stale');
  assert.notEqual(h.$('status').textContent, 'Streaming'); h.$('disconnect').emit('click');
});

test('RTC recovery defers while away or paused and requests once on deliberate return', async t => {
  for (const mode of ['away', 'paused']) {
    const h = receiver(t, { webRtc: true, mediaFallback: true, rtcOffer: async () => { throw Error('owned'); } });
    if (mode === 'away') { h.document.hidden = true; h.document.emit('visibilitychange'); }
    else h.$('pause').emit('click');
    offerRtc(h); await new Promise(setImmediate);
    assert.equal(h.socket.sent.includes('media-fallback'), false); assert.equal(h.$('join-panel').hidden, true);
    if (mode === 'away') { h.document.hidden = false; h.document.emit('visibilitychange'); }
    else h.$('pause').emit('click');
    assert.equal(h.socket.sent.filter(x => x === 'media-fallback').length, 1);
    h.$('disconnect').emit('click');
  }
});

test('playback gesture errors do not downgrade media; unsupported viewers and old hosts keep their contract', async t => {
  const h = receiver(t, { webRtc: true, mediaFallback: true }); offerRtc(h);
  h.rtcReceivers[0].onError('Tap Resume to start browser playback.');
  assert.equal(h.socket.sent.includes('media-fallback'), false); assert.match(h.$('error').textContent, /Tap Resume/);
  h.$('disconnect').emit('click');
  for (const options of [{ webCodecs: false, mediaFallback: true }, { mediaFallback: false }]) {
    const legacy = receiver(t, { webRtc: true, ...options, rtcOffer: async () => { throw Error('owned unsupported'); } });
    offerRtc(legacy); await new Promise(setImmediate);
    assert.equal(legacy.socket.sent.includes('media-fallback'), false); assert.equal(legacy.$('join-panel').hidden, false);
    if (options.webCodecs === false) assert.equal(legacy.socket.protocols.length, 0);
  }
});

test('Disconnect during RTC setup prevents a late rejection from recovering access', async t => {
  let reject;
  const h = receiver(t, { webRtc: true, mediaFallback: true, rtcOffer: () => new Promise((resolve, fail) => { reject = fail; }) });
  offerRtc(h); h.$('disconnect').emit('click'); reject(Error('late owned failure')); await new Promise(setImmediate);
  assert.equal(h.socket.sent.includes('media-fallback'), false); assert.equal(h.sockets.length, 1);
  assert.equal(h.$('join-panel').hidden, false); assert.match(h.$('status').textContent, /Disconnected/);
});

test('server media fallback retires pending RTC work before the reconnect delay', async t => {
  let reject;
  const h = receiver(t, { webRtc: true, mediaFallback: true, rtcOffer: () => new Promise((resolve, fail) => { reject = fail; }) });
  offerRtc(h); h.socket.close(1012, 'media-fallback'); reject(Error('retired RTC setup'));
  await new Promise(setImmediate);
  assert.equal(h.$('join-panel').hidden, true);
  assert.match(h.$('status').textContent, /Restoring browser video/);
  assert.equal(h.$('error').textContent, ''); h.$('disconnect').emit('click');
});

test('negotiated media acknowledgment survives missing close metadata without a fresh code', async t => {
  const h = receiver(t, { webRtc: true, mediaFallback: true });
  h.context.fetch = async () => ({ ok: true, json: async () => ({ resumable: true, mediaMode: 'webcodecs' }) });
  h.socket.emit('message', { data: JSON.stringify({ type: 'media-fallback', mediaMode: 'webcodecs' }) });
  h.socket.close(1005, ''); await new Promise(r => setTimeout(r, 300));
  assert.equal(h.sockets.length, 2); assert.match(h.sockets[1].url, /\/stream$/);
  assert.equal(h.$('join-panel').hidden, true); assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio off');
  h.$('disconnect').emit('click');
});

test('media recovery never starts remembered capture when its original session ended', async t => {
  const h = receiver(t, { webRtc: true, mediaFallback: true }); const routes = [];
  h.context.fetch = async url => { routes.push(url); return { ok: true, json: async () => url === '/stream/session' ? { resumable: false } : { status: 'approved', key: 'x'.repeat(32) } }; };
  h.socket.emit('message', { data: JSON.stringify({ type: 'media-fallback', mediaMode: 'webcodecs' }) });
  h.socket.close(1005, ''); await new Promise(r => setTimeout(r, 300));
  assert.equal(h.sockets.length, 1); assert.equal(routes.includes('/stream/trusted/connect'), false);
  assert.equal(routes.includes('/stream/remember/status'), false); assert.equal(h.$('join-panel').hidden, false);
  assert.match(h.$('error').textContent, /Sharing ended while restoring video/);
});

test('media acknowledgments require the negotiated capability and cannot override explicit Stop', async t => {
  for (const options of [{ mediaFallback: false }, { mediaFallback: true, webCodecs: false }]) {
    const h = receiver(t, { webRtc: true, ...options });
    h.socket.emit('message', { data: JSON.stringify({ type: 'media-fallback', mediaMode: 'webcodecs' }) });
    assert.equal(h.$('join-panel').hidden, false); assert.match(h.$('error').textContent, /Unexpected media recovery/);
  }
  for (const code of [1000, 1008, 4000, 4002]) {
    const h = receiver(t, { webRtc: true, mediaFallback: true });
    h.socket.emit('message', { data: JSON.stringify({ type: 'media-fallback', mediaMode: 'webcodecs' }) });
    h.socket.close(code, 'capture-ended'); await new Promise(setImmediate);
    assert.equal(h.$('join-panel').hidden, false); assert.equal(h.sockets.length, 1);
  }
});

test('retiring media ignores queued advisories and cannot signal from its old RTC peer', async t => {
  const h = receiver(t, { webRtc: true, mediaFallback: true, keyboard: true, keyboardStatus: true, textFocus: true,
    rtcOffer: async () => { throw Error('owned failure'); } });
  offerRtc(h); await new Promise(setImmediate);
  const before = h.socket.sent.length;
  h.rtcReceivers[0].signal({ type: 'rtc-answer', description: { type: 'answer', sdp: 'retired' } });
  assert.equal(h.socket.sent.length, before, 'retired RTC signaling cannot cross the media boundary');
  h.socket.emit('message', { data: JSON.stringify({ type: 'keyboard-status', status: 'blocked' }) });
  h.socket.emit('message', { data: JSON.stringify({ type: 'text-focus', focused: true }) });
  offerRtc(h); h.media(100, 4);
  assert.equal(h.$('join-panel').hidden, true); assert.match(h.$('status').textContent, /another video method/);
  assert.equal(h.rtcReceivers.length, 1);
  h.socket.emit('message', { data: JSON.stringify({ type: 'media-fallback', mediaMode: 'webcodecs' }) });
  assert.equal(h.$('join-panel').hidden, true); h.$('disconnect').emit('click');
});

test('audio and keyboard controls cannot queue actions during the recovery reconnect gap', async t => {
  const h = receiver(t, { webRtc: true, keyboard: true, mediaFallback: true }); offerRtc(h);
  h.socket.emit('message', { data: JSON.stringify({ type: 'media-fallback', mediaMode: 'webcodecs' }) });
  h.socket.close(1005, '');
  await h.$('audio').emit('click');
  assert.equal(h.$('audio').attrs.get('aria-label'), 'Audio off');
  assert.equal(h.$('keyboard').disabled, true); assert.equal(h.sockets.length, 1);
  h.$('disconnect').emit('click');
});

test('Disconnect cancels the retained capture even before the retiring socket closes', async t => {
  const h = receiver(t, { webRtc: true, mediaFallback: true }); const requests = [];
  h.context.fetch = async (url, options) => { requests.push({url,options}); return {ok:true,json:async()=>({resumable:false})}; };
  h.socket.emit('message', { data: JSON.stringify({ type: 'media-fallback', mediaMode: 'webcodecs' }) });
  assert.equal(h.socket.readyState, 1); h.$('disconnect').emit('click');
  await new Promise(setImmediate);
  assert.equal(requests.filter(r => r.url === '/stream/session' && r.options.method === 'POST' && r.options.credentials === 'same-origin').length, 1);
  assert.equal(h.sockets.length, 1); assert.equal(h.$('join-panel').hidden, false);
});

test('automatic-video controls stay capability gated and report actual native settings',t=>{
 for(const opts of [{},{adaptiveVideo:true,viewOnly:true}]) {
  const h=receiver(t,opts);assert.equal(h.$('video-quality-setting').hidden,true);assert.equal(h.socket.sent.includes('video-quality-subscribe'),false);
 }
 const h=receiver(t,{adaptiveVideo:true});assert.ok(h.socket.sent.includes('video-quality-subscribe'));
 assert.equal(h.$('video-quality-setting').hidden,false);
 h.socket.emit('message',{data:JSON.stringify({type:'video-quality',available:true,automatic:true,level:1,fps:30,bitRate:7200000})});
 assert.match(h.$('video-quality-status').textContent,/30 FPS cap.*7.2 Mbps target/);
 assert.equal(h.$('video-automatic').checked,true);h.$('video-automatic').checked=false;h.$('video-automatic').emit('change');
 assert.ok(h.socket.sent.includes(JSON.stringify({type:'video-automatic',enabled:false})));
 h.$('pause').emit('click');assert.equal(h.$('video-automatic').disabled,true);
 h.socket.emit('message',{data:JSON.stringify({type:'video-quality',available:false,automatic:false})});
 assert.match(h.$('video-quality-status').textContent,/last working/);assert.equal(h.$('video-automatic').disabled,true);
 h.$('disconnect').emit('click');assert.equal(h.$('video-quality-setting').hidden,true);
});

test('WebKit missing close metadata resumes only an acknowledged window switch and never downgrades its grant',async t=>{
 const h=receiver(t,{viewOnly:true,windowSwitch:true,resumable:true});
 const catalog={type:'window-state',grant:'g'.repeat(16),current:'a'.repeat(16),switching:true,windows:[{key:'a'.repeat(16),label:'Editor'},{key:'b'.repeat(16),label:'Notes'}]};
 h.socket.emit('message',{data:JSON.stringify(catalog)});h.socket.emit('close',{code:1005,reason:''});
 await new Promise(r=>setTimeout(r,300));assert.equal(h.sockets.length,2);
 assert.equal(h.$('join-panel').hidden,true);
 const failed=receiver(t,{viewOnly:true,windowSwitch:true,resumable:false});let trustAttempts=0;
 failed.context.fetch=async route=>{if(String(route).includes('trusted')||String(route).includes('remember'))trustAttempts++;return {ok:true,json:async()=>({resumable:false})};};
 failed.socket.emit('message',{data:JSON.stringify(catalog)});failed.socket.emit('close',{code:1005,reason:''});
 await new Promise(r=>setTimeout(r,300));assert.equal(trustAttempts,0);assert.equal(failed.sockets.length,1);
 assert.match(failed.$('error').textContent,/Sharing ended while restoring/);
 assert.equal(failed.$('window-choice-list').children.length,0);
});
test('unacknowledged 1005 remains terminal and an unsolicited window catalog grants no capability',async t=>{
 const h=receiver(t,{viewOnly:true,windowSwitch:true,resumable:true});h.socket.emit('close',{code:1005,reason:''});
 await new Promise(r=>setTimeout(r,300));assert.equal(h.sockets.length,1);assert.equal(h.$('join-panel').hidden,false);
 const other=receiver(t,{viewOnly:true});other.socket.emit('message',{data:JSON.stringify({type:'window-state',grant:'g'.repeat(16),current:'a'.repeat(16),switching:true,windows:[{key:'a'.repeat(16),label:'Editor'},{key:'b'.repeat(16),label:'Notes'}]})});
 assert.equal(other.$('join-panel').hidden,false);assert.match(other.$('error').textContent,/Unexpected window/);
});
