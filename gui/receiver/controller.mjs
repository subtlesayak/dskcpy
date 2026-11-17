import { BROWSER_RESUME_MS, parseControllerFragment, touchPacket, scrollPacket } from './protocol.mjs';
import { createRelativeTrackpad } from './trackpad.mjs';
import { createBrowserKeyboard, keyPacket } from './keyboard.mjs';
import { SHORTCUT_KEYS, shortcutKeyLabel, createKeyboardShortcuts } from './shortcuts.mjs';

const $ = id => document.getElementById(id);
let scannedKey = parseControllerFragment(location.hash);
if (location.hash.startsWith('#controller=')) history.replaceState(null, '', location.pathname + location.search);
let ws, authenticated = false, active = false, available = false, ended = false, expected = false;
let keyboardSupported = false, keyboardOpen = false, focusSupported = false, focused = document.hasFocus();
let width = 0, height = 0, generation = 0, retryTimer, connectTimer, deadline = 0, probing = false;
let moving, moveTimer;
let pendingAction = null;
const pad = $('controller-pad'), field = $('controller-input');
const keyButtons = [...document.querySelectorAll('[data-key]')];
const modifierInputs = [...document.querySelectorAll('[data-modifier]')];
const showError = text => { $('controller-error').textContent = text; };
const say = text => { if ($('controller-status').textContent !== text) $('controller-status').textContent = text; };
const visible = () => !document.hidden && focused;
const canControl = () => authenticated && active && available && !ended && visible() && ws?.readyState === WebSocket.OPEN;
function send(packet) { if (!authenticated || ws?.readyState !== WebSocket.OPEN) return false; ws.send(packet); return true; }
function preference(id, key, min, max, initial) {
  let value = initial;
  const valid = n => Number.isFinite(n) && n >= min && n <= max && Number.isInteger(n * 4);
  try { const n = Number(localStorage.getItem(key)); if (valid(n)) value = n; } catch {}
  const input = $(id), output = $(id.replace('-speed', '-value'));
  const paint = () => { input.value = String(value); input.setAttribute('aria-valuetext', `${value} times`); output.textContent = `${value}×`; };
  input.addEventListener('input', () => {
    const n = Number(input.value); if (!valid(n)) { paint(); return; }
    releaseInput(); value = n; paint(); try { localStorage.setItem(key, String(n)); } catch {}
  });
  paint(); return () => value;
}
const pointerGain = preference('controller-pointer-speed', 'dskcpy.pointer-speed.v1', .25, 4, 1);
const scrollGain = preference('controller-scroll-speed', 'dskcpy.touch-scroll-speed.v1', .5, 8, 2);
function flushMove() { clearTimeout(moveTimer); moveTimer = null; const packet = moving; moving = null; if (packet && canControl()) send(packet); }
function emitPointer(point) {
  if (!canControl() && point.type !== 'cancel') return false;
  const packet = ['hover', 'scroll'].includes(point.type)
    ? scrollPacket(point.x, point.y, point.width, point.height, point.dx || 0, point.dy || 0)
    : touchPacket(({ down: 0, up: 1, move: 2, cancel: 3 })[point.type], 0, point.x, point.y, point.width, point.height);
  if (['hover', 'move'].includes(point.type)) { moving = packet; moveTimer ||= setTimeout(flushMove, 16); return true; }
  if (point.type === 'cancel') { clearTimeout(moveTimer); moveTimer = null; moving = null; } else flushMove();
  return send(packet);
}
const trackpad = createRelativeTrackpad({ geometry: () => {
  const rect = pad.getBoundingClientRect(); return { width, height, cssWidth: rect.width, cssHeight: rect.height };
}, emit: emitPointer, pointerGain, scrollGain, uniformPointer: true, changed: () => {
  const point = trackpad.position();
  if (point) {
    $('controller-marker').style.left = `${point.x / Math.max(1, width - 1) * 100}%`;
    $('controller-marker').style.right = 'auto';
    $('controller-marker').style.top = `${point.y / Math.max(1, height - 1) * 100}%`;
  }
  $('controller-drag').textContent = trackpad.dragging ? 'Release' : 'Drag';
  $('controller-drag').setAttribute('aria-label', trackpad.dragging ? 'Release drag' : 'Start drag');
  $('controller-drag').setAttribute('aria-pressed', String(trackpad.dragging));
} });
const keyboard = createBrowserKeyboard({ field, send, canSend: () => keyboardSupported && canControl(),
  contextControls: [$('controller-keyboard'), $('controller-close-keyboard'), ...keyButtons, ...modifierInputs], onError: showError });
