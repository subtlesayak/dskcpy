import { ack, avcCodec, avcParameters, touchPacket, takeDecodedTimestamps } from './protocol.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('display');
const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
let ws, video, audio, audioContext, videoConfig, configBytes, audioConfig;
let authenticated = false, header = false, closing = false, paused = false, muted = true, touchEnabled = true;
let waitingKey = true, frames = 0, statsAt = 0, nextAudio = 0, repeatTimer, repeatInterval;
const sources = new Set();
const pointers = new Map();
const pendingAudioAcks = [];
let generation = 0;

function send(bytes) { if (authenticated && header && ws?.readyState === WebSocket.OPEN) ws.send(bytes); }
function action(value) { send(new Uint8Array([5, value])); }
function stopAudio() {
  for (const source of sources) { try { source.stop(); } catch { /* Already ended. */ } }
  sources.clear(); nextAudio = 0;
}
function drainAudioAcks(all = false) {
  for (const pts of takeDecodedTimestamps(pendingAudioAcks, all ? 0 : audio?.decodeQueueSize ?? 0)) send(ack(6, pts));
}
function audioUnavailable() {
  muted = true; stopAudio(); drainAudioAcks(true); action(11);
  if (audio && audio.state !== 'closed') audio.close(); audio = null;
  $('audio').textContent = 'Audio unsupported'; $('audio').disabled = true;
  $('audio').setAttribute('aria-pressed', 'false');
  $('error').textContent = 'Opus audio is unavailable in this browser. Video can continue.';
}
function releaseTouches() {
  for (const point of pointers.values()) send(touchPacket(3, point.id, point.x, point.y, canvas.width, canvas.height));
  pointers.clear();
  clearTimeout(repeatTimer); clearInterval(repeatInterval);
}
function fail(message) { $('error').textContent = message; disconnect(); }
function disconnect() {
  if (closing) return;
  closing = true;
  generation++;
  releaseTouches(); stopAudio(); drainAudioAcks(true);
  ws?.close(); ws = null;
  if (video && video.state !== 'closed') video.close(); video = null;
  if (audio && audio.state !== 'closed') audio.close(); audio = null;
  if (audioContext) void audioContext.close().catch(() => {}); audioContext = null;
  authenticated = false; header = false; muted = true; paused = false;
  videoConfig = null; configBytes = null; audioConfig = null; frames = 0; waitingKey = true;
  context.clearRect(0, 0, canvas.width, canvas.height);
  $('join-panel').hidden = false; $('stream-panel').hidden = true;
  $('join').disabled = false; $('join').textContent = 'Connect';
  $('status').textContent = 'Disconnected · create a new key on the desktop';
  $('audio').textContent = 'Enable audio'; $('audio').setAttribute('aria-pressed', 'false');
  $('audio').disabled = false;
  $('pause').textContent = 'Pause video'; $('pause').setAttribute('aria-pressed', 'false');
  if (!document.hidden) $('session-key').focus();
  closing = false;
}

const supported = window.isSecureContext && 'VideoDecoder' in window && 'EncodedVideoChunk' in window;
$('capability').textContent = supported ? 'WebCodecs video available. The host codec is checked when connecting.'
  : 'This browser needs WebCodecs over HTTPS (or localhost). Try a current Chrome or Edge browser.';
