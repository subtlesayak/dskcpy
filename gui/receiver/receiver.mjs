import { rememberedBrowser } from './remembered.mjs';
import { createBrowserClipboard } from './clipboard.mjs';
import { createKeyboardShortcuts, shortcutLabel } from './shortcuts.mjs';
import { createDesktopView } from './view.mjs';
import { createRelativeTrackpad } from './trackpad.mjs';
import { receiverIsAway } from './lifecycle.mjs';
import { BROWSER_RESUME_MS, MEDIA_FALLBACK_PROTOCOL, avcCodec, avcParameters, touchPacket, scrollPacket, takeDecodedTimestamps, fitDisplay, createMediaAcknowledger, needsControlsRow, parseJoinFragment } from './protocol.mjs';
import { createRtcReceiver } from './rtc.mjs';
import { createVideoReceiver } from './video.mjs';
import { createBrowserKeyboard, keyboardUsage, keyPacket } from './keyboard.mjs';

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
function setRailLabel(id, label) {
  $(id).setAttribute('aria-label', label); $(id).setAttribute('title', label);
  $(`${id}-label`).textContent = label;
}
const canvas = $('display');
const rtcDisplay = $('rtc-display');
const away = () => receiverIsAway({ hidden: document.hidden, pictureInPictureElement: document.pictureInPictureElement, video: rtcDisplay, presentationMode: rtcDisplay.webkitPresentationMode });
const remembered = rememberedBrowser({ reconnect: () => { resumeAllowed = true; void resumeSession(); } });
let rtcReceiver, mediaMode = 'webcodecs';
let keyboardSupported = false, keyboardOpen = false, viewOnly = false;
let focusSupported = false, autoKeyboard = false, keyboardStatusSupported = false, keyboardBlocked = false;
const keyboardStatusMessage = $('keyboard-status');
const autoSetting = $('auto-keyboard-setting'), autoToggle = $('auto-keyboard'), autoFeedback = $('auto-keyboard-feedback');
function clearFocusCapability(clearPreference = true) {
  focusSupported = false; keyboardStatusSupported = false; keyboardBlocked = false;
  if (keyboardStatusMessage) keyboardStatusMessage.hidden = true;
  if (clearPreference) autoKeyboard = false;
  if (autoSetting) autoSetting.hidden = true;
  if (autoToggle) autoToggle.checked = autoKeyboard;
  if (autoFeedback) autoFeedback.hidden = true;
}
function autoFocusKeyboard(focused) {
  if (openControlTray === 'shortcuts' || viewNavigationActive() || focused !== true || !focusSupported || !autoKeyboard || !canSendKeys() || away()) return;
  if (clipboardTools?.isActive()) return;
  const field = $('keyboard-input');
  if (keyboardOpen && document.activeElement === field) return;
  if (!keyboardOpen) showKeyboard(); else keyboardInput.setEnabled(true);
  const vk = typeof navigator === 'undefined' ? null : navigator.virtualKeyboard;
  // Do not change viewport/overlay policy. Chromium can use sticky activation
  // from the opt-in gesture; other browsers keep a direct-tap fallback.
  if (typeof vk?.show === 'function') {
    const policy = field.virtualKeyboardPolicy;
    try { field.virtualKeyboardPolicy = 'manual'; field.focus(); vk.show(); }
    catch { /* Platform policy can still refuse the software keyboard. */ }
    finally { field.virtualKeyboardPolicy = policy || 'auto'; }
  }
  if (autoFeedback) {
    autoFeedback.textContent = 'If your phone keyboard stays closed, tap the typing field.';
    autoFeedback.hidden = !!vk?.boundingRect?.height; fitCanvas();
  }
}
if (autoToggle) autoToggle.addEventListener('change', () => { autoKeyboard = focusSupported && autoToggle.checked; });
if (typeof navigator !== 'undefined') navigator.virtualKeyboard?.addEventListener?.('geometrychange', () => {
  if (autoFeedback && navigator.virtualKeyboard.boundingRect.height > 0) autoFeedback.hidden = true;
});
const preferredMode = 'RTCPeerConnection' in window ? 'webrtc' : 'webcodecs';
const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
let ws, video, audio, audioContext, videoConfig, configBytes, audioConfig;
let authenticated = false, header = false, closing = false, paused = false, muted = true, touchEnabled = true;
let mediaSwitching = false;
let resumePendingMedia;
let sameCaptureRecovery = false;
let frames = 0, statsAt = 0, nextAudio = 0, repeatTimer, repeatInterval;
// Allow one preserved 100ms capture chunk plus bounded network/decoder jitter.
// A larger discontinuity still resynchronizes instead of accumulating audio.
const audioStartLead = .02, audioMaximumLead = .16, audioMaximumSources = 24;
const sources = new Map(); // BufferSource -> scheduled end on the audio clock.
const pointers = new Map();
const pendingAudioAcks = [];
let generation = 0;
let sessionExpected = false, retryTimer, connectionTimer, resumeDeadline = 0, probing = false;
let resumeAllowed = true;
let audioGeneration = 0, fullscreenAttempt = 0, playbackAttempt = 0;
const mediaAcks = createMediaAcknowledger(send);
const controlTrays = [
  { trigger: 'more', panel: 'more-controls', first: 'close-options' },
];
// Tolerate an older document during a static-assets-only rolling update.
const arrowPadPresent = ['arrows', 'arrow-controls', 'close-arrows', 'arrow-up', 'arrow-left', 'arrow-down', 'arrow-right'].every(id => $(id));
if (arrowPadPresent) controlTrays.push({ trigger: 'arrows', panel: 'arrow-controls', first: 'arrow-up' });
const shortcutsPresent = ['shortcuts', 'shortcut-controls', 'close-shortcuts', 'shortcut-form', 'shortcut-slot', 'shortcut-key', 'shortcut-reset', 'shortcut-status', 'shortcut-customize', ...Array.from({ length: 6 }, (_, i) => `shortcut-${i}`), ...Array.from({ length: 4 }, (_, i) => `shortcut-mod-${i}`)].every(id => $(id));
if (shortcutsPresent) controlTrays.push({ trigger: 'shortcuts', panel: 'shortcut-controls', first: 'shortcut-0' });
const viewPresent = ['view', 'view-controls', 'close-view', 'view-scale', 'view-in', 'view-out', 'view-fit', 'view-up', 'view-down', 'view-left', 'view-right'].every(id => $(id));
if (viewPresent) controlTrays.push({ trigger: 'view', panel: 'view-controls', first: 'close-view' });
let openControlTray = null;
const viewNavigationActive = () => viewPresent && openControlTray === 'view';
let selectDrag = false, touchGesture = null, trackpadMode = false;
const trackpadPresent = ['trackpad-mode', 'trackpad-cursor', 'trackpad-help'].every(id => $(id));
let trackMoveTimer, pendingTrackMove;
function canSendPointer() {
  return !mediaSwitching && !viewNavigationActive() && authenticated && header && !paused && !document.hidden && !away() && touchEnabled && !viewOnly && ws?.readyState === WebSocket.OPEN;
}
function flushTrackMove() {
  clearTimeout(trackMoveTimer); trackMoveTimer = null;
  const p = pendingTrackMove; pendingTrackMove = null;
  if (p && canSendPointer()) send(p);
}
function trackpadPacket(p) {
  if (p.type !== 'cancel' && !canSendPointer()) return false;
  const packet = p.type === 'hover' || p.type === 'scroll'
    ? scrollPacket(p.x, p.y, p.width, p.height, p.dx || 0, p.dy || 0)
    : touchPacket(({ down: 0, up: 1, move: 2, cancel: 3 })[p.type], 0, p.x, p.y, p.width, p.height);
  if (p.type === 'hover' || p.type === 'move') {
    pendingTrackMove = packet;
    trackMoveTimer ||= setTimeout(flushTrackMove, 16);
    return true;
  }
  if (p.type === 'cancel') { clearTimeout(trackMoveTimer); trackMoveTimer = null; pendingTrackMove = null; }
  else flushTrackMove();
  return send(packet);
}
const trackpad = createRelativeTrackpad({ geometry: () => {
  const rect = canvas.getBoundingClientRect();
  return { width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height };
}, emit: trackpadPacket, changed: paintTrackpad });
function paintTrackpad() {
  if (!trackpadPresent) return;
  $('trackpad-mode').disabled = !canSendPointer(); $('trackpad-mode').hidden = viewOnly;
  $('trackpad-mode').setAttribute('aria-pressed', String(trackpadMode));
  $('trackpad-help').hidden = !trackpadMode || keyboardOpen || !!openControlTray;
  document.body.classList.toggle('trackpad-help-only', trackpadMode && !keyboardOpen && !openControlTray);
  canvas.tabIndex = trackpadMode ? 0 : -1;
  canvas.setAttribute('aria-label', trackpadMode ? 'Remote trackpad. Arrow keys move the pointer. Enter or Space clicks. Page Up and Page Down scroll.' : 'Streamed desktop. Touch to control when input is enabled.');
  if (trackpadMode) canvas.setAttribute('aria-describedby', 'trackpad-help'); else canvas.removeAttribute('aria-describedby');
  const label = trackpadMode ? trackpad.dragging ? 'Release drag' : 'Start drag' : selectDrag ? 'Select and drag' : 'Scroll gestures';
  setRailLabel('drag-mode', label); $('drag-mode').setAttribute('aria-pressed', String(trackpadMode ? trackpad.dragging : selectDrag));
  const cursor = $('trackpad-cursor'), p = trackpad.position();
  cursor.hidden = !trackpadMode || !canSendPointer() || !p;
  if (!cursor.hidden) {
    const video = canvas.getBoundingClientRect(), surface = $('stage'), stage = surface.getBoundingClientRect();
    const sx = stage.width > 0 ? surface.clientWidth / stage.width : 1;
    const sy = stage.height > 0 ? surface.clientHeight / stage.height : 1;
    cursor.style.left = `${(video.left - stage.left + p.x / p.width * video.width) * sx}px`;
    cursor.style.top = `${(video.top - stage.top + p.y / p.height * video.height) * sy}px`;
  }
}
const desktopView = createDesktopView({ changed: paintView });
let viewImageSize = '';
function paintView() {
  const v = desktopView.state();
  for (const media of [canvas, rtcDisplay]) {
    media.style.transformOrigin = 'center';
    media.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
  }
  if (viewPresent) {
    $('view-scale').textContent = `Zoom: ${Math.round(v.scale * 100)}%`;
    $('view').disabled = !authenticated || !header || away();
    for (const id of ['view-in', 'view-out', 'view-fit', 'view-up', 'view-down', 'view-left', 'view-right']) $(id).disabled = !canMoveView();
    $('view-in').disabled ||= v.scale >= 4;
    $('view-out').disabled ||= v.scale <= 1;
  }
  paintTrackpad();
}
function viewPoint(event) {
  const stage = $('stage'), rect = stage.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * stage.clientWidth / rect.width,
    y: (event.clientY - rect.top) * stage.clientHeight / rect.height };
}
function canMoveView() { return viewNavigationActive() && authenticated && header && !document.hidden && !away(); }
function announceView() { if ($('view-announcement')) $('view-announcement').textContent = $('view-scale').textContent; }
if (viewPresent) {
  const stage = $('stage');
  stage.addEventListener('pointerdown', event => {
    if (!viewNavigationActive()) return;
    event.preventDefault(); event.stopPropagation();
    if (!canMoveView() || event.button !== 0) return;
    const p = viewPoint(event); stage.setPointerCapture(event.pointerId); desktopView.down(event.pointerId, p.x, p.y);
  }, true);
  stage.addEventListener('pointermove', event => {
    if (!viewNavigationActive()) return;
    event.preventDefault(); event.stopPropagation();
    if (canMoveView()) { const p = viewPoint(event); desktopView.move(event.pointerId, p.x, p.y); }
  }, true);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(name, event => {
    if (!viewNavigationActive()) return;
    event.preventDefault(); event.stopPropagation();
    if (name === 'pointerup') { desktopView.up(event.pointerId); announceView(); }
    else if (desktopView.hasPointer(event.pointerId)) desktopView.cancel();
  }, true);
  stage.addEventListener('wheel', event => {
    if (!viewNavigationActive()) return;
    event.preventDefault(); event.stopPropagation();
    if (!canMoveView()) return;
    const p = viewPoint(event), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
    if (event.ctrlKey) desktopView.zoomBy(Math.exp(-Math.max(-100, Math.min(100, event.deltaY * unit)) / 200), p.x, p.y);
    else desktopView.panBy(-event.deltaX * unit, -event.deltaY * unit);
  }, { capture: true, passive: false });
  const viewAction = fn => { if (!canMoveView()) return; releaseTouches(false); fn(); announceView(); };
  for (const [id, factor] of [['view-in', 1.5], ['view-out', 1 / 1.5]]) $(id).addEventListener('click', () => viewAction(() => desktopView.zoomBy(factor)));
  $('view-fit').addEventListener('click', () => viewAction(() => desktopView.reset()));
  for (const [id, dx, dy] of [['view-left', 80, 0], ['view-right', -80, 0], ['view-up', 0, 80], ['view-down', 0, -80]])
    $(id).addEventListener('click', () => viewAction(() => desktopView.panBy(dx, dy)));
  $('close-view').addEventListener('click', () => setControlTray(null, true));
  stage.addEventListener('keydown', event => {
    if (!canMoveView() || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const directions = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
    if (directions[event.key]) { event.preventDefault(); event.stopPropagation(); viewAction(() => desktopView.panBy(...directions[event.key])); }
    else if (['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); viewAction(() => event.key === '0' ? desktopView.reset() : desktopView.zoomBy(event.key === '-' ? 1 / 1.5 : 1.5));
    }
  });
}
const keyboardInput = createBrowserKeyboard({ field: $('keyboard-input'), send,
  canSend: () => !mediaSwitching && !viewNavigationActive() && !keyboardBlocked && keyboardSupported && authenticated && header && !paused && !document.hidden && touchEnabled && !viewOnly,
  onError: (message) => { $('error').textContent = message; } });
function canSendKeys() {
  return !mediaSwitching && !viewNavigationActive() && !keyboardBlocked && keyboardSupported && authenticated && header && !paused && !document.hidden && touchEnabled && !viewOnly && ws?.readyState === WebSocket.OPEN;
}
const clipboardTools = $('clipboard-tools') ? createBrowserClipboard({ section: $('clipboard-tools'), field: $('clipboard-text'), toggle: $('clipboard-enable'), status: $('clipboard-status'),
  buttons: { read: $('clipboard-read-host'), copyLocal: $('clipboard-copy-local'), readLocal: $('clipboard-read-local'), copyHost: $('clipboard-copy-host'), pasteHost: $('clipboard-paste-host') },
  canUse: canSendKeys, send, control: value => { if (!authenticated || ws?.readyState !== WebSocket.OPEN) return false; ws.send(value); return true; }, localClipboard: navigator.clipboard,
}) : null;
function updateArrowAvailability() {
  $('keyboard').disabled = mediaSwitching || !authenticated || !header;
  paintTrackpad();
  paintShortcuts();
  clipboardTools?.refresh();
  if (!arrowPadPresent) return;
  $('arrows').hidden = !keyboardSupported || viewOnly;
  const available = canSendKeys();
  for (const id of ['arrows', 'arrow-up', 'arrow-left', 'arrow-down', 'arrow-right']) $(id).disabled = !available;
}
const shortcutKeys = createKeyboardShortcuts({ send, canSend: () => canSendKeys() && openControlTray === 'shortcuts', storage: () => window.localStorage });
function paintShortcuts() {
  if (!shortcutsPresent) return;
  $('shortcuts').hidden = !keyboardSupported || viewOnly;
  $('shortcuts').disabled = !canSendKeys();
  shortcutKeys.bindings().forEach((binding, i) => {
    const label = shortcutLabel(binding), button = $(`shortcut-${i}`);
    button.textContent = label; button.setAttribute('aria-label', `Send ${label}`); button.setAttribute('title', `Send ${label}`);
    button.disabled = !canSendKeys() || openControlTray !== 'shortcuts';
  });
}
function loadShortcutEditor() {
  if (!shortcutsPresent) return;
  const binding = shortcutKeys.bindings()[Number($('shortcut-slot').value)] || shortcutKeys.bindings()[0];
  $('shortcut-key').value = binding.code;
  for (let i = 0; i < 4; i++) $(`shortcut-mod-${i}`).checked = !!(binding.modifiers & (1 << i));
}
if (shortcutsPresent) {
  for (let i = 0; i < 6; i++) $(`shortcut-${i}`).addEventListener('click', () => {
    if (!canSendKeys() || openControlTray !== 'shortcuts') return;
    releaseTouches();
    const ok = shortcutKeys.tap(i);
    $('shortcut-status').textContent = ok ? `Sent ${shortcutLabel(shortcutKeys.bindings()[i])}.` : 'Shortcut not sent. Check the connection and keyboard permission.';
    fitCanvas();
  });
  $('shortcut-slot').addEventListener('change', loadShortcutEditor);
  $('shortcut-form').addEventListener('submit', event => {
    event.preventDefault();
    const index = Number($('shortcut-slot').value), mask = [0, 1, 2, 3].reduce((n, i) => n | ($(`shortcut-mod-${i}`).checked ? 1 << i : 0), 0);
    const result = shortcutKeys.configure(index, $('shortcut-key').value, mask);
    $('shortcut-key').setAttribute('aria-invalid', String(!result.ok));
    if (!result.ok) { $('shortcut-status').textContent = 'Choose an available key and button.'; $('shortcut-key').focus(); return; }
    paintShortcuts();
    $('shortcut-status').textContent = `Button ${index + 1} is now ${shortcutLabel(shortcutKeys.bindings()[index])}. ${result.saved ? 'Saved in this browser.' : 'Browser storage is unavailable; this change lasts until the page closes.'}`;
    fitCanvas();
  });
  $('shortcut-reset').addEventListener('click', () => {
    const result = shortcutKeys.reset(); paintShortcuts(); loadShortcutEditor();
    $('shortcut-key').setAttribute('aria-invalid', 'false');
    $('shortcut-status').textContent = result.saved ? 'Default shortcuts restored in this browser.' : 'Default shortcuts restored for this page; browser storage is unavailable.';
    fitCanvas();
  });
  $('close-shortcuts').addEventListener('click', () => setControlTray(null, true));
}
function tapArrow(code, modifiers = 0) {
  if (!canSendKeys() || openControlTray !== 'arrows' || !/^Arrow(?:Up|Left|Down|Right)$/.test(code)) return;
  const usage = keyboardUsage(code);
  // A tap is always a complete pair; there is no held key to strand on blur.
  if (send(keyPacket(0, usage, modifiers))) send(keyPacket(1, usage, 0));
}
if (arrowPadPresent) {
  for (const [id, code] of [['arrow-up', 'ArrowUp'], ['arrow-left', 'ArrowLeft'], ['arrow-down', 'ArrowDown'], ['arrow-right', 'ArrowRight']]) {
    $(id).addEventListener('click', () => tapArrow(code));
  }
  $('close-arrows').addEventListener('click', () => setControlTray(null, true));
  $('arrow-controls').addEventListener('keydown', event => {
    const code = event.code || event.key;
    if (!/^Arrow(?:Up|Left|Down|Right)$/.test(code) || !canSendKeys() || openControlTray !== 'arrows') return;
    event.preventDefault();
    tapArrow(code, (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0));
  });
}
function hideKeyboard() {
  keyboardOpen = false; keyboardInput.setEnabled(false);
  if (autoFeedback) autoFeedback.hidden = true;
  document.body.classList.remove('keyboard-open');
  $('keyboard-controls').hidden = true; $('keyboard').setAttribute('aria-expanded', 'false');
}
function showKeyboard(retry = false) {
  if (!keyboardSupported || viewOnly || paused || away() || !touchEnabled || keyboardOpen || (keyboardBlocked && !retry)) return;
  keyboardBlocked = false; updateArrowAvailability();
  setControlTray(); keyboardOpen = true; $('keyboard-controls').hidden = false;
  document.body.classList.add('keyboard-open'); $('keyboard').setAttribute('aria-expanded', 'true');
  fitCanvas(); send(keyPacket(2)); keyboardInput.setEnabled(true);
}
$('keyboard').addEventListener('click', () => {
  if (keyboardOpen) { hideKeyboard(); fitCanvas(); return; }
  if (autoFeedback) autoFeedback.hidden = true;
  showKeyboard(true);
});
$('close-keyboard').addEventListener('click', () => { hideKeyboard(); fitCanvas(); $('keyboard').focus(); });
$('close-options').addEventListener('click', () => setControlTray(null, true));
for (const id of ['volume', 'window']) $(id).addEventListener('toggle', () => releaseTouches());

function send(bytes) {
  if (mediaSwitching || !authenticated || !header || ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(bytes); return true;
}
function action(value) { send(new Uint8Array([5, value])); }
function stopAudio() {
  for (const source of sources.keys()) { try { source.stop(); } catch { /* Already ended. */ } }
  sources.clear(); nextAudio = 0;
}
function drainAudioAcks(all = false) {
  for (const pts of takeDecodedTimestamps(pendingAudioAcks, all ? 0 : audio?.decodeQueueSize ?? 0)) mediaAcks.acknowledge(6, pts);
}
function audioUnavailable() {
  muted = true; stopAudio(); drainAudioAcks(true); action(11);
  if (audio && audio.state !== 'closed') audio.close(); audio = null;
  setRailLabel('audio', 'Audio unsupported'); $('audio').disabled = true;
  $('audio').setAttribute('aria-label', 'Audio unsupported');
  $('audio').setAttribute('aria-pressed', 'false');
  $('error').textContent = 'Opus audio is unavailable in this browser. Video can continue.';
}
function releaseTouches(includeKeyboard = true) {
  desktopView.cancel();
  trackpad.release();
  clearTimeout(trackMoveTimer); trackMoveTimer = null; pendingTrackMove = null;
  if (includeKeyboard) clipboardTools?.reset();
  if (includeKeyboard) keyboardInput.release();
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
  clipboardTools?.setSupported(false);
  header = false; videoConfig = null; configBytes = null; audioConfig = null;
  paintTrackpad(); paintShortcuts();
}
function disconnect() {
  if (closing) return;
  closing = true;
  const cancelRetainedCapture = mediaSwitching || sameCaptureRecovery;
  resumeAllowed = false;
  generation++;
  resumePendingMedia = null;
  sameCaptureRecovery = false;
  if (sessionExpected && (cancelRetainedCapture || ws?.readyState !== WebSocket.OPEN)) void fetch('/stream/session', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  sessionExpected = false; resumeDeadline = 0; clearFocusCapability();
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  clearTimeout(retryTimer); clearTimeout(connectionTimer);
  releaseTouches(); stopAudio(); drainAudioAcks(true);
  ws?.close(4000, 'Disconnected by viewer'); ws = null;
  clearMedia();
  trackpadMode = false; trackpad.reset(); desktopView.reset();
  hideKeyboard(); keyboardSupported = false; viewOnly = false; $('keyboard').hidden = true;
  if (audioContext) void audioContext.close().catch(() => {}); audioContext = null;
  authenticated = false; header = false; muted = true; paused = false; mediaSwitching = false; updateArrowAvailability();
  videoConfig = null; configBytes = null; audioConfig = null; frames = 0;
  context.clearRect(0, 0, canvas.width, canvas.height);
  $('join-panel').hidden = false; $('stream-panel').hidden = true;
  document.body.classList.remove('is-streaming', 'controls-hidden');
  $('join').disabled = false; $('join').textContent = 'Connect';
  $('status').textContent = 'Disconnected · reconnect with a remembered browser or use a new code';
  setRailLabel('audio', 'Audio off'); $('audio').setAttribute('aria-pressed', 'false');
  $('audio').disabled = false;
  $('pause').setAttribute('aria-pressed', 'false');
  setRailLabel('pause', 'Pause video'); $('pause').setAttribute('aria-label', 'Pause video');
  $('audio').setAttribute('aria-label', 'Audio off');
  setControlTray(); $('show-controls').hidden = true;
  if (!document.hidden) $('session-key').focus();
  closing = false;
}

async function resumeSession() {
  if (away() || ws || probing || !supported || !resumeAllowed) return;
  probing = true;
  const mine = generation;
  try {
    const response = await fetch('/stream/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    const sessionInfo = response.ok ? await response.json() : {};
    const available = sessionInfo.resumable;
    if (mine !== generation || ws || away()) return;
    if (available) {
      sessionExpected = true; resumeDeadline ||= Date.now() + BROWSER_RESUME_MS;
      $('error').textContent = ''; connect(null, sessionInfo.mediaMode || preferredMode);
    } else {
      if (sameCaptureRecovery) {
        sessionExpected = false;
        fail('Sharing ended while restoring video. Reconnect with saved access or ask for a new invitation.');
        return;
      }
      const ticket = await remembered.ticket();
      if (mine !== generation || ws || away()) return;
      if (ticket) { sessionExpected = false; resumeDeadline = 0; connect(ticket); }
      else if (sessionExpected) { sessionExpected = false; fail('This session ended. Reconnect with a remembered browser or pair using a new invitation.'); }
    }
  } catch (error) {
    if (mine === generation) $('error').textContent = error.message || 'Could not reconnect. Check the private connection.';
    if (mine === generation && [400, 403].includes(error.status)) { sessionExpected = false; fail(error.message); return; }
    if (mine === generation && (sessionExpected || error.status === 409)) {
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
  mediaSwitching = false;
  let fallbackNegotiated = false, fallbackRequested = false, fallbackAcknowledged = false, fallbackNeeded = false;
  const canFallback = requestedMode === 'webrtc' && 'VideoDecoder' in window && 'EncodedVideoChunk' in window;
  mediaAcks.reset();
  $('join').disabled = true; $('join').textContent = 'Connecting…'; $('status').textContent = 'Authenticating…';
  if (!key) $('status').textContent = 'Reconnecting…';
  const mine = ++generation;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${requestedMode === 'webrtc' ? '/stream/webrtc' : '/stream'}`, canFallback ? [MEDIA_FALLBACK_PROTOCOL] : []);
  ws = socket; socket.binaryType = 'arraybuffer';
  // A resumed capture may still be draining its previous native process. Keep
  // this attempt bounded and inside the original five-minute resume deadline.
  const connectionWait = !key && sessionExpected ? Math.min(30000, Math.max(1000, resumeDeadline - Date.now())) : 15000;
  const timeout = connectionTimer = setTimeout(() => { if (mine === generation && !document.hidden && !paused && !requestMediaFallback()) fail('Connection timed out. Check the desktop invitation and receiver address.'); }, connectionWait);
  function requestMediaFallback() {
    if (mine !== generation || !authenticated || !fallbackNegotiated || !canFallback || mediaMode !== 'webrtc'
        || socket !== ws || socket.readyState !== WebSocket.OPEN) return false;
    if (away() || paused) { fallbackNeeded = true; return true; }
    if (fallbackRequested) return true;
    fallbackRequested = true; fallbackNeeded = false; sameCaptureRecovery = true;
    prepareMediaChange();
    try { socket.send('media-fallback'); }
    catch { fail('Could not restore browser video. Check the private connection.'); return true; }
    return true;
  }
  function prepareMediaChange() {
    if (!mediaSwitching) {
      releaseTouches(); hideKeyboard(); clearFocusCapability(false);
      mediaSwitching = true; rtcReceiver?.close(); updateArrowAvailability();
    }
    clearTimeout(timeout); clearTimeout(connectionTimer);
    $('status').textContent = 'Trying another video method…'; $('error').textContent = '';
    connectionTimer = setTimeout(() => {
      if (mine === generation && mediaSwitching) fail('Could not restore browser video. Reconnect using saved access or a new invitation.');
    }, 5000);
  }
  resumePendingMedia = () => fallbackNeeded && requestMediaFallback();
  socket.addEventListener('open', () => { if (key) { socket.send(key); key = null; } }, { once: true });
  // The close event decides whether this is a resumable network interruption.
  socket.addEventListener('error', () => {});
  socket.addEventListener('close', (event) => {
    clearTimeout(timeout);
    if (mine !== generation) return;
    generation++; // Retire old async media work before the reconnect delay.
    resumePendingMedia = null;
    clearTimeout(connectionTimer);
    releaseTouches(); clearMedia(); ws = null; authenticated = false; mediaSwitching = false; clearFocusCapability(false); updateArrowAvailability();
    const captureRestart = event.code === 1012 && event.reason === 'capture-restart';
    const mediaFallback = fallbackNegotiated && (fallbackAcknowledged || fallbackRequested || (event.code === 1012 && event.reason === 'media-fallback'));
    if (captureRestart || mediaFallback) { hideKeyboard(); fitCanvas(); }
    if (mediaFallback) { sameCaptureRecovery = true; muted = true; setRailLabel('audio', 'Audio off'); $('audio').setAttribute('aria-pressed', 'false'); $('audio').setAttribute('aria-label', 'Audio off'); }
    if (sessionExpected && ![1000, 1008, 4000, 4002].includes(event.code) && (event.code !== 1005 || mediaFallback)) {
      resumeDeadline ||= Date.now() + BROWSER_RESUME_MS;
      $('status').textContent = document.hidden ? 'Paused while away' : captureRestart ? 'Restoring the computer display…' : mediaFallback ? 'Restoring browser video…' : 'Reconnecting…';
      retryTimer = setTimeout(resumeSession, 250);
    } else {
      sessionExpected = false;
      fail(event.code === 1008 && event.reason === 'capture-permission'
        ? 'On the Mac, allow Screen & System Audio Recording for Terminal/dskcpy, then restart dskcpy and scan a fresh QR.'
        : event.code === 1008 && event.reason === 'capture-recovery' ? 'The computer could not restore sharing after its display changed. Reconnect using saved access or ask for a new invitation.'
        : event.code === 4002 ? 'The stream moved to another browser tab. Continue there.' : 'The session ended. Create a new link and code on the computer.');
    }
  });
  socket.addEventListener('message', (event) => {
    if (mine !== generation) return;
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'media-fallback') {
          if (!authenticated || !fallbackNegotiated || !canFallback || fallbackAcknowledged || mediaMode !== 'webrtc' || message.mediaMode !== 'webcodecs') throw Error('Unexpected media recovery response.');
          fallbackAcknowledged = true; sameCaptureRecovery = true; prepareMediaChange(); return;
        }
        if (mediaSwitching) return; // Only the negotiated acknowledgment belongs to this retiring socket.
        if (message.type === 'clipboard-result') { if (!authenticated) throw Error('Unexpected clipboard response.'); clipboardTools?.result(message); return; }
        if (message.type === 'rtc-offer' && authenticated && mediaMode === 'webrtc') {
          if (rtcReceiver) throw new Error('Unexpected repeated media offer.');
          rtcDisplay.hidden = false; rtcDisplay.muted = muted;
          document.body.classList.add('rtc-stream');
          rtcReceiver = createRtcReceiver({ element: rtcDisplay,
            signal: (value) => { if (mine === generation && !mediaSwitching && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); },
            onPlaying: () => {
              if (mine !== generation || mediaSwitching || paused || document.hidden) return;
              clearTimeout(timeout); $('status').textContent = 'Streaming'; $('error').textContent = '';
              $('stats').textContent = `${canvas.width} × ${canvas.height} · WebRTC · native browser video and audio`;
            }, onError: (message) => { if (mine === generation && !mediaSwitching) $('error').textContent = message; },
            onFailure: (message) => { if (mine === generation && !mediaSwitching && !requestMediaFallback()) $('error').textContent = message; } });
          void rtcReceiver.offer(message.description).catch((error) => { if (mine === generation && !mediaSwitching && !requestMediaFallback()) fail(error.message); });
          return;
        }
        if (message.type === 'keyboard-status') {
          if (!authenticated || !keyboardStatusSupported || !['ready','blocked','unsupported'].includes(message.status)) throw new Error('Unexpected keyboard status.');
          if (message.status === 'blocked') {
            // Cleanup may send release-all for a held key. That is not the
            // user's retry: gate both arrows and typing until Keyboard is tapped.
            keyboardBlocked = true; hideKeyboard(); updateArrowAvailability(); fitCanvas();
            $('error').textContent = 'The computer could not accept all keyboard input. Check its text, then tap Keyboard to try again.';
          }
          if (keyboardStatusMessage) {
            keyboardStatusMessage.hidden = message.status === 'ready';
            keyboardStatusMessage.textContent = message.status === 'unsupported' ? 'That key is unavailable on this host. Use the typing field for text.' : '';
          }
          if (message.status === 'ready' && $('error').textContent.startsWith('The computer could not accept all keyboard input.')) $('error').textContent = '';
          return;
        }
        if (message.type === 'text-focus') {
          if (!authenticated || ![true, false, null].includes(message.focused)) throw new Error('Unexpected focus hint.');
          autoFocusKeyboard(message.focused); return;
        }
        if (message.type !== 'authenticated') throw new Error('Unexpected receiver response.');
        mediaMode = message.mediaMode || 'webcodecs';
        fallbackNegotiated = canFallback && mediaMode === 'webrtc' && message.mediaFallback === true;
        if (mediaMode === 'webcodecs' && !('VideoDecoder' in window)) throw new Error('This connection needs WebCodecs. Use the private VPN link for browser-native video.');
        const restoring = sessionExpected;
        authenticated = true; sessionExpected = true;
        sameCaptureRecovery = false;
        viewOnly = message.viewOnly === true;
        remembered.authenticated(viewOnly);
        keyboardSupported = message.keyboard === true && !viewOnly;
        clipboardTools?.setSupported(keyboardSupported && message.clipboard === true);
        keyboardStatusSupported = keyboardSupported && message.keyboardStatus === true;
        if (keyboardStatusSupported) socket.send('keyboard-status-subscribe');
        focusSupported = keyboardSupported && message.textFocus === true;
        if (focusSupported) ws.send('text-focus-subscribe');
        if (!focusSupported) autoKeyboard = false;
        if (autoToggle) autoToggle.checked = autoKeyboard;
        if (autoSetting) autoSetting.hidden = !focusSupported;
        updateArrowAvailability();
        $('keyboard').hidden = !keyboardSupported;
        touchEnabled = !viewOnly && (!restoring || touchEnabled); $('touch').disabled = viewOnly; $('drag-mode').disabled = viewOnly;
        setRailLabel('touch', viewOnly ? 'Window · view only' : touchEnabled ? 'Touch on' : 'Touch off');
        $('touch').setAttribute('aria-pressed', String(touchEnabled));
        for (const id of ['volume', 'window']) $(id).hidden = viewOnly;
        $('audio').disabled = viewOnly;
        $('status').textContent = 'Connected · waiting for video';
        $('join-panel').hidden = true; $('stream-panel').hidden = false;
        document.body.classList.add('is-streaming');
        return;
      }
      if (mediaSwitching) return;
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
        setRailLabel('audio', 'Audio unavailable'); $('audio').setAttribute('aria-label', 'Audio unavailable');
        $('audio').disabled = true; return;
      }
      if (flags === 4) {
        stopAudio(); // A fresh codec configuration also discards the old route's scheduled audio.
        audioConfig = payload.slice(); $('audio').disabled = false;
        setRailLabel('audio', muted ? 'Audio off' : 'Audio on');

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
      onRecovery: (message) => { if (mine === generation) $('status').textContent = message; },
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
          const now = audioContext.currentTime;
          // onended is dispatched on the main thread and may arrive late;
          // completed sound must not consume the bounded future-source budget.
          for (const [source, end] of sources) if (end <= now) sources.delete(source);
          const duration = data.numberOfFrames / data.sampleRate;
          if (!Number.isFinite(duration) || duration <= 0 || duration > audioMaximumLead - audioStartLead) return;
          if (nextAudio + duration > now + audioMaximumLead || sources.size >= audioMaximumSources) stopAudio();
          const buffer = audioContext.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
          for (let channel = 0; channel < data.numberOfChannels; channel++) {
            data.copyTo(buffer.getChannelData(channel), { planeIndex: channel, format: 'f32-planar' });
          }
          const source = audioContext.createBufferSource(); source.buffer = buffer; source.connect(audioContext.destination);
          source.onended = () => sources.delete(source);
          // Append continuously while prior sound is queued. Reapplying a
          // minimum lead to every packet inserts gaps on small late arrivals.
          const start = sources.size && nextAudio >= now ? nextAudio : now + audioStartLead;
          source.start(start); nextAudio = start + buffer.duration;
          sources.set(source, nextAudio);
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
  if (viewOnly || mediaSwitching || !authenticated || !header) return;
  if (mediaMode === 'webrtc') {
    const mine = generation, attempt = ++playbackAttempt;
    const updateButton = () => {
      setRailLabel('audio', muted ? 'Audio off' : 'Audio on');

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
  if (!$('audio').disabled) setRailLabel('audio', muted ? 'Audio off' : 'Audio on'); $('audio').setAttribute('aria-pressed', String(!muted));

});
function updatePause() {
  updateArrowAvailability();
  if (mediaSwitching || !authenticated || !header || ws?.readyState !== WebSocket.OPEN) return;
  if (!away() && !paused && resumePendingMedia?.()) return;
  releaseTouches(); stopAudio();
  if (paused || away()) hideKeyboard();
  suspendDecoder();
  if (!away() && !paused) video?.resume();
  ws.send(away() ? 'suspend' : 'resume');
  action(paused || away() ? 7 : 8);
  if (away()) resumeDeadline ||= Date.now() + BROWSER_RESUME_MS;
  else resumeDeadline = 0;
  // A resumed socket can receive its cached header while the host session is
  // still suspended. Its initial mute command is then deliberately ignored.
  // Reapply audio intent after resume for both transports; a WebCodecs page
  // may enable capture only with prior consent and a running audio context.
  if (!away()) action(muted || paused || (mediaMode !== 'webrtc' && audioContext?.state !== 'running') ? 11 : 10);
  if (mediaMode === 'webrtc') {
    const mine = generation, attempt = ++playbackAttempt;
    if (away() || paused) { rtcDisplay.muted = true; rtcDisplay.pause?.(); }
    else { rtcDisplay.muted = muted; void rtcDisplay.play?.().catch(() => {
      if (mine === generation && attempt === playbackAttempt && authenticated) {
        $('error').textContent = 'Tap Resume to restart browser playback.';
      }
    }); }
  }
  if (mediaMode !== 'webrtc' && !away() && !muted && audioContext?.state !== 'running') {
    // Mobile browsers may suspend audio independently of the video connection.
    // Ask for a fresh tap instead of showing an inaccurate "Audio on" state.
    muted = true; action(11); setRailLabel('audio', 'Audio off');
    $('audio').setAttribute('aria-label', 'Audio off'); $('audio').setAttribute('aria-pressed', 'false');
  }
  if (!away() && !paused) configureAudio();
  $('status').textContent = away() ? 'Paused while away' : paused ? 'Video paused' : 'Resuming…';
}
$('pause').addEventListener('click', () => {
  paused = !paused; updatePause();
  setRailLabel('pause', paused ? 'Resume video' : 'Pause video'); $('pause').setAttribute('aria-pressed', String(paused));
  $('pause').setAttribute('aria-label', paused ? 'Resume video' : 'Pause video');
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(connectionTimer);
  updatePause();
  if (!away()) void resumeSession();
});
for (const name of ['enterpictureinpicture', 'leavepictureinpicture', 'webkitpresentationmodechanged']) rtcDisplay.addEventListener(name, () => { updatePause(); if (!away()) void resumeSession(); });
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
  if (viewOnly) return;
  releaseTouches(); touchEnabled = !touchEnabled; updateArrowAvailability();
  if (!touchEnabled) hideKeyboard();
  setRailLabel('touch', touchEnabled ? 'Touch on' : 'Touch off'); $('touch').setAttribute('aria-pressed', String(touchEnabled));
});
function point(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
}
canvas.addEventListener('pointerdown', (event) => {
  if (trackpadMode) {
    if (!canSendPointer() || event.button !== 0) return;
    event.preventDefault(); canvas.setPointerCapture(event.pointerId); trackpad.down(event); return;
  }
  if (!canSendPointer() || pointers.size >= 10 || event.button !== 0) return;
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
  if (trackpadMode) { if (canSendPointer()) { event.preventDefault(); trackpad.pointerMove(event); } return; }
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
    if (trackpadMode) { event.preventDefault(); if (actionCode === 3) { if (trackpad.hasPointer(event.pointerId)) releaseTouches(); } else if (canSendPointer()) trackpad.up(event); return; }
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
  if (trackpadMode) {
    if (!canSendPointer()) return;
    event.preventDefault(); const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
    trackpad.scroll(event.deltaX * scale, event.deltaY * scale); return;
  }
  if (!canSendPointer()) return;
  event.preventDefault();
  const p = point(event), scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1;
  send(scrollPacket(p.x, p.y, canvas.width, canvas.height, event.deltaX * scale, event.deltaY * scale));
}, { passive: false });
canvas.addEventListener('contextmenu', (event) => { if (touchEnabled && !paused) event.preventDefault(); });
$('drag-mode').addEventListener('click', () => {
  if (viewOnly) return;
  if (trackpadMode) { if (canSendPointer()) trackpad.toggleDrag(); return; }
  releaseTouches(); selectDrag = !selectDrag;
  setRailLabel('drag-mode', selectDrag ? 'Select and drag' : 'Scroll gestures');
  $('drag-mode').setAttribute('aria-pressed', String(selectDrag));
});
if (trackpadPresent) $('trackpad-mode').addEventListener('click', () => {
  if (!canSendPointer()) return;
  releaseTouches(); hideKeyboard(); setControlTray(); trackpadMode = !trackpadMode; fitCanvas();
  if (trackpadMode) canvas.focus();
});
canvas.addEventListener('keydown', event => {
  if (!trackpadMode || !canSendPointer() || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  const step = event.shiftKey ? 48 : 16;
  const directions = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (directions[event.key]) { event.preventDefault(); trackpad.move(...directions[event.key]); }
  else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!event.repeat) trackpad.click(); }
  else if (event.key === 'PageUp' || event.key === 'PageDown') { event.preventDefault(); trackpad.scroll(0, event.key === 'PageUp' ? -80 : 80); }
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
      fitCanvas();
    }
  }
});
function unlockOrientation() {
  try { screen.orientation?.unlock?.(); } catch { /* Orientation API is optional. */ }
}
function setControlTray(name = null, focus = false) {
  clipboardTools?.reset();
  releaseTouches();
  if (name) hideKeyboard();
  const previous = openControlTray;
  openControlTray = name;
  if (name === 'shortcuts') loadShortcutEditor();
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
  $(trigger).addEventListener('click', () => {
    if (['arrows', 'shortcuts'].includes(trigger) && !canSendKeys()) return;
    setControlTray(openControlTray === trigger ? null : trigger, true);
  });
}
function setControlsVisible(visible) {
  if (!visible) hideKeyboard();
  setControlTray();
  document.body.classList.toggle('controls-hidden', !visible);
  $('show-controls').hidden = visible;
  fitCanvas();
  (visible ? $('hide-controls') : $('show-controls')).focus();
}
$('hide-controls').addEventListener('click', () => setControlsVisible(false));
$('show-controls').addEventListener('click', () => setControlsVisible(true));
function fitCanvas() {
  releaseTouches(false); // Soft-keyboard viewport changes must not cancel typing or composition.
  $('control-panels').hidden = !(keyboardOpen || openControlTray || trackpadMode || !$('orientation-help').hidden);
  const panel = $('stream-panel'), viewport = $('receiver-viewport'), padding = getComputedStyle(viewport);
  const fullHeight = viewport.clientHeight - parseFloat(padding.paddingTop) - parseFloat(padding.paddingBottom);
  const fullWidth = viewport.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight);
  panel.classList.toggle('controls-reserved', document.body.classList.contains('controls-hidden')
    && needsControlsRow(canvas.width, canvas.height, fullWidth, fullHeight));
  const stage = $('stage');
  document.body.classList.toggle('view-navigation', viewNavigationActive());
  document.body.classList.toggle('shortcuts-open', openControlTray === 'shortcuts');
  stage.tabIndex = viewNavigationActive() ? 0 : -1;
  if (viewNavigationActive()) { stage.setAttribute('role', 'group'); stage.setAttribute('aria-label', 'Move the local view'); stage.setAttribute('aria-describedby', 'view-help'); }
  else { stage.removeAttribute('role'); stage.removeAttribute('aria-label'); stage.removeAttribute('aria-describedby'); }
  const size = fitDisplay(canvas.width, canvas.height, stage.clientWidth, stage.clientHeight);
  canvas.style.width = `${size.width}px`; canvas.style.height = `${size.height}px`;
  rtcDisplay.style.width = `${size.width}px`; rtcDisplay.style.height = `${size.height}px`;
  const imageSize = `${canvas.width}x${canvas.height}`;
  if (viewImageSize !== imageSize) { desktopView.reset(); viewImageSize = imageSize; }
  desktopView.setGeometry({ width: stage.clientWidth, height: stage.clientHeight, contentWidth: size.width, contentHeight: size.height });
  updateArrowAvailability();
  if ($('view-scroll-hint')) $('view-scroll-hint').hidden = true;
  if ($('view-scroll-hint')) $('view-scroll-hint').hidden = !viewNavigationActive() || $('control-panels').scrollHeight <= $('control-panels').clientHeight + 1;
  if ($('shortcut-scroll-hint')) {
    const cue = $('shortcut-scroll-hint'), scroller = $('control-panels');
    cue.hidden = true; cue.hidden = openControlTray !== 'shortcuts' || scroller.scrollHeight <= scroller.clientHeight + 1;
    document.documentElement.style.setProperty('--shortcut-heading-clearance', `${($('shortcut-heading')?.offsetHeight || 48) + 12}px`);
  }
  const controls = $('primary-controls'), hint = $('rail-scroll-hint');
  hint.hidden = true;
  hint.hidden = !(controls.scrollHeight > controls.clientHeight + 1);
}
new ResizeObserver(fitVisualViewport).observe($('stage'));
// Mobile browsers can resize only the visual viewport when the soft keyboard
// opens. Fit the receiver to the visible area without releasing paired keys.
const visualViewport = window.visualViewport;
function fitVisualViewport() {
  // Do not counteract browser pinch zoom by fitting back to its smaller view.
  if (visualViewport?.height > 0 && (!visualViewport.scale || Math.abs(visualViewport.scale - 1) < .01)) {
    const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    document.documentElement?.style?.setProperty?.('--receiver-height', `${visualViewport.height / zoom}px`);
    document.documentElement?.style?.setProperty?.('--receiver-top', `${Math.max(0, visualViewport.offsetTop || 0) / zoom}px`);
  }
  fitCanvas();
  // The compact field is already inside the fitted viewport. scrollIntoView
  // here can pan Android's visual viewport and hide the video on each key.
}
visualViewport?.addEventListener('resize', fitVisualViewport);
visualViewport?.addEventListener('scroll', fitVisualViewport);
if (visualViewport) fitVisualViewport();
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) { fullscreenAttempt++; unlockOrientation(); $('orientation-help').hidden = true; }
  setRailLabel('fullscreen', document.fullscreenElement ? 'Exit full screen' : 'Full screen');
  fitVisualViewport();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') {
  releaseTouches();
  if (keyboardOpen) { hideKeyboard(); fitCanvas(); $('keyboard').focus(); }
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
