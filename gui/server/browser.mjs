import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createBrowserSession } from './browser-session.mjs';

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
  tls, onConnect, onChange = () => {}, invitationMs = 300000, authMs = 5000,
  resumeMs = 120000, lifetimeMs = 12 * 60 * 60 * 1000 } = {}) {
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
  const cookieName = () => `dskcpy_resume_${port}`;
  function mayResume(req) {
    if (!session?.token || req.headers.host !== new URL(session.origin).host) return false;
    if (req.headers.origin && req.headers.origin !== session.origin) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    const value = (req.headers.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName()}=`))?.slice(cookieName().length + 1);
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
    const candidate = Buffer.from(value, 'base64url');
    const accepted = candidate.length === session.token.length && timingSafeEqual(candidate, session.token);
    candidate.fill(0); return accepted;
  }

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
    if (req.url === '/stream/session' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ resumable: mayResume(req) }));
      return;
    }
    if (req.url === '/stream/session' && req.method === 'POST') {
      if (!mayResume(req) || req.headers.origin !== session.origin) { res.writeHead(403).end(); return; }
      cancel();
      res.setHeader('Set-Cookie', `${cookieName()}=; HttpOnly; SameSite=Strict; Path=/stream; Max-Age=0${req.headers.origin.startsWith('https:') ? '; Secure' : ''}`);
      res.writeHead(204).end(); return;
    }
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
  wss.on('headers', (headers, req) => {
    if (!req.resumeToken) return;
    // Provisional until the one-use code is accepted. Never exposed to JS,
    // query strings, localStorage, sessionStorage, status or diagnostics.
    headers.push(`Set-Cookie: ${cookieName()}=${req.resumeToken.toString('base64url')}; HttpOnly; SameSite=Strict; Path=/stream; Max-Age=${Math.floor(lifetimeMs / 1000)}${req.headers.origin.startsWith('https:') ? '; Secure' : ''}`);
  });
  const upgrade = (req, socket, head) => {
    const resume = mayResume(req);
    if (req.url !== '/stream' || !allowedHost(req.headers.host) || !allowedOrigin(req.headers.origin)
        || (!resume && (!invitation || session || failures >= 10)) || sockets.size >= 4) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!resume) req.resumeToken = randomBytes(32);
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on('error', () => {});
      const timer = setTimeout(() => ws.terminate(), authMs);
      ws.on('close', () => { sockets.delete(ws); clearTimeout(timer); req.resumeToken?.fill(0); });
      if (resume) { clearTimeout(timer); session.attach(ws); return; }
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
        const token = Buffer.from(req.resumeToken);
        const active = createBrowserSession({ socket: ws, onConnect, resumeMs, lifetimeMs, onClose: () => {
          token.fill(0);
          if (session === active) session = null;
          onChange();
        } });
        session = Object.assign(active, { token, origin: req.headers.origin });
        onChange();
        await active.start();
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
