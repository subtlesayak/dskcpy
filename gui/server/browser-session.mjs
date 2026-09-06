import net from 'node:net';
import { WebSocket } from 'ws';
import { SrdParser, validBrowserInput, MAX_PACKET } from './browser-protocol.mjs';
import { ack, avcParameters, touchPacket } from '../receiver/protocol.mjs';

// Keep the native transport alive across a bounded browser suspension. Never
// retain video frames: only the wire header and codec parameter sets are replayed.
export function createBrowserSession({ socket, onConnect, onClose, resumeMs, lifetimeMs }) {
  let native, peer, closed = false, ready = false, nativeTimer, awayTimer;
  let wireHeader, videoConfig, audioConfig, width = 0, height = 0;
  let suspended = false, alive = true, rateAt = Date.now(), events = 0;
  const video = new Set(), audio = new Set(), touches = new Map();
  const command = (value) => native?.write(Buffer.from([5, value]));
  function releaseTouches() {
    for (const [id, point] of touches) native?.write(touchPacket(3, id, point.x, point.y, width, height));
    touches.clear();
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
    peer.send(JSON.stringify({ type: 'authenticated' }));
    if (wireHeader) forward(wireHeader);
    if (videoConfig) forward(videoConfig);
    if (audioConfig) forward(audioConfig);
    // The receiver explicitly resumes after receiving the header. This avoids
    // waking capture if a restored page is still in the background.
  }
  function attach(ws) {
    if (closed) { ws.close(1000); return; }
    if (peer && peer !== ws) detach(peer, true);
    peer = ws; alive = true; rateAt = Date.now(); events = 0;
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
        if (message.toString() === 'suspend') { suspend(); return; }
        if (message.toString() === 'resume') {
          suspended = false; clearTimeout(awayTimer); return;
        }
        close(); return;
      }
      if (!native || !validBrowserInput(message, width, height)) { close(); return; }
      if ([4, 6].includes(message[0])) {
        const pending = message[0] === 4 ? video : audio;
        const pts = message.readBigUInt64BE(1);
        if (!pending.has(pts.toString())) { close(); return; }
        for (const old of pending) if (BigInt(old) <= pts) pending.delete(old);
      } else if (suspended) {
        // A hidden page may acknowledge in-flight media, but cannot inject input.
        return;
      }
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
  const listener = net.createServer((socket) => {
    if (closed || native) { socket.destroy(); return; }
    native = socket; listener.close(); clearTimeout(nativeTimer);
    socket.setNoDelay(true);
    const parser = new SrdParser((packet, header) => {
      if (closed) return;
      if (header) {
        wireHeader = packet;
        width = packet.readUInt32BE(8); height = packet.readUInt32BE(12);
        if (suspended) command(7);
      } else {
        const flags = packet.readUInt32BE(12);
        if ((flags & 1) || (flags === 2 && !videoConfig)) {
          const parameters = avcParameters(packet.subarray(16));
          if (parameters.length) {
            videoConfig = Buffer.alloc(16 + parameters.length);
            videoConfig.writeUInt32BE(parameters.length); videoConfig.writeUInt32BE(1, 12);
            videoConfig.set(parameters, 16);
          }
        }
        if (flags === 4 || flags === 16) audioConfig = packet;
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
    socket.on('data', (chunk) => { try { parser.push(chunk); } catch { close(); } });
    socket.on('error', close); socket.on('close', close);
  });
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(nativeTimer); clearTimeout(awayTimer); clearTimeout(lifetimeTimer); clearInterval(pingTimer);
    releaseTouches(); listener.close(); native?.destroy();
    const target = peer; peer = null;
    target?.close(1000, 'Session ended. Create a new code on the computer.');
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
      await new Promise((resolve, reject) => {
        listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve);
      });
      if (closed) { listener.close(); return; }
      ready = true; nativeTimer = setTimeout(close, 10000); announce();
      await onConnect({ port: listener.address().port, close, get closed() { return closed; } });
    } catch { close(); }
  }
  return { start, attach, close };
}
