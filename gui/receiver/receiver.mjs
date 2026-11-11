import { avcCodec, avcParameters, touchPacket, scrollPacket, takeDecodedTimestamps, fitDisplay, createMediaAcknowledger, needsControlsRow, parseJoinFragment } from './protocol.mjs';
import { createRtcReceiver } from './rtc.mjs';
import { createVideoReceiver } from './video.mjs';

const $ = (id) => document.getElementById(id);
function takeJoinFragment() {
  const fragment = location.hash || '';
  const key = parseJoinFragment(fragment);
  if (fragment.startsWith('#connect=')) {
    window.history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  return key;
}
let scannedKey = takeJoinFragment();
const canvas = $('display');
const rtcDisplay = $('rtc-display');
let rtcReceiver, mediaMode = 'webcodecs';
const preferredMode = 'RTCPeerConnection' in window ? 'webrtc' : 'webcodecs';
const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
let ws, video, audio, audioContext, videoConfig, configBytes, audioConfig;
let authenticated = false, header = false, closing = false, paused = false, muted = true, touchEnabled = true;
let frames = 0, statsAt = 0, nextAudio = 0, repeatTimer, repeatInterval;
const sources = new Set();
const pointers = new Map();
const pendingAudioAcks = [];
let generation = 0;
let sessionExpected = false, retryTimer, connectionTimer, resumeDeadline = 0, probing = false;
let resumeAllowed = true;
let audioGeneration = 0, fullscreenAttempt = 0, playbackAttempt = 0;
const mediaAcks = createMediaAcknowledger(send);
const controlTrays = [
  { trigger: 'volume', panel: 'volume-controls', first: 'volume-down' },
  { trigger: 'window', panel: 'window-controls', first: 'minimize' },
  { trigger: 'more', panel: 'more-controls' },
];
let openControlTray = null;
let selectDrag = false, touchGesture = null;

function send(bytes) {
  if (!authenticated || !header || ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(bytes); return true;
}
function action(value) { send(new Uint8Array([5, value])); }
function stopAudio() {
  for (const source of sources) { try { source.stop(); } catch { /* Already ended. */ } }
  sources.clear(); nextAudio = 0;
}
function drainAudioAcks(all = false) {
  for (const pts of takeDecodedTimestamps(pendingAudioAcks, all ? 0 : audio?.decodeQueueSize ?? 0)) mediaAcks.acknowledge(6, pts);
}
function audioUnavailable() {
  muted = true; stopAudio(); drainAudioAcks(true); action(11);
  if (audio && audio.state !== 'closed') audio.close(); audio = null;
  $('audio').textContent = 'Audio unsupported'; $('audio').disabled = true;
  $('audio').setAttribute('aria-label', 'Audio unsupported');
  $('audio').setAttribute('aria-pressed', 'false');
  $('error').textContent = 'Opus audio is unavailable in this browser. Video can continue.';
}
function releaseTouches() {
  cancelSentTouches();
  pointers.clear();
  touchGesture = null;
  clearTimeout(repeatTimer); clearInterval(repeatInterval);
}
function fail(message) { $('error').textContent = message; disconnect(); }
function clearMedia() {
  playbackAttempt++;
  rtcReceiver?.close(); rtcReceiver = null;
  rtcDisplay.hidden = true; document.body.classList.remove('rtc-stream');
  stopAudio(); pendingAudioAcks.length = 0;
  audioGeneration++;
  video?.close(); video = null;
  if (audio && audio.state !== 'closed') audio.close(); audio = null;
  header = false; videoConfig = null; configBytes = null; audioConfig = null;
}
function disconnect() {
  if (closing) return;
  closing = true;
  resumeAllowed = false;
  generation++;
  if (sessionExpected && ws?.readyState !== WebSocket.OPEN) void fetch('/stream/session', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  sessionExpected = false; resumeDeadline = 0;
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  clearTimeout(retryTimer); clearTimeout(connectionTimer);
  releaseTouches(); stopAudio(); drainAudioAcks(true);
  ws?.close(4000, 'Disconnected by viewer'); ws = null;
  clearMedia();
  if (audioContext) void audioContext.close().catch(() => {}); audioContext = null;
  authenticated = false; header = false; muted = true; paused = false;
  videoConfig = null; configBytes = null; audioConfig = null; frames = 0;
  context.clearRect(0, 0, canvas.width, canvas.height);
  $('join-panel').hidden = false; $('stream-panel').hidden = true;
  document.body.classList.remove('is-streaming', 'controls-hidden');
  $('join').disabled = false; $('join').textContent = 'Connect';
  $('status').textContent = 'Disconnected · create a new code on the computer';
  $('audio').textContent = 'Audio off'; $('audio').setAttribute('aria-pressed', 'false');
  $('audio').disabled = false;
  $('pause').setAttribute('aria-pressed', 'false');
  $('pause').textContent = 'Pause'; $('pause').setAttribute('aria-label', 'Pause video');
  $('audio').setAttribute('aria-label', 'Audio off');
  setControlTray(); $('show-controls').hidden = true;
  if (!document.hidden) $('session-key').focus();
  closing = false;
}

async function resumeSession() {
  if (document.hidden || ws || probing || !supported || !resumeAllowed) return;
  if (sessionExpected && resumeDeadline && Date.now() > resumeDeadline) {
    fail('The session expired while you were away. Create a new code on the computer.'); return;
  }
  probing = true;
  const mine = generation;
  try {
    const response = await fetch('/stream/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const sessionInfo = response.ok ? await response.json() : {};
    const available = sessionInfo.resumable;
    if (mine !== generation || ws || document.hidden) return;
    if (available) {
      sessionExpected = true; resumeDeadline ||= Date.now() + 120000;
      $('error').textContent = ''; connect(null, sessionInfo.mediaMode || preferredMode);
    } else if (sessionExpected) {
      // Do not POST on an expired session: it has already been revoked.
      sessionExpected = false;
      fail('This session ended or expired. Create a new code on the computer.');
    }
  } catch {
    if (mine === generation && sessionExpected) {
      $('status').textContent = 'Reconnecting…';
      retryTimer = setTimeout(resumeSession, 1500);
    }
  } finally { probing = false; }
}

const supported = window.isSecureContext && (preferredMode === 'webrtc'
  || ('VideoDecoder' in window && 'EncodedVideoChunk' in window));
$('capability').textContent = supported ? 'Browser video is available. Connect using the computer’s private link.'
  : 'Use a current browser and the trusted HTTPS link from the computer.';
if (!supported) $('join').disabled = true;

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!supported || ws) return;
  const key = $('session-key').value.trim();
  if (!/^[A-Za-z0-9_-]{32}$/.test(key)) {
    $('error').textContent = 'Paste the full connection code from Browser receiver on the computer.';
    $('session-key').setAttribute('aria-invalid', 'true'); $('session-key').focus(); return;
  }
  $('session-key').removeAttribute('aria-invalid'); $('error').textContent = '';
  $('session-key').value = '';
  resumeAllowed = true;
  connect(key);
});

function connect(key = null, requestedMode = preferredMode) {
  mediaAcks.reset();
  $('join').disabled = true; $('join').textContent = 'Connecting…'; $('status').textContent = 'Authenticating…';
  if (!key) $('status').textContent = 'Reconnecting…';
  const mine = ++generation;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${requestedMode === 'webrtc' ? '/stream/webrtc' : '/stream'}`);
  ws = socket; socket.binaryType = 'arraybuffer';
  const timeout = connectionTimer = setTimeout(() => { if (mine === generation && !document.hidden && !paused) fail('Connection timed out. Check the desktop invitation and receiver address.'); }, 15000);
  socket.addEventListener('open', () => { if (key) { socket.send(key); key = null; } }, { once: true });
  // The close event decides whether this is a resumable network interruption.
  socket.addEventListener('error', () => {});
  socket.addEventListener('close', (event) => {
    clearTimeout(timeout);
    if (mine !== generation) return;
    releaseTouches(); clearMedia(); ws = null; authenticated = false;
    if (sessionExpected && ![1000, 1008, 4000, 4002].includes(event.code)) {
      resumeDeadline ||= Date.now() + 120000;
      $('status').textContent = document.hidden ? 'Paused while away' : 'Reconnecting…';
      retryTimer = setTimeout(resumeSession, 250);
    } else {
      sessionExpected = false;
      fail(event.code === 4002 ? 'The stream moved to another browser tab. Continue there.' : 'The session ended. Create a new link and code on the computer.');
    }
  });
  socket.addEventListener('message', (event) => {
    if (mine !== generation) return;
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'rtc-offer' && authenticated && mediaMode === 'webrtc') {
          if (rtcReceiver) throw new Error('Unexpected repeated media offer.');
          rtcDisplay.hidden = false; rtcDisplay.muted = muted;
          document.body.classList.add('rtc-stream');
          rtcReceiver = createRtcReceiver({ element: rtcDisplay,
            signal: (value) => { if (mine === generation && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); },
            onPlaying: () => {
              if (mine !== generation || paused || document.hidden) return;
              clearTimeout(timeout); $('status').textContent = 'Streaming'; $('error').textContent = '';
              $('stats').textContent = `${canvas.width} × ${canvas.height} · WebRTC · native browser video and audio`;
            }, onError: (message) => { if (mine === generation) $('error').textContent = message; } });
          void rtcReceiver.offer(message.description).catch((error) => { if (mine === generation) fail(error.message); });
          return;
        }
        if (message.type !== 'authenticated') throw new Error('Unexpected receiver response.');
        mediaMode = message.mediaMode || 'webcodecs';
        if (mediaMode === 'webcodecs' && !('VideoDecoder' in window)) throw new Error('This connection needs WebCodecs. Use the private VPN link for browser-native video.');
        authenticated = true; sessionExpected = true;
        $('status').textContent = 'Connected · waiting for video';
        $('join-panel').hidden = true; $('stream-panel').hidden = false;
        document.body.classList.add('is-streaming');
        return;
      }
      if (!authenticated) throw new Error('Unauthenticated media.');
      const data = new DataView(event.data);
      if (!header) {
        if (data.byteLength !== 16 || data.getUint32(0) !== 0x53524431 || data.getUint32(4) !== 1) throw new Error('Unsupported stream protocol.');
        canvas.width = data.getUint32(8); canvas.height = data.getUint32(12);
        header = true; action(11); // Start muted. Enable only from a user gesture.
        fitCanvas(); updatePause();
        if (!muted && audioContext?.state === 'running' && !document.hidden) action(10);
        return;
      }
      if (data.byteLength < 16 || data.getUint32(0) !== data.byteLength - 16) throw new Error('Incomplete media packet.');
      const timestamp = Number(data.getBigUint64(4));
      if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid media timestamp.');
      const flags = data.getUint32(12), payload = new Uint8Array(event.data, 16);
      if (flags === 16) {
        stopAudio(); drainAudioAcks(true); audioGeneration++;
        if (audio && audio.state !== 'closed') audio.close(); audio = null;
        $('audio').textContent = 'Audio unavailable'; $('audio').setAttribute('aria-label', 'Audio unavailable');
        $('audio').disabled = true; return;
      }
      if (flags === 4) {
        audioConfig = payload.slice(); $('audio').disabled = false;
        $('audio').textContent = muted ? 'Audio off' : 'Audio on';
        $('audio').setAttribute('aria-label', $('audio').textContent);
        if (mediaMode !== 'webrtc') configureAudio(); return;
      }
      if (flags === 8) {
        if (!muted && !paused && !document.hidden && audio?.state === 'configured' && audio.decodeQueueSize < 4) {
          try {
            pendingAudioAcks.push(timestamp);
            audio.decode(new EncodedAudioChunk({ type: 'key', timestamp, data: payload }));
          } catch { audioUnavailable(); }
        } else mediaAcks.acknowledge(6, timestamp);
        return;
      }
      if (mediaMode === 'webrtc') return;
      if ((flags & 1) || (!videoConfig && (flags & 2))) {
        configBytes = avcParameters(payload);
        videoConfig = { codec: avcCodec(configBytes), codedWidth: canvas.width,
          codedHeight: canvas.height, optimizeForLatency: true };
        createVideoDecoder();
        if (flags & 1) return;
      }
      if (paused || document.hidden) { mediaAcks.acknowledge(4, timestamp); return; }
      if (!video || !configBytes) throw new Error('Missing H.264 configuration.');
      const keyFrame = Boolean(flags & 2);
      let encoded = payload;
      if (keyFrame) {
        encoded = new Uint8Array(configBytes.length + payload.length); encoded.set(configBytes); encoded.set(payload, configBytes.length);
      }
      video.decode(new EncodedVideoChunk({ type: keyFrame ? 'key' : 'delta', timestamp, data: encoded }));
    } catch (error) { fail(error.message || 'The receiver could not decode this stream.'); }
  });

  function createVideoDecoder() {
    video ||= createVideoReceiver({ suspended: paused || document.hidden,
      onError: (message) => { if (mine === generation) fail(message); },
      onKeyframe: () => { if (mine === generation) action(8); },
      onAck: (timestamp) => { if (mine === generation) mediaAcks.acknowledge(4, timestamp); },
      onFrame: (frame) => {
        if (mine !== generation || paused || document.hidden) return;
        context.drawImage(frame, 0, 0, canvas.width, canvas.height); frames++;
        clearTimeout(timeout);
        $('status').textContent = 'Streaming';
        if (performance.now() - statsAt > 1000) {
          $('stats').textContent = `${canvas.width} × ${canvas.height} · ${frames} decoded frames · H.264 · decode ACK, not motion-to-photon latency`;
          statsAt = performance.now();
        }
      } });
    video.configure(videoConfig);
  }
}

function suspendDecoder() {
  video?.suspend();
  drainAudioAcks(true);
  audioGeneration++;
  if (audio && audio.state !== 'closed') audio.close(); audio = null;
}

function configureAudio() {
  if (!audioConfig || !audioContext || muted) return;
  drainAudioAcks(true);
  const mine = generation, epoch = ++audioGeneration;
  if (audio && audio.state !== 'closed') audio.close();
  audio = new AudioDecoder({ error: () => { if (mine === generation && epoch === audioGeneration) audioUnavailable(); },
    output: (data) => {
      try {
        if (mine !== generation || epoch !== audioGeneration) return;
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
  audio.addEventListener('dequeue', () => { if (mine === generation && epoch === audioGeneration) drainAudioAcks(); });
  try { audio.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: audioConfig }); }
  catch { audioUnavailable(); }
}
$('audio').addEventListener('click', async () => {
  if (mediaMode === 'webrtc') {
    const mine = generation, attempt = ++playbackAttempt;
    const updateButton = () => {
      $('audio').textContent = muted ? 'Audio off' : 'Audio on';
      $('audio').setAttribute('aria-label', $('audio').textContent);
      $('audio').setAttribute('aria-pressed', String(!muted));
    };
    muted = !muted; rtcDisplay.muted = muted; action(muted ? 11 : 10);
    updateButton();
    if (!muted) try { await rtcDisplay.play(); } catch {
      if (mine !== generation || attempt !== playbackAttempt || !authenticated) return;
      muted = true; rtcDisplay.muted = true; action(11);
      $('error').textContent = 'Audio could not start. Tap Audio off to try again.';
    }
    if (mine !== generation || attempt !== playbackAttempt || !authenticated) return;
    updateButton(); return;
  }
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
  if (!$('audio').disabled) $('audio').textContent = muted ? 'Audio off' : 'Audio on'; $('audio').setAttribute('aria-pressed', String(!muted));
  $('audio').setAttribute('aria-label', $('audio').textContent);
});
function updatePause() {
  if (!authenticated || !header || ws?.readyState !== WebSocket.OPEN) return;
  releaseTouches(); stopAudio();
  suspendDecoder();
  if (!document.hidden && !paused) video?.resume();
  ws.send(document.hidden ? 'suspend' : 'resume');
  action(paused || document.hidden ? 7 : 8);
  if (document.hidden) resumeDeadline ||= Date.now() + 120000;
  else resumeDeadline = 0;
  if (mediaMode === 'webrtc') {
    const mine = generation, attempt = ++playbackAttempt;
    if (document.hidden || paused) { rtcDisplay.muted = true; rtcDisplay.pause?.(); }
    else { rtcDisplay.muted = muted; void rtcDisplay.play?.().catch(() => {
      if (mine === generation && attempt === playbackAttempt && authenticated) {
        $('error').textContent = 'Tap Resume to restart browser playback.';
      }
    }); }
  }
  if (mediaMode !== 'webrtc' && !document.hidden && !muted && audioContext?.state !== 'running') {
    // Mobile browsers may suspend audio independently of the video connection.
    // Ask for a fresh tap instead of showing an inaccurate "Audio on" state.
    muted = true; action(11); $('audio').textContent = 'Audio off';
    $('audio').setAttribute('aria-label', 'Audio off'); $('audio').setAttribute('aria-pressed', 'false');
  }
  if (!document.hidden && !paused) configureAudio();
  $('status').textContent = document.hidden ? 'Paused while away' : paused ? 'Video paused' : 'Resuming…';
}
$('pause').addEventListener('click', () => {
  paused = !paused; updatePause();
  $('pause').textContent = paused ? 'Resume' : 'Pause'; $('pause').setAttribute('aria-pressed', String(paused));
  $('pause').setAttribute('aria-label', paused ? 'Resume video' : 'Pause video');
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(connectionTimer);
  updatePause();
  if (!document.hidden) void resumeSession();
});
window.addEventListener('blur', releaseTouches);
window.addEventListener('pagehide', () => {
  releaseTouches(); stopAudio(); clearTimeout(connectionTimer);
  suspendDecoder();
  if (authenticated && ws?.readyState === WebSocket.OPEN) ws.send('suspend');
  ws?.close(4001, 'Page suspended');
});
window.addEventListener('pageshow', () => { updatePause(); void resumeSession(); });
void resumeSession();
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
  const p = { ...point(event), id, clientX: event.clientX, clientY: event.clientY, touch: event.pointerType === 'touch', sent: false };
  pointers.set(event.pointerId, p); canvas.setPointerCapture(event.pointerId);
  if (p.touch) {
    const center = touchCenter();
    if (center.count === 1) {
      touchGesture = { start: center, last: center, scrolling: false, multiple: false };
      if (selectDrag) sendContact(p, 0);
    } else {
      cancelSentTouches();
      touchGesture.multiple = true; touchGesture.scrolling = true; touchGesture.last = center;
    }
  } else sendContact(p, [...pointers.values()].some((item) => item.sent) ? 5 : 0);
});
canvas.addEventListener('pointermove', (event) => {
  const previous = pointers.get(event.pointerId); if (!previous) return;
  event.preventDefault();
  const p = { ...previous, ...point(event), clientX: event.clientX, clientY: event.clientY }; pointers.set(event.pointerId, p);
  if (!p.touch) { if (p.sent) sendContact(p, 2); return; }
  if (!touchGesture) return;
  const center = touchCenter();
  // After a two-finger scroll, lifting one finger must not start a click/drag.
  if (touchGesture.multiple && center.count < 2) return;
  if (p.sent && !touchGesture.multiple) { sendContact(p, 2); return; }
  if (!touchGesture.scrolling && Math.hypot(center.clientX - touchGesture.start.clientX, center.clientY - touchGesture.start.clientY) < 8) return;
  touchGesture.scrolling = true;
  send(scrollPacket(center.x, center.y, canvas.width, canvas.height,
    touchGesture.last.clientX - center.clientX, touchGesture.last.clientY - center.clientY));
  touchGesture.last = center;
});
for (const [name, actionCode] of [['pointerup', 1], ['pointercancel', 3], ['lostpointercapture', 3]]) {
  canvas.addEventListener(name, (event) => {
    const p = pointers.get(event.pointerId); if (!p) return;
    if (actionCode === 3) { releaseTouches(); return; }
    event.preventDefault();
    if (p.sent) sendContact(p, [...pointers.values()].filter((item) => item.sent).length > 1 ? 6 : 1);
    else if (p.touch && touchGesture && !touchGesture.scrolling && !touchGesture.multiple) {
      sendContact(p, 0); sendContact(p, 1);
    }
    pointers.delete(event.pointerId);
    if (!touchCenter().count) touchGesture = null;
  });
}
function sendContact(point, action) {
  send(touchPacket(action, point.id, point.x, point.y, canvas.width, canvas.height));
  point.sent = ![1, 3, 6].includes(action);
}
function cancelSentTouches() {
  const sent = [...pointers.values()].find((point) => point.sent);
  if (sent) send(touchPacket(3, sent.id, sent.x, sent.y, canvas.width, canvas.height));
  for (const point of pointers.values()) point.sent = false;
}
function touchCenter() {
  const points = [...pointers.values()].filter((point) => point.touch);
  const center = { x: 0, y: 0, clientX: 0, clientY: 0, count: points.length };
  for (const point of points) for (const axis of ['x', 'y', 'clientX', 'clientY']) center[axis] += point[axis] / points.length;
  return center;
}
canvas.addEventListener('wheel', (event) => {
  if (!touchEnabled || paused || !header) return;
  event.preventDefault();
  const p = point(event), scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
  send(scrollPacket(p.x, p.y, canvas.width, canvas.height, event.deltaX * scale, event.deltaY * scale));
}, { passive: false });
canvas.addEventListener('contextmenu', (event) => { if (touchEnabled && !paused) event.preventDefault(); });
$('drag-mode').addEventListener('click', () => {
  releaseTouches(); selectDrag = !selectDrag;
  $('drag-mode').textContent = selectDrag ? 'Drag: select' : 'Drag: scroll';
  $('drag-mode').setAttribute('aria-pressed', String(selectDrag));
});
$('disconnect').addEventListener('click', disconnect);
$('fullscreen').addEventListener('click', async () => {
  const attempt = ++fullscreenAttempt, mine = generation;
  $('orientation-help').hidden = true;
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await $('stream-panel').requestFullscreen();
    if (mine !== generation || attempt !== fullscreenAttempt || !document.fullscreenElement) return;
  } catch {
    $('error').textContent = 'Full screen is unavailable in this browser. You can rotate the device for a wider view.'; return;
  }
  try {
    if (!screen.orientation?.lock) throw new Error('Orientation lock unavailable');
    // Request landscape even when already sideways, allowing either landscape
    // direction while keeping fullscreen playback out of portrait mode.
    await screen.orientation.lock('landscape');
    if (!document.fullscreenElement) unlockOrientation();
  } catch {
    if (mine === generation && attempt === fullscreenAttempt && document.fullscreenElement && innerHeight > innerWidth) {
      $('orientation-help').textContent = 'This browser could not rotate automatically. Turn your phone sideways for landscape.';
      $('orientation-help').hidden = false;
    }
  }
});
function unlockOrientation() {
  try { screen.orientation?.unlock?.(); } catch { /* Orientation API is optional. */ }
}
function setControlTray(name = null, focus = false) {
  releaseTouches();
  const previous = openControlTray;
  openControlTray = name;
  for (const tray of controlTrays) {
    const expanded = tray.trigger === name;
    $(tray.panel).hidden = !expanded;
    $(tray.trigger).setAttribute('aria-expanded', String(expanded));
  }
  fitCanvas();
  if (focus) {
    const tray = controlTrays.find((item) => item.trigger === name);
    $(tray?.first || name || previous)?.focus();
  }
}
for (const { trigger } of controlTrays) {
  $(trigger).addEventListener('click', () => setControlTray(openControlTray === trigger ? null : trigger, true));
}
function setControlsVisible(visible) {
  setControlTray();
  document.body.classList.toggle('controls-hidden', !visible);
  $('show-controls').hidden = visible;
  fitCanvas();
  (visible ? $('hide-controls') : $('show-controls')).focus();
}
$('hide-controls').addEventListener('click', () => setControlsVisible(false));
$('show-controls').addEventListener('click', () => setControlsVisible(true));
function fitCanvas() {
  releaseTouches();
  const panel = $('stream-panel'), padding = getComputedStyle(panel);
  const fullHeight = panel.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
  const fullWidth = panel.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
  panel.classList.toggle('controls-reserved', document.body.classList.contains('controls-hidden')
    && needsControlsRow(canvas.width, canvas.height, fullWidth, fullHeight));
  const bounds = $('stage').getBoundingClientRect();
  const size = fitDisplay(canvas.width, canvas.height, bounds.width, bounds.height);
  canvas.style.width = `${size.width}px`; canvas.style.height = `${size.height}px`;
  rtcDisplay.style.width = `${size.width}px`; rtcDisplay.style.height = `${size.height}px`;
}
new ResizeObserver(fitCanvas).observe($('stage'));
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) { fullscreenAttempt++; unlockOrientation(); $('orientation-help').hidden = true; }
  $('fullscreen').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  fitCanvas();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') {
  releaseTouches();
  if (openControlTray) setControlTray(null, true);
  if (document.body.classList.contains('controls-hidden')) setControlsVisible(true);
} });
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

function joinInvitation(key) {
  if (key && supported && !ws) {
    $('session-key').value = key;
    $('join-form').requestSubmit();
  }
}
// Camera/browser links can reuse this document with a fragment-only navigation.
// Always scrub the invitation, without replacing an already connected viewer.
window.addEventListener('hashchange', () => joinInvitation(takeJoinFragment()));
joinInvitation(scannedKey);
scannedKey = null;
