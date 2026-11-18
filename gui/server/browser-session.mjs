import net from 'node:net';
import { WebSocket } from 'ws';
import { SrdParser, validBrowserInput, MAX_PACKET } from './browser-protocol.mjs';
import { ack, avcParameters, touchPacket, MEDIA_FALLBACK_PROTOCOL, focusGeometry } from '../receiver/protocol.mjs';
import { createRtcMedia, completeLegacyConfiguration } from './browser-rtc.mjs';
import { createClipboardBroker } from './browser-clipboard.mjs';
import { createAdaptiveVideo, validVideoFeedback } from './adaptive-video.mjs';
import { publicWindowState } from './window-targets.mjs';

// Keep the native transport alive across a bounded browser suspension. Never
// retain video frames: only the wire header and codec parameter sets are replayed.
export function createBrowserSession({ socket, onConnect, onClose, resumeMs, lifetimeMs,
  mediaMode = 'webcodecs', rtcBind, keyboard = false, pointerButtons = false, viewOnly = false, textFocus = false, textFocusGeometry = false, clipboard = false,
  captureRecovery = false, adaptiveVideo = false, windowAudio = false, presentationControl = false,
  onControllerLeave = () => {}, nativeEndGraceMs = 15000, rtcMediaFactory = createRtcMedia, onChange = () => {}, windowGroup = null, onRetireWindow }) {
  let native, peer, closed = false, ready = false, nativeTimer, awayTimer;
  const canSplitControl = presentationControl && !viewOnly;
  let splitControl = false, presentationEnded = false, controller, controllerActive = false, controllerAlive = true, controllerAuthorized = false;
  let controllerAwayTimer, controllerRateAt = 0, controllerEvents = 0;
  const inputPeer = () => splitControl ? controller : peer;
  const inputActive = () => !splitControl || controllerActive;
  let listener, nativeEndTimer, recovering = false, restarting = false;
  let restartTimes = [];
  const canHearWindow = viewOnly && windowAudio;
  const canRecover = captureRecovery && !viewOnly;
  const canSwitchWindow = viewOnly && windowGroup && typeof onRetireWindow === 'function';
  const ownerToken = Object.freeze({});
  let currentWindow = windowGroup?.initial, pendingWindow = null, windowSwitching = false, windowSubscribed = false, lastWindowSwitch = -Infinity;
  function publishWindows(error) {
    if (!canSwitchWindow || closed || !ready || !windowSubscribed || !peer || peer.readyState !== WebSocket.OPEN || peer.bufferedAmount > 65536) return;
    peer.send(JSON.stringify({...publicWindowState(windowGroup,currentWindow,windowSwitching),...(error?{error}: {})}));
  }
  let wireHeader, videoConfig, audioConfig, width = 0, height = 0;
  let suspended = false, capturePaused = false, alive = true, rateAt = Date.now(), events = 0;
  const video = new Set(), audio = new Set(), touches = new Map();
  const focusSupported = textFocus && keyboard && !viewOnly;
  const pointerSupported = pointerButtons === true && keyboard && !viewOnly;
  const geometrySupported = focusSupported && textFocusGeometry;
  let geometrySubscribed = false, geometryAt = -Infinity;
  let focusAt = -Infinity, focusSubscribed = false;
  let keyboardStatusSubscribed = false, lastKeyboardStatus = null;
  const clipboardSupported = clipboard && keyboard && !viewOnly;
  const clipboardBroker = createClipboardBroker({ capable: clipboardSupported,
    allowed: () => ready && !closed && !suspended && !capturePaused && !recovering && inputActive() && Boolean(native),
    sendNative: packet => { if (!native || native.destroyed) return false; native.write(packet); return true; },
    respond: (target, result) => { if (target === inputPeer() && target.readyState === WebSocket.OPEN && target.bufferedAmount < 65536) target.send(JSON.stringify(result)); },
  });
  function keyboardStatus(status) {
    if (!keyboard || viewOnly || !['ready','blocked','unsupported'].includes(status) || closed) return;
    lastKeyboardStatus = status;
    if (status === 'blocked') clipboardBroker.disable();
    const target = inputPeer();
    if (ready && keyboardStatusSubscribed && !suspended && inputActive() && target?.readyState === WebSocket.OPEN && target.bufferedAmount <= MAX_PACKET)
      target.send(JSON.stringify({type:'keyboard-status',status}));
  }
  function focusHint(focused) {
    const target = inputPeer();
    if (!focusSupported || !focusSubscribed || !ready || closed || suspended || capturePaused || recovering || !native || native.destroyed
        || !inputActive() || !target || target.readyState !== WebSocket.OPEN
        || target.bufferedAmount > MAX_PACKET || ![true, false, null].includes(focused) || Date.now() - focusAt < 100) return;
    focusAt = Date.now(); target.send(JSON.stringify({ type: 'text-focus', focused }));
  }
  function focusGeometryHint(value) {
    const destination = inputPeer();
    if (!geometrySupported || !geometrySubscribed || !ready || !wireHeader || closed || suspended || capturePaused || recovering
        || !inputActive() || !native || native.destroyed || lastKeyboardStatus === 'blocked' || !destination || destination.readyState !== WebSocket.OPEN
        || destination.bufferedAmount > MAX_PACKET || Date.now() - geometryAt < 100) return;
    const target = value === null ? null : focusGeometry(value);
    if (value !== null && !target) return;
    geometryAt = Date.now(); destination.send(JSON.stringify({ type: 'text-focus-geometry', target }));
  }
  let rtc, rtcGeneration = 0, negotiating = false;
  let fallbackUsed = false;
  const rtcVideo = new Set(), rtcAudio = new Set();
  let rtcCleanup = Promise.resolve();
  const nativeAcks = new Map();
  const adaptiveSupported = adaptiveVideo && !viewOnly;
  const adaptive = createAdaptiveVideo();
  let qualitySubscribed = false, qualityEnabled = true, qualityAvailable = false, qualityFailed = false, lastQuality = null;
  function publishQuality() {
    if (!ready || closed || suspended || !qualitySubscribed || peer?.readyState !== WebSocket.OPEN || peer.bufferedAmount > 65536) return;
    if (!lastQuality && !qualityFailed) return; // Native startup has not reported settings yet.
    peer.send(JSON.stringify({type:'video-quality',available:qualityAvailable,automatic:qualityEnabled,...lastQuality}));
  }
  function videoQuality(value) {
    if (!adaptiveSupported || closed) return;
    if (value === null) { qualityFailed = true; qualityAvailable = false; publishQuality(); return; }
    if (qualityFailed) return;
    if (!value || ![0,1,2].includes(value.level) || !Number.isInteger(value.fps) || value.fps < 1 || value.fps > 240
        || !Number.isInteger(value.bitRate) || value.bitRate < 500000 || value.bitRate > 64000000) return;
    qualityAvailable = true; lastQuality = value; publishQuality();
  }
  const command = (value) => native?.write(Buffer.from([5, value]));
  function acknowledgeNative(type, pts) {
    if (closed || !native || BigInt(pts) <= (nativeAcks.get(type) ?? -1n)) return;
    nativeAcks.set(type, BigInt(pts)); native.write(ack(type, pts));
  }
  function stopRtc() {
    rtcGeneration++; negotiating = false;
    drain(rtcVideo, 4); drain(rtcAudio, 6);
    const previous = rtc; rtc = null;
    if (previous) rtcCleanup = Promise.all([rtcCleanup, previous.close()]).then(() => {}).catch(() => {});
  }
  function fallbackMedia() {
    if (closed || fallbackUsed || mediaMode !== 'webrtc' || !ready || recovering
        || !native || !peer || peer.readyState !== WebSocket.OPEN || peer.bufferedAmount > MAX_PACKET
        || peer.protocol !== MEDIA_FALLBACK_PROTOCOL) return false;
    fallbackUsed = true;
    // Retain this capture and its original authorization/lifetime. Discard the
    // old viewer epoch, release input and resume only through its existing cookie.
    suspend(); command(11); stopRtc(); drain(video, 4); drain(audio, 6);
    mediaMode = 'webcodecs';
    const target = peer; peer = null;
    // Some browsers omit service-restart close metadata. Only the negotiated
    // viewer receives this acknowledgment, before the old socket is retired.
    target.send(JSON.stringify({ type: 'media-fallback', mediaMode: 'webcodecs' }));
    target.close(1012, 'media-fallback');
    setTimeout(() => target.terminate(), 1000).unref();
    onChange(); return true;
  }
  function rtcFailure(mine, target) {
    if (closed || mine !== rtcGeneration || target !== peer) return;
    if (!fallbackMedia()) close();
  }
  async function negotiateRtc() {
    if (closed || mediaMode !== 'webrtc' || !videoConfig || !peer || rtc || negotiating) return;
    negotiating = true;
    const target = peer, mine = ++rtcGeneration;
    try {
      const active = rtcMediaFactory({ bind: rtcBind, configuration: videoConfig.subarray(16),
        onKeyframe: () => { if (!closed && rtcGeneration === mine && !suspended && !capturePaused) command(8); },
        onFailure: () => rtcFailure(mine, target),
        onConnected: () => { if (!closed && rtcGeneration === mine) onChange(); } });
      rtc = active;
      const offer = await active.offer();
      if (!closed && target === peer && rtcGeneration === mine && offer) {
        target.send(JSON.stringify({ type: 'rtc-offer', description: offer }));
      }
    } catch { rtcFailure(mine, target); }
    finally { if (rtcGeneration === mine) negotiating = false; }
  }
  function releaseTouches() {
    clipboardBroker.disable();
    if (pointerSupported && !touches.size) native?.write(touchPacket(3, 0, 0, 0, width, height));
    for (const [id, point] of touches) native?.write(touchPacket(3, id, point.x, point.y, width, height));
    touches.clear();
    if (keyboard) native?.write(Buffer.from([8, 2, 0, 0, 0]));
  }
  function resetInputSubscriptions() {
    focusSubscribed = keyboardStatusSubscribed = geometrySubscribed = false;
    focusAt = geometryAt = -Infinity;
    clipboardBroker.disable();
  }
  function presentationAvailable() {
    return !closed && !presentationEnded && ready && Boolean(wireHeader) && !recovering && !suspended && !capturePaused
      && Boolean(native && !native.destroyed && peer?.readyState === WebSocket.OPEN);
  }
  function presentationState() {
    return { presentation: splitControl, presentationEnded, presentationAvailable: presentationAvailable(),
      controllerConnected: Boolean(controller?.readyState === WebSocket.OPEN), controllerActive, controllerAuthorized };
  }
  function publishPresentation() {
    if (!splitControl) return;
    const state = presentationState();
    if (peer?.readyState === WebSocket.OPEN && peer.bufferedAmount < 65536)
      peer.send(JSON.stringify({ type: 'presentation-state', ...state }));
    if (controller?.readyState === WebSocket.OPEN && controller.bufferedAmount < 65536)
      controller.send(JSON.stringify({ type: 'controller-state', ...state, width, height }));
    onChange();
  }
  function suspendController() {
    if (!splitControl) return;
    controllerActive = false;
    releaseTouches(); resetInputSubscriptions();
    clearTimeout(controllerAwayTimer);
    // Controller expiry never ends presentation playback or extends its grant.
    controllerAwayTimer = setTimeout(() => detachController(true), resumeMs);
    publishPresentation();
  }
  function detachController(revoke = false) {
    const previous = controller; controller = null;
    controllerActive = false; releaseTouches(); resetInputSubscriptions();
    clearTimeout(controllerAwayTimer);
    if (previous) {
      previous.close(revoke ? 1008 : 1012, revoke ? 'controller-ended' : 'controller-away');
      setTimeout(() => previous.terminate(), 1000).unref();
    }
    if (revoke) { controllerAuthorized = false; onControllerLeave(); }
    else if (!closed && splitControl) controllerAwayTimer = setTimeout(() => detachController(true), resumeMs);
    publishPresentation();
  }
  function beginPresentation() {
    if (!canSplitControl || closed || !presentationAvailable() || controller) return false;
    if (!splitControl) {
      // Retire the old input epoch before the second role can be authenticated.
      releaseTouches(); resetInputSubscriptions(); splitControl = true;
      peer.send(JSON.stringify({ type: 'presentation-mode', role: 'presentation' }));
      publishPresentation();
    }
    return true;
  }
  function endPresentation() {
    if (!splitControl || closed || presentationEnded) return false;
    presentationEnded = true; command(11);
    const previous = peer; peer = null;
    stopRtc(); suspend(); drain(video, 4); drain(audio, 6); native?.resume();
    if (previous?.readyState === WebSocket.OPEN) {
      previous.send(JSON.stringify({ type: 'presentation-ended' }));
      previous.close(1008, 'presentation-ended');
      setTimeout(() => previous.terminate(), 1000).unref();
    }
    publishPresentation(); return true;
  }
  function writeInput(ws, message) {
    if (message[0] === 11) touches.clear(); // Native atomic click cancels the old primary gesture.
    if (message[0] === 10) return clipboardBroker.request(ws, message);
    if (message[0] === 3) {
      const id = message.readBigUInt64BE(2).toString();
      if (message[1] === 3) touches.clear();
      else if ([1, 6].includes(message[1])) touches.delete(id);
      else touches.set(id, { x: message.readUInt32BE(10), y: message.readUInt32BE(14) });
    }
    native.write(message); return true;
  }
  function attachController(ws) {
    if (!splitControl || closed || controller) { ws.close(1008, 'controller-busy'); return false; }
    clearTimeout(controllerAwayTimer);
    controller = ws; controllerActive = false; controllerAlive = true; controllerAuthorized = true;
    controllerAwayTimer = setTimeout(() => detachController(true), resumeMs);
    controllerRateAt = Date.now(); controllerEvents = 0; resetInputSubscriptions();
    ws.on('pong', () => { if (controller === ws) controllerAlive = true; });
    ws.on('close', code => { if (controller === ws) detachController([1000, 1008, 4000].includes(code)); });
    ws.on('message', (message, binary) => {
      if (closed || controller !== ws) return;
      if (Date.now() - controllerRateAt >= 1000) { controllerRateAt = Date.now(); controllerEvents = 0; }
      if (++controllerEvents > 1000 || ws.bufferedAmount > 65536 || native?.writableLength > 65536) { detachController(true); return; }
      if (!binary) {
        const text = message.toString();
        if (text === 'suspend') { suspendController(); return; }
        if (text === 'resume') {
          controllerActive = presentationAvailable();
          clearTimeout(controllerAwayTimer); publishPresentation(); return;
        }
        if (!controllerActive || !presentationAvailable()) return;
        if (text === 'keyboard-status-subscribe' && keyboard) { keyboardStatusSubscribed = true; if (lastKeyboardStatus) keyboardStatus(lastKeyboardStatus); return; }
        if (text === 'text-focus-subscribe' && focusSupported) { focusSubscribed = true; return; }
        if (text === 'text-focus-geometry-subscribe' && geometrySupported) { geometrySubscribed = true; geometryAt = -Infinity; return; }
        if (text === 'text-focus-geometry-unsubscribe') { geometrySubscribed = false; return; }
        if (text === 'clipboard-enable' && clipboardBroker.enable(ws)) return;
        if (text === 'clipboard-disable') { clipboardBroker.disable(); return; }
        detachController(true); return;
      }
      // A controller never acknowledges/controls media or submits RTC feedback.
      if (![3, 7, 8, 9, 10, 11].includes(message[0])) { detachController(true); return; }
      if (!controllerActive || !presentationAvailable()) return;
      if (!validBrowserInput(message, width, height, { keyboard, pointerButtons: pointerSupported, clipboard: clipboardSupported })) { detachController(true); return; }
      if (!writeInput(ws, message)) detachController(true);
    });
    ws.send(JSON.stringify({ type: 'controller-authenticated', role: 'controller', keyboard,
      pointerButtons: pointerSupported,
      clipboard: clipboardSupported, textFocus: focusSupported, textFocusGeometry: Boolean(geometrySupported), keyboardStatus: keyboard,
      width, height, ...presentationState() }));
    publishPresentation(); return true;
  }
  function suspend() {
    adaptive.reset();
    command(7); releaseTouches();
    if (!suspended) { suspended = true; awayTimer = setTimeout(close, resumeMs); }
    if (splitControl) suspendController();
  }
  function drain(pending, type) {
    if (pending.size) acknowledgeNative(type, [...pending].reduce((a, b) => BigInt(a) > BigInt(b) ? a : b));
    pending.clear();
  }
  function detach(ws, replaced = false) {
    if (closed || peer !== ws) return;
    peer = null;
    stopRtc();
    suspend(); drain(video, 4); drain(audio, 6);
    native?.resume();
    if (replaced) {
      ws.close(4002, 'Session opened in another page.');
      setTimeout(() => ws.terminate(), 1000).unref();
    } else ws.terminate();
  }
  function forward(packet) {
    const target = peer;
    if (!target || target.readyState !== WebSocket.OPEN) return;
    if (target.bufferedAmount > MAX_PACKET) { detach(target); return; }
    native?.pause();
    target.send(packet, { binary: true }, (error) => {
      if (error) detach(target);
      if (!closed) native?.resume();
    });
  }
  function announce() {
    if (!ready || !peer) return;
    peer.send(JSON.stringify({ type: 'authenticated', mediaMode, keyboard: keyboard && !splitControl, viewOnly,
      pointerButtons: pointerSupported && !splitControl,
      textFocus: focusSupported && !splitControl, textFocusGeometry: Boolean(geometrySupported) && !splitControl,
      keyboardStatus: keyboard && !viewOnly && !splitControl, clipboard: clipboardSupported && !splitControl,
      ...(canSplitControl ? { presentationControl: true, role: splitControl ? 'presentation' : 'combined' } : {}),
      windowSwitch: Boolean(canSwitchWindow), windowAudio: Boolean(canHearWindow),
      adaptiveVideo: adaptiveSupported,
      mediaFallback: mediaMode === 'webrtc' && !fallbackUsed && peer.protocol === MEDIA_FALLBACK_PROTOCOL }));
    if (wireHeader) forward(wireHeader);
    if (videoConfig && mediaMode === 'webcodecs') forward(videoConfig);
    if (audioConfig) forward(audioConfig);
    void negotiateRtc();
    // The receiver explicitly resumes after receiving the header. This avoids
    // waking capture if a restored page is still in the background.
  }
  function attach(ws) {
    if (closed) { ws.close(1000); return; }
    if (presentationEnded) { ws.close(1008, 'presentation-ended'); return; }
    if (peer && peer !== ws) detach(peer, true);
    keyboardStatusSubscribed = false;
    clipboardBroker.disable();
    peer = ws; alive = true; rateAt = Date.now(); events = 0;
    // Optional messages require this viewer's explicit acknowledgement. A
    // restored/older cached page must not inherit another socket's subscription.
    focusSubscribed = false; focusAt = -Infinity; geometrySubscribed = false; geometryAt = -Infinity;
    qualitySubscribed = false; windowSubscribed = false; adaptive.reset();
    ws.on('pong', () => { if (peer === ws) alive = true; });
    ws.on('close', (code) => {
      if (peer !== ws || closed) return;
      if (!splitControl && [4000, 1000, 1005, 1008].includes(code)) close();
      else detach(ws);
    });
    ws.on('message', (message, binary) => {
      if (peer !== ws || closed) return;
      if (Date.now() - rateAt >= 1000) { rateAt = Date.now(); events = 0; }
      if (++events > 1000 || native?.writableLength > 65536) { close(); return; }
      if (!binary) {
        if (splitControl && ['clipboard-enable', 'clipboard-disable', 'text-focus-subscribe', 'text-focus-geometry-subscribe',
          'text-focus-geometry-unsubscribe', 'keyboard-status-subscribe'].includes(message.toString())) return;
        if (message.toString() === 'window-select-subscribe') {
          if (!canSwitchWindow || !ready) { close(); return; }
          windowSubscribed = true; publishWindows(); return;
        }
        if (message.toString() === 'video-quality-subscribe') {
          if (!adaptiveSupported || !ready) { close(); return; }
          qualitySubscribed = true; publishQuality(); return;
        }
        if (message.length <= 512 && message[0] === 123) {
          let feedback; try { feedback = JSON.parse(message.toString()); } catch { close(); return; }
          if (feedback.type === 'window-select') {
            if (!canSwitchWindow || !windowSubscribed || Object.keys(feedback).length !== 2
                || typeof feedback.key !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(feedback.key)
                || !windowGroup.targets.some(t => t.key === feedback.key)) { close(); return; }
            if (windowSwitching || suspended || capturePaused || recovering || !wireHeader || !native) { publishWindows(); return; }
            void selectWindow(feedback.key); return;
          }
          if (['video-feedback','video-automatic'].includes(feedback.type)) {
            if (!qualitySubscribed || !adaptiveSupported) { close(); return; }
            if (feedback.type === 'video-automatic') {
              if (Object.keys(feedback).length !== 2 || typeof feedback.enabled !== 'boolean') { close(); return; }
              if (!qualityAvailable || suspended || capturePaused || recovering || !native) return;
              qualityEnabled = feedback.enabled; adaptive.reset();
              if (!qualityEnabled) { adaptive.manual(); command(12); }
              publishQuality(); return;
            }
            if (!validVideoFeedback(feedback)) { close(); return; }
            if (qualityAvailable && qualityEnabled && !suspended && !capturePaused && !recovering && native) {
              const level = adaptive.sample(feedback, ws.bufferedAmount);
              if (level !== null) command(12 + level);
            }
            return;
          }
        }
        if (message.toString() === 'media-fallback') { if (!fallbackMedia()) close(); return; }
        if (message.toString() === 'clipboard-enable') { if (!clipboardBroker.enable(ws)) close(); return; }
        if (message.toString() === 'clipboard-disable') { clipboardBroker.disable(); return; }
        if (message.toString() === 'text-focus-subscribe') {
          if (!focusSupported || !ready) { close(); return; }
          focusSubscribed = true; return;
        }
        if (['text-focus-geometry-subscribe', 'text-focus-geometry-unsubscribe'].includes(message.toString())) {
          if (!geometrySupported || !ready) { close(); return; }
          geometrySubscribed = message.toString() === 'text-focus-geometry-subscribe';
          geometryAt = -Infinity; return;
        }
        if (message.toString() === 'keyboard-status-subscribe' && ready && keyboard && !viewOnly) {
          keyboardStatusSubscribed = true;
          if (lastKeyboardStatus) keyboardStatus(lastKeyboardStatus);
          return;
        }
        if (message.toString() === 'suspend') { suspend(); return; }
        if (message.toString() === 'resume') {
          suspended = false; clearTimeout(awayTimer);
          if (keyboardStatusSubscribed && lastKeyboardStatus) keyboardStatus(lastKeyboardStatus);
          publishQuality();
          publishPresentation();
          return;
        }
        if (mediaMode === 'webrtc' && rtc && message.length <= 32768) {
          try {
            const signal = JSON.parse(message.toString());
            if (signal.type !== 'rtc-answer') { close(); return; }
            const active = rtc, mine = rtcGeneration, target = peer;
            void active.answer(signal.description).catch(() => rtcFailure(mine, target));
          } catch { close(); }
          return;
        }
        close(); return;
      }
      // Never apply old geometry, ACKs or text to a new capture epoch.
      if (recovering) return;
      if (!native || !validBrowserInput(message, width, height, { keyboard, pointerButtons: pointerSupported, clipboard: clipboardSupported })) { close(); return; }
      // Queued input from the old combined page cannot cross the ownership
      // transfer. Its media ACKs and explicit playback controls still work.
      if (splitControl && ![4, 6].includes(message[0])
          && !(message[0] === 5 && [7, 8, 9, 10, 11].includes(message[1]))) return;
      if (viewOnly && ![4, 6].includes(message[0])
          && !(message[0] === 5 && ([7, 8, 9, 11].includes(message[1]) || canHearWindow && message[1] === 10))) { close(); return; }
      if ([4, 6].includes(message[0])) {
        const pending = message[0] === 4 ? video : audio;
        const pts = message.readBigUInt64BE(1);
        if (!pending.has(pts.toString())) { close(); return; }
        for (const old of pending) if (BigInt(old) <= pts) pending.delete(old);
        acknowledgeNative(message[0], pts); return;
      } else if (suspended) {
        // A hidden page may acknowledge in-flight media, but cannot inject input.
        return;
      }
      if (capturePaused && ![4,6,5].includes(message[0])) return;
      if (message[0] === 5 && [7,8].includes(message[1])) { capturePaused = message[1] === 7; if (capturePaused) adaptive.reset(); }
      if (capturePaused) clipboardBroker.disable();
      if (splitControl && message[0] === 5 && [7,8].includes(message[1])) {
        if (capturePaused) suspendController(); else publishPresentation();
      }
      if (!writeInput(ws, message)) close();
    });
    announce();
  }
  function prepareRecovery(explicitWindow = false) {
    if (closed || presentationEnded || (!canRecover && !(explicitWindow && canSwitchWindow))) return false;
    if (recovering && !native) return true;
    recovering = true; ready = false;
    adaptive.manual(); qualityAvailable = false; qualityFailed = false; lastQuality = null;
    clearTimeout(nativeTimer); clearTimeout(awayTimer);
    listener?.close();
    releaseTouches(); stopRtc(); video.clear(); audio.clear(); nativeAcks.clear();
    suspended = capturePaused = true; awayTimer = setTimeout(close, resumeMs);
    if (splitControl) suspendController();
    wireHeader = videoConfig = audioConfig = null; width = height = 0;
    lastKeyboardStatus = null; focusSubscribed = keyboardStatusSubscribed = geometrySubscribed = false;
    const previous = native; native = null;
    previous?.end(); // Flush cancellation before closing the old input epoch.
    if (previous) setTimeout(() => previous.destroy(), 1000).unref();
    // Retain authorization while the owner classifies native shutdown. Only
    // the owner may start another child after all old capture/input cleanup.
    nativeEndTimer = setTimeout(() => close('capture-recovery'), nativeEndGraceMs);
    onChange(); return true;
  }
  async function selectWindow(key) {
    const target = windowGroup.targets.find(t => t.key === key);
    if (target === currentWindow) { publishWindows(); return; }
    if (Date.now()-lastWindowSwitch < 2000) { publishWindows('wait'); return; }
    let retirement;
    try { retirement = onRetireWindow(ownerToken); } catch { publishWindows('busy'); return; }
    if (!retirement?.done || typeof retirement.done.then !== 'function' || typeof retirement.cancel !== 'function') { publishWindows('busy'); return; }
    windowSwitching = true; pendingWindow = target; lastWindowSwitch = Date.now(); publishWindows();
    if (!prepareRecovery(true)) { retirement.cancel(); windowSwitching=false; pendingWindow=null; return; }
    const previous = peer; peer = null;
    previous?.close(1012,'window-switch');
    if (previous) setTimeout(()=>previous.terminate(),1000).unref();
    try {
      await rtcCleanup;
      if (!await retirement.done || closed) { close('capture-recovery'); return; }
      clearTimeout(nativeEndTimer);
      await start(); // Original grant/lifetime; only the native capture epoch changes.
    } catch { close('capture-recovery'); }
  }
  async function restartNative() {
    if (closed || presentationEnded || !canRecover || restarting) return false;
    restartTimes = restartTimes.filter(time => Date.now() - time < 30000);
    if (restartTimes.length >= 3) { close('capture-recovery'); return false; }
    restartTimes.push(Date.now());
    if (!prepareRecovery()) return false;
    restarting = true; clearTimeout(nativeEndTimer);
    // Notify only after the owner has classified this exit as recoverable.
    // Otherwise cached viewers must receive a terminal close, not an invitation
    // to reconnect through their remembered-device fallback.
    const target = peer; peer = null;
    target?.close(1012, 'capture-restart');
    if (target) setTimeout(() => target.terminate(), 1000).unref();
    try {
      await rtcCleanup;
      if (closed) return false;
      await start();
      return !closed;
    } finally { restarting = false; }
  }
  function createListener() { const server = net.createServer((socket) => {
    if (closed || native || listener !== server) { socket.destroy(); return; }
    native = socket; server.close(); clearTimeout(nativeTimer);
    socket.setNoDelay(true);
    const parser = new SrdParser((packet, header) => {
      if (closed || native !== socket) return;
      if (header) {
        recovering = false;
        if (pendingWindow) { currentWindow=pendingWindow;pendingWindow=null;windowSwitching=false;publishWindows(); }
        wireHeader = packet;
        width = packet.readUInt32BE(8); height = packet.readUInt32BE(12);
        if (suspended) command(7);
        publishPresentation();
      } else {
        const flags = packet.readUInt32BE(12);
        if (viewOnly && !canHearWindow && [4,8].includes(flags)) { close(); return; }
        if (flags === 32) { clipboardBroker.reply(packet.subarray(16)); return; }
        if ((flags & 1) || flags === 2) {
          let parameters;
          try {
            parameters = flags === 2 && videoConfig
              ? completeLegacyConfiguration(videoConfig.subarray(16), packet.subarray(16))
              : avcParameters(packet.subarray(16));
          } catch { /* A malformed legacy IDR cannot replace the working cache. */ }
          if (parameters?.length) {
            videoConfig = Buffer.alloc(16 + parameters.length);
            videoConfig.writeUInt32BE(parameters.length); videoConfig.writeUInt32BE(1, 12);
            videoConfig.set(parameters, 16);
            if (mediaMode === 'webrtc' && rtc) {
              try { rtc.configure?.(parameters); }
              catch { rtcFailure(rtcGeneration, peer); return; }
            }
          }
        }
        if (flags === 4 || flags === 16) audioConfig = packet;
        if (mediaMode === 'webrtc') {
          void negotiateRtc();
          const pts = packet.readBigUInt64BE(4);
          if ([0, 2, 8].includes(flags)) {
            const type = flags === 8 ? 6 : 4, pending = flags === 8 ? rtcAudio : rtcVideo;
            if (!rtc || suspended || capturePaused || !peer) acknowledgeNative(type, pts);
            else {
              pending.add(pts); if (pending.size > 8) { close(); return; }
              const active = rtc, mine = rtcGeneration, target = peer;
              const sending = flags === 8 ? active.sound(packet.subarray(16), pts) : active.frame(packet.subarray(16), pts, flags === 2);
              void Promise.resolve(sending).then(() => {
                if (native !== socket || mine !== rtcGeneration) return;
                pending.delete(pts); acknowledgeNative(type, pts);
              }).catch(() => { if (native === socket) rtcFailure(mine, target); });
            }
          } else if ([4, 16].includes(flags)) forward(packet);
          return;
        }
        const pending = flags === 8 ? audio : flags === 0 || flags === 2 ? video : null;
        if (pending) {
          const pts = packet.readBigUInt64BE(4);
          if (!peer) { native.write(ack(flags === 8 ? 6 : 4, pts)); return; }
          pending.add(pts.toString());
          if (pending.size > 8) { close(); return; }
        }
      }
      forward(packet);
    });
    socket.on('data', (chunk) => { if (native === socket) { try { parser.push(chunk); } catch { close(); } } });
    const ended = () => {
      if (native !== socket || closed) return;
      if (!prepareRecovery()) close();
    };
    socket.on('error', ended); socket.on('close', ended);
  }); return server; }
  function close(reason) {
    if (closed) return;
    closed = true;
    stopRtc();
    clearTimeout(nativeTimer); clearTimeout(awayTimer); clearTimeout(nativeEndTimer); clearTimeout(lifetimeTimer); clearInterval(pingTimer);
    if (splitControl) detachController(true);
    clearTimeout(controllerAwayTimer);
    releaseTouches(); listener?.close(); native?.destroy();
    const target = peer; peer = null;
    const category = ['capture-permission', 'capture-recovery'].includes(reason) ? reason : 'capture-ended';
    // All server-ended sessions are terminal, including view-only/older hosts.
    // Cached receivers otherwise treat a normal1000 as a transport retry and
    // could silently ask their remembered grant for a different capture.
    target?.close(1008, category);
    if (target) setTimeout(() => target.terminate(), 1000).unref();
    onClose();
  }
  const lifetimeTimer = setTimeout(close, lifetimeMs);
  const pingTimer = setInterval(() => {
    if (peer) {
      if (!alive) detach(peer);
      else { alive = false; peer.ping(); }
    }
    if (controller) {
      if (!controllerAlive) detachController();
      else { controllerAlive = false; controller.ping(); }
    }
  }, 5000);
  attach(socket);
  async function start() {
    try {
      listener = createListener();
      await new Promise((resolve, reject) => {
        listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve);
      });
      if (closed) { listener.close(); return; }
      ready = true; nativeTimer = setTimeout(close, 10000); announce();
      await onConnect({ port: listener.address().port, keyboard, pointerButtons: pointerSupported, viewOnly, textFocus: focusSupported, focusHint,
        textFocusGeometry: Boolean(geometrySupported), focusGeometryHint, keyboardStatus, clipboard: clipboardSupported,
        windowSwitch: Boolean(canSwitchWindow), windowAudio: Boolean(canHearWindow), windowOwner: ownerToken, windowTarget: pendingWindow || currentWindow,
        adaptiveVideo: adaptiveSupported, videoQuality,
        captureRecovery: canRecover, restartNative, close, get closed() { return closed; } });
    } catch { close(); }
  }
  return { start, attach, close, beginPresentation, endPresentation, attachController, detachController,
    get presentationState() { return presentationState(); },
    get presentation() { return splitControl; }, get controllerConnected() { return Boolean(controller); },
    get mediaMode() { return mediaMode; }, get recovering() { return recovering; }, get cleanup() { return rtcCleanup; } };
}