const shortcuts = createKeyboardShortcuts({ send, canSend: () => keyboardSupported && canControl() });
for (const code of SHORTCUT_KEYS) { const option = document.createElement('option'); option.value = code; option.textContent = shortcutKeyLabel(code); $('controller-shortcut-key').append(option); }
$('controller-send-shortcut').addEventListener('click', () => {
  if (!keyboardSupported || !canControl()) return;
  const mask = modifierInputs.reduce((n, input) => n | (input.checked ? Number(input.dataset.modifier) : 0), 0);
  keyboard.setEnabled(false); releaseInput();
  const configured = shortcuts.configure(0, $('controller-shortcut-key').value, mask);
  if (!configured.ok || !shortcuts.tap(0)) showError('The shortcut could not be sent. Check the connection and keyboard permission.');
  if (keyboardOpen) keyboard.setEnabled(true);
});
function releaseInput() {
  clearTimeout(moveTimer); moving = moveTimer = null;
  trackpad.release(); keyboard.release(); if (keyboardSupported) send(keyPacket(2));
}
function hideKeyboard() {
  keyboardOpen = false; keyboard.setEnabled(false); $('controller-typing').hidden = true;
  $('controller-keyboard').setAttribute('aria-expanded', 'false'); document.body.classList.remove('controller-keyboard-open'); fit();
}
function openKeyboard() {
  if (!keyboardSupported || !canControl()) return;
  if (keyboardOpen && document.activeElement === field) return;
  releaseInput(); keyboardOpen = true; $('controller-typing').hidden = false;
  $('controller-keyboard').setAttribute('aria-expanded', 'true'); document.body.classList.add('controller-keyboard-open');
  keyboard.setEnabled(true); fit();
}
function paint() {
  const usable = canControl(); pad.setAttribute('aria-disabled', String(!usable));
  $('controller-keyboard').disabled = !usable || !keyboardSupported;
  for (const id of ['controller-click', 'controller-drag']) $(id).disabled = !usable;
  for (const button of keyButtons) button.disabled = !usable || !keyboardSupported;
  $('controller-send-shortcut').disabled = !usable || !keyboardSupported;
  $('controller-auto-keyboard').disabled = !keyboardSupported || !focusSupported;
  $('controller-resume').hidden = usable || !authenticated || !available || ended;
  $('controller-end-presentation').disabled = !authenticated || ended;
  const status = ended ? 'Presentation ended' : available ? 'Presentation browser connected' : 'Waiting for presentation';
  if ($('controller-presentation-status').textContent !== status) $('controller-presentation-status').textContent = status;
  say(ended ? 'Presentation ended · Stop sharing or leave controller' : usable ? 'Controller connected' : authenticated ? 'Control paused' : 'Not connected');
}
function resumeControl() {
  if (!authenticated || !visible() || ended) return;
  active = available; send('resume');
  if (keyboardSupported) send('keyboard-status-subscribe');
  if (focusSupported) send('text-focus-subscribe');
  paint();
}
function suspend(clearText = false) {
  releaseInput(); active = false;
  if (clearText) hideKeyboard();
  if (authenticated) send('suspend'); paint();
}
function stopLocal(message = 'Controller disconnected') {
  expected = false; generation++; clearTimeout(retryTimer); clearTimeout(connectTimer);
  releaseInput(); hideKeyboard(); ws?.close(4000, 'Controller left'); ws = null;
  authenticated = active = available = false; keyboardSupported = focusSupported = false; deadline = 0;
  $('controller-workspace').hidden = true; $('controller-join').hidden = false;
  document.body.classList.remove('controller-connected'); say(message);
}
async function resumeSession() {
  if (ws || probing || document.hidden || ended) return;
  probing = true; const mine = generation;
  try {
    const response = await fetch('/stream/controller/session', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (mine !== generation) return;
    if (!response.ok) throw Error('Controller connection is unavailable. Use a fresh controller link.');
    const status = await response.json(); if (mine !== generation) return;
    if (status.resumable === true) connect();
    else if (expected) { stopLocal('Controller access expired'); showError('Ask the presentation browser for a new controller link.'); }
  } catch {
    if (mine !== generation) return;
    if (expected && Date.now() < deadline) retryTimer = setTimeout(resumeSession, 1500);
    else showError('Could not reach the controller connection. Check the private connection, then open a fresh controller link.');
  } finally { probing = false; }
}
function applyState(message) {
  if (typeof message.presentationAvailable !== 'boolean' || typeof message.controllerActive !== 'boolean'
      || typeof message.presentationEnded !== 'boolean'
      || ![message.width, message.height].every(n => Number.isInteger(n) && n >= 0 && n <= 16384)) throw Error('Invalid controller state.');
  if (message.width !== width || message.height !== height || !message.presentationAvailable) releaseInput();
  width = message.width; height = message.height; available = message.presentationAvailable;
  ended = message.presentationEnded; active = message.controllerActive && available && !ended;
  if (ended) { releaseInput(); hideKeyboard(); }
  paint();
  if (available && !active && visible() && !ended) resumeControl();
}
function connect(key) {
  if (ws || document.hidden) return;
  const mine = ++generation; pendingAction = null;
  const socket = ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream/controller`);
  connectTimer = setTimeout(() => { if (mine === generation && !authenticated) { stopLocal('Controller connection timed out'); showError('Open a fresh controller link and try again.'); } }, 10000);
  socket.addEventListener('open', () => { if (key) { socket.send(key); key = null; } }, { once: true });
  socket.addEventListener('error', () => {});
  socket.addEventListener('close', event => {
    if (mine !== generation) return;
    clearTimeout(connectTimer); releaseInput(); hideKeyboard(); ws = null; authenticated = active = false; paint();
    if (expected && ![1000, 1008, 4000].includes(event.code)) {
      deadline ||= Date.now() + BROWSER_RESUME_MS;
      if (Date.now() < deadline) { say('Reconnecting controller…'); retryTimer = setTimeout(resumeSession, 250); return; }
    }
    const action = pendingAction?.kind;
    stopLocal(action === 'stop' ? 'Sharing stopped' : action === 'leave' ? 'Controller left' : 'Controller access ended');
    if (!action) showError('Ask the presentation browser for a new controller link.');
  });
  socket.addEventListener('message', event => {
    if (mine !== generation) return;
    try {
      if (typeof event.data !== 'string' || event.data.length > 4096) throw Error('Unexpected controller media or response.');
      const message = JSON.parse(event.data);
      if (message.type === 'controller-authenticated' && !authenticated && message.role === 'controller') {
        authenticated = expected = true; keyboardSupported = message.keyboard === true; focusSupported = message.textFocus === true;
        clearTimeout(connectTimer); deadline = 0; showError(''); $('controller-key').value = '';
        $('controller-join').hidden = true; $('controller-workspace').hidden = false; document.body.classList.add('controller-connected');
        applyState(message); fit(); return;
      }
      if (!authenticated) throw Error('Controller authorization required.');
      if (message.type === 'controller-state') { applyState(message); return; }
      if (message.type === 'keyboard-status' && ['ready', 'blocked', 'unsupported'].includes(message.status)) {
        if (message.status !== 'ready') { releaseInput(); showError(message.status === 'blocked' ? 'The host could not accept keyboard input. Check its mouse and keyboard permission.' : 'That key is unavailable on this host. Use the typing field for text.'); }
        return;
      }
      if (message.type === 'text-focus' && [true, false, null].includes(message.focused)) {
        if (message.focused === true && $('controller-auto-keyboard').checked && canControl() && !$('controller-options').open) openKeyboard(); return;
      }
      throw Error('Unexpected controller response.');
    } catch { stopLocal('Controller connection ended'); showError('The controller could not continue safely. Open a fresh controller link.'); }
  });
}
$('controller-form').addEventListener('submit', event => {
  event.preventDefault(); const key = $('controller-key').value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) { $('controller-key').setAttribute('aria-invalid', 'true'); showError('Use the controller code from a controller link.'); $('controller-key').focus(); return; }
  $('controller-key').removeAttribute('aria-invalid'); $('controller-key').value = ''; showError(''); ended = false; connect(key);
});
$('controller-keyboard').addEventListener('click', () => keyboardOpen ? hideKeyboard() : openKeyboard());
$('controller-close-keyboard').addEventListener('click', () => { hideKeyboard(); $('controller-keyboard').focus(); });
$('controller-click').addEventListener('click', () => { if (canControl()) trackpad.click(); });
$('controller-drag').addEventListener('click', () => { if (canControl()) trackpad.toggleDrag(); });
$('controller-resume').addEventListener('click', () => { focused = true; resumeControl(); });
for (const button of keyButtons) {
  button.addEventListener('pointerdown', event => event.preventDefault());
  button.addEventListener('click', () => {
    if (!canControl() || !keyboardSupported) return;
    if (!keyboardOpen) openKeyboard();
    const mask = modifierInputs.reduce((n, input) => n | (input.checked ? Number(input.dataset.modifier) : 0), 0);
    const values = { code: button.dataset.key, key: button.dataset.key, bubbles: true, cancelable: true,
      ctrlKey: Boolean(mask & 1), shiftKey: Boolean(mask & 2), altKey: Boolean(mask & 4), metaKey: Boolean(mask & 8) };
    field.dispatchEvent(new KeyboardEvent('keydown', values)); field.dispatchEvent(new KeyboardEvent('keyup', values));
  });
}
field.addEventListener('keydown', event => {
  // Chords from physical keyboards use the existing helper directly.
  if (event.key === 'Escape') { releaseInput(); }
});
for (const name of ['pointerdown', 'pointermove', 'pointerup']) pad.addEventListener(name, event => {
  if (!canControl()) return;
  event.preventDefault();
  if (name === 'pointerdown') { pad.setPointerCapture(event.pointerId); trackpad.down(event); }
  else if (name === 'pointermove') trackpad.pointerMove(event); else { trackpad.up(event); flushMove(); }
});
for (const name of ['pointercancel', 'lostpointercapture']) pad.addEventListener(name, event => { if (trackpad.hasPointer(event.pointerId)) releaseInput(); });
pad.addEventListener('contextmenu', event => event.preventDefault());
pad.addEventListener('wheel', event => { if (canControl()) { event.preventDefault(); const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pad.clientHeight : 1; trackpad.scroll(event.deltaX * scale, event.deltaY * scale); } }, { passive: false });
pad.addEventListener('keydown', event => {
  if (!canControl() || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
  const step = event.shiftKey ? 48 : 16, direction = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
  if (direction) { event.preventDefault(); trackpad.move(...direction); }
  else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) trackpad.click(); }
});
async function sessionAction(kind) {
  if (pendingAction || !authenticated) return;
  const descriptions = { leave: 'Leave controller?\nThe presentation stays open. You will need a new controller link to control it again.',
    'end-presentation': 'End presentation?\nThe desktop picture and presentation audio end. This controller stays connected so you can stop the session.',
    stop: 'Stop sharing this desktop?\nThis ends the presentation and remote control for everyone in this session.' };
  releaseInput(); if (!window.confirm(descriptions[kind])) return;
  const mine = generation, action = pendingAction = { kind };
  try {
    const response = await fetch(`/stream/controller/${kind}`, { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('Could not finish the action.');
    if (mine !== generation) return;
    if (kind !== 'end-presentation') stopLocal(kind === 'stop' ? 'Sharing stopped' : 'Controller left');
  } catch { if (mine === generation) showError('Could not finish that action. Check the connection and try again.'); }
  finally { if (pendingAction === action) pendingAction = null; }
}
for (const [id, kind] of [['controller-leave', 'leave'], ['controller-end-presentation', 'end-presentation'], ['controller-stop', 'stop']]) $(id).addEventListener('click', () => void sessionAction(kind));
function fit() {
  const zoom = Number(getComputedStyle(document.body).zoom) || 1;
  const value = `${(window.visualViewport?.height || innerHeight) / zoom}px`;
  if (document.documentElement.style.getPropertyValue('--controller-height') !== value)
    document.documentElement.style.setProperty('--controller-height', value);
}
let resizeFrame = null, lastPadSize;
function scheduleFit() {
  if (resizeFrame !== null) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    const rect = pad.getBoundingClientRect(), size = [rect.width, rect.height];
    if (lastPadSize && size.some((value, index) => Math.abs(value - lastPadSize[index]) > .5)) releaseInput();
    lastPadSize = size; fit();
  });
}
// Read/paint outside ResizeObserver delivery, especially under WebKit CSS zoom.
new ResizeObserver(scheduleFit).observe(pad);
window.addEventListener('resize', scheduleFit); window.visualViewport?.addEventListener('resize', scheduleFit);
window.addEventListener('blur', () => { focused = false; suspend(); });
window.addEventListener('focus', () => { focused = true; resumeControl(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) suspend(true); else { focused = document.hasFocus(); void resumeSession(); resumeControl(); } });
window.addEventListener('pagehide', () => { suspend(true); ws?.close(4001, 'Controller page suspended'); });
window.addEventListener('pageshow', () => { focused = document.hasFocus(); void resumeSession(); resumeControl(); });
paint(); fit();
if (scannedKey) { const key = scannedKey; scannedKey = null; connect(key); } else void resumeSession();
