import net from 'node:net';
import { WebSocket } from 'ws';
import { SrdParser, validBrowserInput, MAX_PACKET } from './browser-protocol.mjs';
import { ack, avcParameters, touchPacket } from '../receiver/protocol.mjs';
import { createRtcMedia } from './browser-rtc.mjs';
import { createClipboardBroker } from './browser-clipboard.mjs';

// Keep the native transport alive across a bounded browser suspension. Never
// retain video frames: only the wire header and codec parameter sets are replayed.
export function createBrowserSession({ socket, onConnect, onClose, resumeMs, lifetimeMs,
  mediaMode = 'webcodecs', rtcBind, keyboard = false, viewOnly = false, textFocus = false, clipboard = false,
  captureRecovery = false, nativeEndGraceMs = 15000, rtcMediaFactory = createRtcMedia, onChange = () => {} }) {
  let native, peer, closed = false, ready = false, nativeTimer, awayTimer;
  let listener, nativeEndTimer, recovering = false, restarting = false;
  let restartTimes = [];
  const canRecover = captureRecovery && !viewOnly;
  let wireHeader, videoConfig, audioConfig, width = 0, height = 0;
  let suspended = false, capturePaused = false, alive = true, rateAt = Date.now(), events = 0;
  const video = new Set(), audio = new Set(), touches = new Map();
  const focusSupported = textFocus && keyboard && !viewOnly;
  let focusAt = -Infinity, focusSubscribed = false;
  let keyboardStatusSubscribed = false, lastKeyboardStatus = null;
  const clipboardSupported = clipboard && keyboard && !viewOnly;
  const clipboardBroker = createClipboardBroker({ capable: clipboardSupported,
    allowed: () => ready && !closed && !suspended && !capturePaused && !recovering && Boolean(native),
    sendNative: packet => { if (!native || native.destroyed) return false; native.write(packet); return true; },
    respond: (target, result) => { if (target === peer && target.readyState === WebSocket.OPEN && target.bufferedAmount < 65536) target.send(JSON.stringify(result)); },
  });
  function keyboardStatus(status) {
    if (!keyboard || viewOnly || !['ready','blocked','unsupported'].includes(status) || closed) return;
    lastKeyboardStatus = status;
    if (ready && keyboardStatusSubscribed && !suspended && peer?.readyState === WebSocket.OPEN && peer.bufferedAmount <= MAX_PACKET)
      peer.send(JSON.stringify({type:'keyboard-status',status}));
  }
  function focusHint(focused) {
    if (!focusSupported || !focusSubscribed || !ready || closed || suspended || !peer || peer.readyState !== WebSocket.OPEN
        || peer.bufferedAmount > MAX_PACKET || ![true, false, null].includes(focused) || Date.now() - focusAt < 100) return;
    focusAt = Date.now(); peer.send(JSON.stringify({ type: 'text-focus', focused }));
  }
  let rtc, rtcGeneration = 0, negotiating = false;
  let rtcCleanup = Promise.resolve();
  const nativeAcks = new Map();
  const command = (value) => native?.write(Buffer.from([5, value]));
  function acknowledgeNative(type, pts) {
    if (closed || !native || BigInt(pts) <= (nativeAcks.get(type) ?? -1n)) return;
    nativeAcks.set(type, BigInt(pts)); native.write(ack(type, pts));
  }
  function stopRtc() {
    rtcGeneration++; negotiating = false;
    const previous = rtc; rtc = null;
    if (previous) rtcCleanup = Promise.all([rtcCleanup, previous.close()]).then(() => {}).catch(() => {});
  }
  async function negotiateRtc() {
    if (closed || mediaMode !== 'webrtc' || !videoConfig || !peer || rtc || negotiating) return;
    negotiating = true;
    const target = peer, mine = ++rtcGeneration;
    try {
      const active = rtcMediaFactory({ bind: rtcBind, configuration: videoConfig.subarray(16),
        onKeyframe: () => { if (!closed && rtcGeneration === mine && !suspended && !capturePaused) command(8); },
        onFailure: () => { if (!closed && rtcGeneration === mine) close(); },
        onConnected: () => { if (!closed && rtcGeneration === mine) onChange(); } });
      rtc = active;
      const offer = await active.offer();
      if (!closed && target === peer && rtcGeneration === mine && offer) {
        target.send(JSON.stringify({ type: 'rtc-offer', description: offer }));
      }
    } catch { if (!closed && rtcGeneration === mine) close(); }
    finally { if (rtcGeneration === mine) negotiating = false; }
  }
  function releaseTouches() {
    clipboardBroker.disable();
    for (const [id, point] of touches) native?.write(touchPacket(3, id, point.x, point.y, width, height));
    touches.clear();
    if (keyboard) native?.write(Buffer.from([8, 2, 0, 0, 0]));
  }
  function suspend() {
    command(7); releaseTouches();
    if (!suspended) { suspended = true; awayTimer = setTimeout(close, resumeMs); }
  }
  function drain(pending, type) {
    if (pending.size) native?.write(ack(type, [...pending].at(-1)));
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
    peer.send(JSON.stringify({ type: 'authenticated', mediaMode, keyboard, viewOnly, textFocus: focusSupported, keyboardStatus: keyboard && !viewOnly, clipboard: clipboardSupported }));
    if (wireHeader) forward(wireHeader);
    if (videoConfig && mediaMode === 'webcodecs') forward(videoConfig);
    if (audioConfig) forward(audioConfig);
    void negotiateRtc();
    // The receiver explicitly resumes after receiving the header. This avoids
    // waking capture if a restored page is still in the background.
  }
  function attach(ws) {
    if (closed) { ws.close(1000); return; }
    if (peer && peer !== ws) detach(peer, true);
    keyboardStatusSubscribed = false;
    clipboardBroker.disable();
    peer = ws; alive = true; rateAt = Date.now(); events = 0;
    // Optional messages require this viewer's explicit acknowledgement. A
    // restored/older cached page must not inherit another socket's subscription.
    focusSubscribed = false; focusAt = -Infinity;
    ws.on('pong', () => { if (peer === ws) alive = true; });
    ws.on('close', (code) => {
      if (peer !== ws || closed) return;
      if ([4000, 1000, 1005, 1008].includes(code)) close();
      else detach(ws);
    });
    ws.on('message', (message, binary) => {
      if (peer !== ws || closed) return;
      if (Date.now() - rateAt >= 1000) { rateAt = Date.now(); events = 0; }
      if (++events > 1000 || native?.writableLength > 65536) { close(); return; }
      if (!binary) {
        if (message.toString() === 'clipboard-enable') { if (!clipboardBroker.enable(ws)) close(); return; }
        if (message.toString() === 'clipboard-disable') { clipboardBroker.disable(); return; }
        if (message.toString() === 'text-focus-subscribe') {
          if (!focusSupported || !ready) { close(); return; }
          focusSubscribed = true; return;
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
          return;
        }
        if (mediaMode === 'webrtc' && rtc && message.length <= 32768) {
          try {
            const signal = JSON.parse(message.toString());
            if (signal.type !== 'rtc-answer') { close(); return; }
            void rtc.answer(signal.description).catch(close);
          } catch { close(); }
          return;
        }
        close(); return;
      }
      // Never apply old geometry, ACKs or text to a new capture epoch.
      if (recovering) return;
      if (!native || !validBrowserInput(message, width, height, { keyboard, clipboard: clipboardSupported })) { close(); return; }
      if (viewOnly && ![4, 6].includes(message[0])
          && !(message[0] === 5 && [7, 8, 9, 11].includes(message[1]))) { close(); return; }
      if ([4, 6].includes(message[0])) {
        const pending = message[0] === 4 ? video : audio;
        const pts = message.readBigUInt64BE(1);
        if (!pending.has(pts.toString())) { close(); return; }
        for (const old of pending) if (BigInt(old) <= pts) pending.delete(old);
      } else if (suspended) {
        // A hidden page may acknowledge in-flight media, but cannot inject input.
        return;
      }
      if (capturePaused && ![4,6,5].includes(message[0])) return;
      if (message[0] === 10) { if (!clipboardBroker.request(ws, message)) close(); return; }
      if (message[0] === 5 && [7,8].includes(message[1])) capturePaused = message[1] === 7;
      if (capturePaused) clipboardBroker.disable();
      if (message[0] === 3) {
        const id = message.readBigUInt64BE(2).toString();
        if (message[1] === 3) touches.clear();
        else if ([1, 6].includes(message[1])) touches.delete(id);
        else touches.set(id, { x: message.readUInt32BE(10), y: message.readUInt32BE(14) });
      }
      native.write(message);
    });
    announce();
  }
  function prepareRecovery() {
    if (closed || !canRecover) return false;
    if (recovering && !native) return true;
    recovering = true; ready = false;
    clearTimeout(nativeTimer); clearTimeout(awayTimer);
    listener?.close();
    releaseTouches(); stopRtc(); video.clear(); audio.clear(); nativeAcks.clear();
    suspended = capturePaused = true; awayTimer = setTimeout(close, resumeMs);
    wireHeader = videoConfig = audioConfig = null; width = height = 0;
    lastKeyboardStatus = null; focusSubscribed = keyboardStatusSubscribed = false;
    const previous = native; native = null;
    previous?.end(); // Flush cancellation before closing the old input epoch.
    if (previous) setTimeout(() => previous.destroy(), 1000).unref();
    // Retain authorization while the owner classifies native shutdown. Only
    // the owner may start another child after all old capture/input cleanup.
    nativeEndTimer = setTimeout(() => close('capture-recovery'), nativeEndGraceMs);
    onChange(); return true;
  }
  async function restartNative() {
    if (closed || !canRecover || restarting) return false;
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
        wireHeader = packet;
        width = packet.readUInt32BE(8); height = packet.readUInt32BE(12);
        if (suspended) command(7);
      } else {
        const flags = packet.readUInt32BE(12);
        if (flags === 32) { clipboardBroker.reply(packet.subarray(16)); return; }
        if ((flags & 1) || (flags === 2 && !videoConfig)) {
          const parameters = avcParameters(packet.subarray(16));
          if (parameters.length) {
            videoConfig = Buffer.alloc(16 + parameters.length);
            videoConfig.writeUInt32BE(parameters.length); videoConfig.writeUInt32BE(1, 12);
            videoConfig.set(parameters, 16);
          }
        }
        if (flags === 4 || flags === 16) audioConfig = packet;
        if (mediaMode === 'webrtc') {
          void negotiateRtc();
          const pts = packet.readBigUInt64BE(4);
          if ([0, 2].includes(flags)) {
            if (!rtc || suspended || capturePaused || !peer) acknowledgeNative(4, pts);
            else void rtc.frame(packet.subarray(16), pts, flags === 2)
              .then(() => { if (native === socket) acknowledgeNative(4, pts); }).catch(() => { if (native === socket) close(); });
          } else if (flags === 8) {
            if (!rtc || suspended || capturePaused || !peer) acknowledgeNative(6, pts);
            else void rtc.sound(packet.subarray(16), pts)
              .then(() => { if (native === socket) acknowledgeNative(6, pts); }).catch(() => { if (native === socket) close(); });
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
    if (!peer) return;
    if (!alive) detach(peer);
    else { alive = false; peer.ping(); }
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
      await onConnect({ port: listener.address().port, keyboard, viewOnly, textFocus: focusSupported, focusHint, keyboardStatus, clipboard: clipboardSupported,
        captureRecovery: canRecover, restartNative, close, get closed() { return closed; } });
    } catch { close(); }
  }
  return { start, attach, close, mediaMode, get recovering() { return recovering; }, get cleanup() { return rtcCleanup; } };
}