if (!supported) $('join').disabled = true;

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!supported || ws) return;
  const key = $('session-key').value.trim();
  if (!/^[A-Za-z0-9_-]{32}$/.test(key)) {
    $('error').textContent = 'Enter the 32-character key from Browser receiver on the desktop.';
    $('session-key').setAttribute('aria-invalid', 'true'); $('session-key').focus(); return;
  }
  $('session-key').removeAttribute('aria-invalid'); $('error').textContent = '';
  $('session-key').value = '';
  $('join').disabled = true; $('join').textContent = 'Connecting…'; $('status').textContent = 'Authenticating…';
  const mine = ++generation;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream`);
  ws = socket; socket.binaryType = 'arraybuffer';
  const timeout = setTimeout(() => { if (mine === generation) fail('Connection timed out. Check the desktop invitation and receiver address.'); }, 15000);
  socket.addEventListener('open', () => socket.send(key), { once: true });
  socket.addEventListener('error', () => { if (mine === generation) fail('Cannot connect. Create a fresh key and check the private HTTPS receiver address.'); });
  socket.addEventListener('close', () => { clearTimeout(timeout); if (mine === generation) disconnect(); });
  socket.addEventListener('message', (event) => {
    if (mine !== generation) return;
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type !== 'authenticated') throw new Error('Unexpected receiver response.');
        authenticated = true;
        $('status').textContent = 'Connected · waiting for video';
        $('join-panel').hidden = true; $('stream-panel').hidden = false;
        return;
      }
      if (!authenticated) throw new Error('Unauthenticated media.');
      const data = new DataView(event.data);
      if (!header) {
        if (data.byteLength !== 16 || data.getUint32(0) !== 0x53524431 || data.getUint32(4) !== 1) throw new Error('Unsupported stream protocol.');
        canvas.width = data.getUint32(8); canvas.height = data.getUint32(12);
        header = true; action(11); // Start muted. Enable only from a user gesture.
        return;
      }
      if (data.byteLength < 16 || data.getUint32(0) !== data.byteLength - 16) throw new Error('Incomplete media packet.');
      const timestamp = Number(data.getBigUint64(4));
      if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid media timestamp.');
      const flags = data.getUint32(12), payload = new Uint8Array(event.data, 16);
      if (flags === 16) { $('audio').textContent = 'Audio unavailable'; $('audio').disabled = true; return; }
      if (flags === 4) { audioConfig = payload.slice(); configureAudio(); return; }
      if (flags === 8) {
        if (!muted && !paused && !document.hidden && audio?.state === 'configured' && audio.decodeQueueSize < 4) {
          try {
            pendingAudioAcks.push(timestamp);
            audio.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: payload }));
          } catch { audioUnavailable(); }
        } else send(ack(6, timestamp));
        return;
      }
      if ((flags & 1) || (!video && (flags & 2))) {
        configBytes = avcParameters(payload);
        videoConfig = { codec: avcCodec(configBytes), optimizeForLatency: true };
        if (video && video.state !== 'closed') video.close();
        video = new VideoDecoder({ error: () => fail('This browser could not decode the host H.264 stream. Try a lower resolution or another encoder.'),
          output: (frame) => {
            try {
              if (!paused && !document.hidden) {
                context.drawImage(frame, 0, 0, canvas.width, canvas.height); frames++;
                clearTimeout(timeout);
                $('status').textContent = 'Streaming';
                if (performance.now() - statsAt > 1000) {
                  $('stats').textContent = `${canvas.width} × ${canvas.height} · ${frames} decoded frames · H.264 · decode ACK, not motion-to-photon latency`;
                  statsAt = performance.now();
                }
              }
              send(ack(4, frame.timestamp));
            } finally { frame.close(); }
          } });
        video.configure(videoConfig); waitingKey = true;
        if (flags & 1) return;
      }
      if (paused || document.hidden) { send(ack(4, timestamp)); waitingKey = true; return; }
      if (!video || !configBytes) throw new Error('Missing H.264 configuration.');
      const keyFrame = Boolean(flags & 2);
      if (waitingKey && !keyFrame) { send(ack(4, timestamp)); return; }
      if (video.decodeQueueSize > 2) throw new Error('Video decoder stalled. Reconnect to clear the backlog.');
      let encoded = payload;
      if (keyFrame) {
        encoded = new Uint8Array(configBytes.length + payload.length); encoded.set(configBytes); encoded.set(payload, configBytes.length);
        if (waitingKey) { video.reset(); video.configure(videoConfig); }
        waitingKey = false;
      }
      video.decode(new EncodedVideoChunk({ type: keyFrame ? 'key' : 'delta', timestamp, data: encoded }));
    } catch (error) { fail(error.message || 'The receiver could not decode this stream.'); }
  });
});

function configureAudio() {
  if (!audioConfig || !audioContext || muted) return;
  drainAudioAcks(true);
  if (audio && audio.state !== 'closed') audio.close();
  audio = new AudioDecoder({ error: audioUnavailable,
    output: (data) => {
      try {
        if (!muted && !paused && !document.hidden && audioContext?.state === 'running') {
          if (nextAudio > audioContext.currentTime + .08 || sources.size >= 8) stopAudio();
          const buffer = audioContext.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
          for (let channel = 0; channel < data.numberOfChannels; channel++) {
            data.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: 'f32-planar' });
          }
          const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination);
          sources.add(source); source.onended = () => sources.delete(source);
          nextAudio = Math.max(audioContext.currentTime + .005, nextAudio);
          source.start(nextAudio); nextAudio += buffer.duration;
        }
      } finally { data.close(); }
    } });
  // Opus pre-skip can shift output timestamps. Return the exact native packet
  // timestamp as its input leaves the bounded decoder queue, not AudioData's
  // adjusted timestamp (which is not a valid native ACK).
  audio.addEventListener('dequeue', () => drainAudioAcks());
  try { audio.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: audioConfig }); }
  catch { audioUnavailable(); }
}
$('audio').addEventListener('click', async () => {
  if (!('AudioDecoder' in window)) { $('error').textContent = 'WebCodecs Opus audio is unavailable in this browser. Video still works.'; return; }
  if (!muted) { muted = true; stopAudio(); drainAudioAcks(true); action(11); }
  else {
    const mine = generation;
    try {
      audioContext ||= new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await audioContext.resume();
      if (mine !== generation || !authenticated) return;
      muted = false; configureAudio(); if (!muted) action(10);
    } catch { $('error').textContent = 'Audio could not start. Check browser playback permissions.'; return; }
  }
  if (!$('audio').disabled) $('audio').textContent = muted ? 'Enable audio' : 'Mute audio'; $('audio').setAttribute('aria-pressed', String(!muted));
});
function updatePause() {
  releaseTouches(); stopAudio(); waitingKey = true;
  action(paused || document.hidden ? 7 : 8);
  $('status').textContent = paused || document.hidden ? 'Video paused' : 'Resuming…';
}
$('pause').addEventListener('click', () => {
  paused = !paused; updatePause();
  $('pause').textContent = paused ? 'Resume video' : 'Pause video'; $('pause').setAttribute('aria-pressed', String(paused));
});
document.addEventListener('visibilitychange', updatePause);
window.addEventListener('blur', releaseTouches);
window.addEventListener('pagehide', disconnect);
$('touch').addEventListener('click', () => {
  releaseTouches(); touchEnabled = !touchEnabled;
  $('touch').textContent = touchEnabled ? 'Touch on' : 'Touch off'; $('touch').setAttribute('aria-pressed', String(touchEnabled));
});
function point(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
}
canvas.addEventListener('pointerdown', (event) => {
  if (!touchEnabled || paused || !header || pointers.size >= 10 || event.button !== 0) return;
  event.preventDefault();
  const used = new Set([...pointers.values()].map((p) => p.id));
  let id = 0; while (used.has(id)) id++;
  const p = { ...point(event), id }; pointers.set(event.pointerId, p);
  canvas.setPointerCapture(event.pointerId); send(touchPacket(0, id, p.x, p.y, canvas.width, canvas.height));
});
canvas.addEventListener('pointermove', (event) => {
  const previous = pointers.get(event.pointerId); if (!previous) return;
  const p = { ...point(event), id: previous.id }; pointers.set(event.pointerId, p);
  send(touchPacket(2, p.id, p.x, p.y, canvas.width, canvas.height));
});
for (const [name, actionCode] of [['pointerup', 1], ['pointercancel', 3], ['lostpointercapture', 3]]) {
  canvas.addEventListener(name, (event) => {
    const p = pointers.get(event.pointerId); if (!p) return;
    pointers.delete(event.pointerId); send(touchPacket(actionCode, p.id, p.x, p.y, canvas.width, canvas.height));
  });
}
$('disconnect').addEventListener('click', disconnect);
$('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('stream-panel').requestFullscreen(); }
  catch { $('error').textContent = 'Full screen is unavailable in this browser. You can rotate the device for a wider view.'; }
});
$('more').addEventListener('click', () => {
  $('more-controls').hidden = !$('more-controls').hidden;
  $('more').setAttribute('aria-expanded', String(!$('more-controls').hidden));
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { releaseTouches(); $('more-controls').hidden = true; $('more').setAttribute('aria-expanded', 'false'); } });
for (const [id, code] of [['volume-down', 0], ['volume-up', 1], ['minimize', 3], ['maximize', 4]]) {
  const button = $(id);
  button.addEventListener('click', () => action(code));
  if (code > 1) continue;
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    button.setPointerCapture(event.pointerId);
    repeatTimer = setTimeout(() => { action(code); repeatInterval = setInterval(() => action(code), 100); }, 450);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) button.addEventListener(name, () => { clearTimeout(repeatTimer); clearInterval(repeatInterval); });
}
