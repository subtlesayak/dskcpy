import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { SrdParser, validBrowserInput, MAX_PACKET } from './browser-protocol.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/receiver.mjs', ['receiver.mjs', 'text/javascript; charset=utf-8']],
  ['/protocol.mjs', ['protocol.mjs', 'text/javascript; charset=utf-8']],
  ['/receiver.css', ['receiver.css', 'text/css; charset=utf-8']],
]);

export function receiverOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DSKCPY_VIEWER_ORIGIN must be a trusted HTTPS origin with no path or credentials.');
  }
  return url.origin;
}

// A separate, loopback-only surface: never serves controller APIs or logs.
// Remote access is opt-in via a user-managed Tailscale Serve HTTPS proxy.
export function createBrowserReceiver({ configuredPort = 27180, origin,
  tls, onConnect, onChange = () => {}, invitationMs = 300000, authMs = 5000 } = {}) {
  const remoteOrigin = receiverOrigin(origin);
  let port;
  let listening;
  let secureServer;
  let mode = 'local';
  let invitation = null;
  let session = null;
  let expiresAt = null;
  let expiryTimer;
  let failures = 0;
  const sockets = new Set();
  const viewerUrl = () => `${['local', 'usb'].includes(mode) ? `http://127.0.0.1:${port}` : remoteOrigin}/`;
  const localOrigins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const allowedHost = (host) => localOrigins().some((v) => new URL(v).host === host)
    || Boolean(remoteOrigin && new URL(remoteOrigin).host === host);
  const allowedOrigin = (value) => localOrigins().includes(value) || Boolean(remoteOrigin && value === remoteOrigin);

  function status() {
    return { waiting: Boolean(invitation), connected: Boolean(session),
      url: port ? viewerUrl() : null, remote: !['local', 'usb'].includes(mode),
      remoteAvailable: Boolean(remoteOrigin), mode, expiresAt };
  }
  function cancel() {
    clearTimeout(expiryTimer);
    invitation?.fill(0);
    invitation = null;
    expiresAt = null;
    session?.close();
    for (const socket of sockets) socket.terminate();
    onChange();
  }

  const serve = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const asset = assets.get(req.url);
    if (!allowedHost(req.headers.host)) { res.writeHead(403).end(); return; }
    if (!asset || req.method !== 'GET') { res.writeHead(404).end(); return; }
    try {
      const data = await readFile(fileURLToPath(new URL(`../receiver/${asset[0]}`, import.meta.url)));
      res.writeHead(200, { 'Content-Type': asset[1] }).end(data);
    } catch { res.writeHead(503).end('Receiver assets unavailable.'); }
  };
  const server = http.createServer(serve);
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256, perMessageDeflate: false });
  const upgrade = (req, socket, head) => {
    if (req.url !== '/stream' || !allowedHost(req.headers.host) || !allowedOrigin(req.headers.origin)
        || !invitation || session || sockets.size >= 4 || failures >= 10) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('error', () => {});
      const timer = setTimeout(() => ws.terminate(), authMs);
      ws.on('close', () => { sockets.delete(ws); clearTimeout(timer); });
      ws.once('message', async (data, binary) => {
        clearTimeout(timer);
        const candidate = !binary && /^[A-Za-z0-9_-]{32}$/.test(data.toString())
          ? Buffer.from(data.toString(), 'base64url') : Buffer.alloc(0);
        const accepted = invitation && candidate.length === invitation.length
          && timingSafeEqual(candidate, invitation);
        candidate.fill(0);
        if (!accepted || session) {
          if (++failures >= 10) cancel();
          ws.close(1008, 'Session key rejected or expired.');
          return;
        }
        invitation.fill(0); invitation = null;
        clearTimeout(expiryTimer); expiresAt = null;
        for (const other of sockets) if (other !== ws) other.terminate();
        let native;
        let closed = false;
        let nativeTimer;
        let width = 0, height = 0;
        let rateAt = Date.now(), events = 0;
        const video = new Set(), audio = new Set();
        const listener = net.createServer((socket) => {
          if (closed || native) { socket.destroy(); return; }
          native = socket;
          listener.close(); clearTimeout(nativeTimer);
          socket.setNoDelay(true);
          const parser = new SrdParser((packet, header) => {
            if (closed) return;
            if (header) { width = packet.readUInt32BE(8); height = packet.readUInt32BE(12); }
            else {
              const flags = packet.readUInt32BE(12);
              const pending = flags === 8 ? audio : flags === 0 || flags === 2 ? video : null;
              if (pending) {
                pending.add(packet.readBigUInt64BE(4).toString());
                if (pending.size > 8) { close(); return; }
              }
            }
            if (ws.bufferedAmount > MAX_PACKET) { close(); return; }
            socket.pause();
            ws.send(packet, { binary: true }, (error) => { if (error) close(); else if (!closed) socket.resume(); });
          });
          socket.on('data', (chunk) => { try { parser.push(chunk); } catch { close(); } });
          socket.on('error', close);
          socket.on('close', close);
        });
        function close() {
          if (closed) return;
          closed = true;
          clearTimeout(nativeTimer); clearInterval(pingTimer);
          listener.close(); native?.destroy();
          ws.close(1000, 'Session ended. Create a new key on the desktop.');
          // A peer which stops reading cannot retain an orphaned socket.
          const cleanup = setTimeout(() => ws.terminate(), 1000); cleanup.unref();
          if (session?.close === close) session = null;
          onChange();
        }
        let alive = true;
        const pingTimer = setInterval(() => { if (!alive) close(); else { alive = false; ws.ping(); } }, 5000);
        ws.on('pong', () => { alive = true; });
        ws.on('close', close);
        ws.on('message', (message, binaryInput) => {
          if (Date.now() - rateAt >= 1000) { rateAt = Date.now(); events = 0; }
          if (++events > 1000 || !binaryInput || !native || !validBrowserInput(message, width, height)
              || native.writableLength > 65536) { close(); return; }
          if ([4, 6].includes(message[0])) {
            const pending = message[0] === 4 ? video : audio;
            const pts = message.readBigUInt64BE(1);
            if (!pending.has(pts.toString())) { close(); return; }
            // Native ACKs are cumulative; a late older ACK is never forwarded.
            for (const old of pending) if (BigInt(old) <= pts) pending.delete(old);
          }
          native.write(message);
        });
        session = { close };
        onChange();
        try {
          await new Promise((resolve, reject) => {
            listener.once('error', reject);
            listener.listen(0, '127.0.0.1', resolve);
          });
          if (closed) return;
          nativeTimer = setTimeout(close, 10000);
          ws.send(JSON.stringify({ type: 'authenticated' }));
          await onConnect({ port: listener.address().port, close, get closed() { return closed; } });
        } catch { close(); }
      });
    });
  };
  server.on('upgrade', upgrade);

  async function invite(connection = 'local') {
    if (invitation || session) throw new Error('A browser session is already open. Stop it first.');
    if (!['local', 'usb', 'wifi', 'ip', 'internet'].includes(connection)) throw new Error('Choose a browser connection method.');
    if (!['local', 'usb'].includes(connection) && !remoteOrigin) {
      throw new Error('Configure a trusted HTTPS receiver address before using Wi-Fi, IP or Internet. USB and local tests work without certificates.');
    }
    if (!listening) {
      listening = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(configuredPort, '127.0.0.1', () => { port = server.address().port; resolve(); });
      }).catch((error) => { listening = null; throw error; });
    }
    await listening;
    if (!['local', 'usb'].includes(connection) && tls && !secureServer) {
      if (!isPrivateBind(tls.bind) || !Number.isInteger(tls.port) || tls.port < 1 || tls.port > 65535) {
        throw new Error('TLS receiver must bind an explicit private IPv4 address and valid port, never all interfaces.');
      }
      const [cert, key] = await Promise.all([readFile(tls.cert), readFile(tls.key)]);
      const secure = https.createServer({ cert, key, minVersion: 'TLSv1.2' }, serve);
      secure.on('upgrade', upgrade);
      secure.requestTimeout = 10000; secure.headersTimeout = 10000; secure.maxConnections = 32;
      await new Promise((resolve, reject) => {
        secure.once('error', reject); secure.listen(tls.port, tls.bind, resolve);
      });
      secureServer = secure;
    }
    mode = connection;
    invitation = randomBytes(24);
    failures = 0;
    expiresAt = new Date(Date.now() + invitationMs).toISOString();
    expiryTimer = setTimeout(cancel, invitationMs);
    onChange();
    return { key: invitation.toString('base64url'), ...status() };
  }
  async function shutdown() {
    cancel();
    wss.close();
    if (listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    if (secureServer) await new Promise((resolve) => { secureServer.close(resolve); secureServer.closeAllConnections(); });
  }
  return { invite, status, cancel, shutdown, get port() { return port; } };
}

export function isPrivateBind(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 100 && b >= 64 && b <= 127);
}
