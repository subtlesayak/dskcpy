import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createBrowserSession } from './browser-session.mjs';
import { deviceDigest, deviceName, TRUST_LIFETIME_MS } from './trusted-devices.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/join', ['index.html', 'text/html; charset=utf-8']],
  ['/receiver.mjs', ['receiver.mjs', 'text/javascript; charset=utf-8']],
  ['/rtc.mjs', ['rtc.mjs', 'text/javascript; charset=utf-8']],
  ['/video.mjs', ['video.mjs', 'text/javascript; charset=utf-8']],
  ['/keyboard.mjs', ['keyboard.mjs', 'text/javascript; charset=utf-8']],
  ['/protocol.mjs', ['protocol.mjs', 'text/javascript; charset=utf-8']],
  ['/remembered.mjs', ['remembered.mjs', 'text/javascript; charset=utf-8']],
  ['/lifecycle.mjs', ['lifecycle.mjs', 'text/javascript; charset=utf-8']],
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
  tls, rtcBind = '127.0.0.1', onConnect, onChange = () => {}, invitationMs = 300000, authMs = 5000,
  resumeMs = 120000, lifetimeMs = 12 * 60 * 60 * 1000, trustedDevices, onTrustedConnect } = {}) {
  const remoteOrigin = receiverOrigin(origin);
  let port;
  let listening;
  let secureServer;
  let mode = 'local';
  let invitation = null;
  let session = null;
  let expiresAt = null;
  let trustedTicket = null, enrollment = null, trustedConnecting = false, accessGeneration = 0;
  let rememberProfile = null;
  const deviceCookie = 'dskcpy_device_v1';
  let inputPolicy = { keyboard: false, viewOnly: false };
  let expiryTimer;
  let failures = 0;
  let pendingCleanup = Promise.resolve();
  const sockets = new Set();
  const viewerUrl = () => `${['local', 'usb'].includes(mode) ? `http://127.0.0.1:${port}` : remoteOrigin}/`;
  const localOrigins = () => [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const allowedHost = (host) => localOrigins().some((v) => new URL(v).host === host)
    || Boolean(remoteOrigin && new URL(remoteOrigin).host === host);
  const allowedOrigin = (value) => localOrigins().includes(value) || Boolean(remoteOrigin && value === remoteOrigin);
  const cookieName = () => `dskcpy_resume_${port}`;
  function mayResume(req) {
    if (session?.deviceId && !trustedDevices?.enabled(session.deviceId)) return false;
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

  const cookieValue = req => (req.headers.cookie || '').split(';').map(p => p.trim())
    .find(p => p.startsWith(`${deviceCookie}=`))?.slice(deviceCookie.length + 1);
  const sameOrigin = req => req.headers.origin === remoteOrigin
    && req.headers.host === new URL(remoteOrigin).host && req.headers['sec-fetch-site'] !== 'cross-site';
  const enrollmentActive = () => enrollment && enrollment.expiresAt > Date.now() && enrollment.source === session;
  function trustedStatus() {
    return { ...(trustedDevices?.snapshot() || { available: false, paused: true, devices: [] }),
      pending: enrollmentActive() ? [{ id: enrollment.id, name: enrollment.name, expiresAt: enrollment.expiresAt }] : [] };
  }
  async function trustAction(action, id) {
    await trustedDevices?.ready;
    if (!trustedDevices) throw new Error('Remembered access is unavailable.');
    if (action === 'approve') {
      if (!enrollmentActive() || enrollment.id !== id || !session?.rememberProfile) throw new Error('This device request expired. Ask the device to try again.');
      const pending = enrollment;
      await trustedDevices.approve({ id: pending.id, digest: pending.digest, name: pending.name,
        origin: pending.origin, profile: session.rememberProfile });
      if (session === pending.source) session.deviceId = pending.id;
      if (enrollment === pending) enrollment = null;
    } else if (action === 'reject') {
      if (enrollment?.id === id) enrollment = null;
    } else if (action === 'revoke') {
      accessGeneration++;
      if (trustedTicket?.id === id || session?.deviceId === id) cancel();
      await trustedDevices.revoke(id);
    } else if (action === 'pause') {
      accessGeneration++; trustedDevices.block(); cancel(); await trustedDevices.pause(true);
    } else if (action === 'resume') {
      await trustedDevices.pause(false); await ensureListening('internet');
    } else throw new Error('Unknown device action.');
    onChange(); return trustedStatus();
  }
  async function readTrustBody(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('Expected JSON.');
    let body = '';
    for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1024) throw new Error('Request too large.'); }
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
    return value;
  }
  async function trustedRequest(req, res) {
    const json = (code, value) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (!remoteOrigin || !sameOrigin(req) || !trustedDevices || req.method !== 'POST') { json(403, { error: 'Use the private HTTPS receiver.' }); return; }
    try {
      await trustedDevices.ready;
      const body = await readTrustBody(req);
      if (req.url === '/stream/remember') {
        if (!mayResume(req) || !session?.rememberProfile || !trustedDevices.snapshot().available) throw new Error('Pair through a full-desktop private invitation first.');
        if (enrollmentActive()) throw new Error('A device approval is already waiting on the host.');
        const token = randomBytes(32).toString('base64url');
        enrollment = { id: randomBytes(16).toString('hex'), digest: deviceDigest(token),
          name: deviceName(body.name), origin: remoteOrigin, source: session, expiresAt: Date.now() + 300000 };
        res.setHeader('Set-Cookie', `${deviceCookie}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/stream; Max-Age=${TRUST_LIFETIME_MS / 1000}`);
        onChange(); json(202, { status: 'pending' }); return;
      }
      if (req.url === '/stream/remember/status') {
        const token = cookieValue(req), digest = token && deviceDigest(token);
        const pending = enrollmentActive() && enrollment.digest === digest;
        const device = trustedDevices.find(token, remoteOrigin, true);
        json(200, { status: pending ? 'pending' : device ? 'approved' : 'unavailable', paused: trustedDevices.snapshot().paused }); return;
      }
      if (req.url !== '/stream/trusted/connect') { json(404, {}); return; }
      const device = trustedDevices.find(cookieValue(req), remoteOrigin);
      if (!device) { json(403, { error: trustedDevices.snapshot().paused ? 'Remembered access is paused on the host.' : 'Pair this browser again using a new invitation.' }); return; }
      if (trustedConnecting || invitation || session) { json(409, { error: 'The host already has an active connection or invitation. Try again when it is free.' }); return; }
      trustedConnecting = true;
      const mine = accessGeneration;
      try {
        let result;
        try { result = await onTrustedConnect(device); }
        catch (error) {
          if (error.code === 'HOST_BUSY') { json(409, { error: 'The previous session is still closing. Reconnecting shortly.' }); return; }
          throw new Error('The host could not start sharing. Check its capture permissions and connection.');
        }
        if (mine !== accessGeneration || !trustedDevices.allowed(device.id, device.digest)) {
          if (trustedTicket?.id === device.id) cancel();
          throw new Error('Remembered access was paused or revoked.');
        }
        json(201, { key: result.key });
      } finally { trustedConnecting = false; }
    } catch (error) { json(400, { error: error.message }); }
  }
  function status() {
    return { waiting: Boolean(invitation), connected: Boolean(session),
      url: port ? viewerUrl() : null, remote: !['local', 'usb'].includes(mode),
      remoteAvailable: Boolean(remoteOrigin), mode, expiresAt, mediaMode: session?.mediaMode ?? null };
  }
  function cancel() {
    clearTimeout(expiryTimer);
    invitation?.fill(0);
    invitation = null;
    trustedTicket = null; enrollment = null;
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
    // Public per-launch document paths prevent fragment-only reuse of stale
    // receiver scripts. They grant no access; authentication stays in /stream.
    const asset = assets.get(req.url)
      || (/^\/join\/[a-f0-9]{32}$/.test(req.url) ? assets.get('/join') : undefined);
    if (!allowedHost(req.headers.host)) { res.writeHead(403).end(); return; }
    if (['/stream/remember', '/stream/remember/status', '/stream/trusted/connect'].includes(req.url)) { await trustedRequest(req, res); return; }
    if (req.url === '/stream/session' && req.method === 'GET') {
      const resumable = mayResume(req);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ resumable,
        mediaMode: resumable ? session.mediaMode : undefined }));
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
  // SDP answers are bounded separately; native input remains fixed-size.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768, perMessageDeflate: false });
  wss.on('headers', (headers, req) => {
    if (!req.resumeToken) return;
    // Provisional until the one-use code is accepted. Never exposed to JS,
    // query strings, localStorage, sessionStorage, status or diagnostics.
    headers.push(`Set-Cookie: ${cookieName()}=${req.resumeToken.toString('base64url')}; HttpOnly; SameSite=Strict; Path=/stream; Max-Age=${Math.floor(lifetimeMs / 1000)}${req.headers.origin.startsWith('https:') ? '; Secure' : ''}`);
  });
  const upgrade = (req, socket, head) => {
    const resume = mayResume(req);
    const mediaMode = req.url === '/stream/webrtc' && mode !== 'usb' ? 'webrtc' : 'webcodecs';
    if (!['/stream', '/stream/webrtc'].includes(req.url)
        || (resume && mediaMode !== session.mediaMode)
        || !allowedHost(req.headers.host) || !allowedOrigin(req.headers.origin)
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
        if (!accepted || session || (trustedTicket && !trustedDevices.allowed(trustedTicket.id, trustedTicket.digest))) {
          if (++failures >= 10) cancel();
          ws.close(1008, 'Session key rejected or expired.');
          return;
        }
        invitation.fill(0); invitation = null;
        clearTimeout(expiryTimer); expiresAt = null;
        for (const other of sockets) if (other !== ws) other.terminate();
        const deviceId = trustedTicket?.id; trustedTicket = null;
        const token = Buffer.from(req.resumeToken);
        const active = createBrowserSession({ socket: ws, onConnect, resumeMs, lifetimeMs,
          mediaMode, rtcBind, ...inputPolicy, onChange, onClose: () => {
          token.fill(0);
          pendingCleanup = Promise.all([pendingCleanup, active.cleanup]).then(() => {});
          if (session === active) session = null;
          onChange();
        } });
        session = Object.assign(active, { token, origin: req.headers.origin, deviceId,
          rememberProfile: mode === 'internet' && !inputPolicy.viewOnly ? rememberProfile : null });
        onChange();
        await active.start();
      });
    });
  };
  server.on('upgrade', upgrade);

  async function ensureListening(connection) {
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
  }
  async function invite(connection = 'local', policy = {}, grant = null) {
    if (invitation || session) throw new Error('A browser session is already open. Stop it first.');
    await ensureListening(connection);
    if (invitation || session) throw new Error('A browser session is already open. Stop it first.');
    if (grant && !trustedDevices?.allowed(grant.id, grant.digest)) throw new Error('Remembered access was paused or revoked.');
    trustedTicket = grant;
    rememberProfile = policy.rememberProfile || null;
    mode = connection;
    inputPolicy = { keyboard: policy.keyboard === true && policy.viewOnly !== true, viewOnly: policy.viewOnly === true };
    invitation = randomBytes(24);
    failures = 0;
    const duration = grant ? 15000 : invitationMs;
    expiresAt = new Date(Date.now() + duration).toISOString();
    expiryTimer = setTimeout(cancel, duration);
    onChange();
    return { key: invitation.toString('base64url'), ...status() };
  }
  async function shutdown() {
    cancel();
    await pendingCleanup;
    wss.close();
    if (listening) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    if (secureServer) await new Promise((resolve) => { secureServer.close(resolve); secureServer.closeAllConnections(); });
  }
  return { invite, status, cancel, shutdown, trustedStatus, trustAction,
    async standby() { await trustedDevices?.ready; if (remoteOrigin && trustedDevices?.snapshot().devices.length) { await ensureListening('internet'); mode = 'internet'; } },
    get port() { return port; } };
}

export function isPrivateBind(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
    || (a === 100 && b >= 64 && b <= 127);
}
