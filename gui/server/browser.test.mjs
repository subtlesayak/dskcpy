import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createBrowserReceiver, receiverOrigin, isPrivateBind } from './browser.mjs';
import { SrdParser, validBrowserInput, MAX_PACKET } from './browser-protocol.mjs';
import { ack, avcCodec, avcParameters, touchPacket, scrollPacket, takeDecodedTimestamps, fitDisplay, browserJoinUrl } from '../receiver/protocol.mjs';

const header = Buffer.from('535244310000000100000280000001e0', 'hex');
function packet(pts, flags, payload = Buffer.from([1, 2, 3])) {
  const result = Buffer.alloc(16 + payload.length);
  result.writeUInt32BE(payload.length); result.writeBigUInt64BE(BigInt(pts), 4);
  result.writeUInt32BE(flags, 12); payload.copy(result, 16); return result;
}
async function fixture(t, options = {}) {
  let native, calls = 0;
  const receiver = createBrowserReceiver({ configuredPort: 0, onConnect: async (bridge) => {
    calls++;
    native = net.connect(bridge.port, '127.0.0.1');
    native.on('error', () => {});
    await once(native, 'connect');
    native.write(header);
  }, ...options });
  t.after(async () => { native?.destroy(); await receiver.shutdown(); });
  const invitation = await receiver.invite('local', options.inputPolicy);
  const open = async (origin = invitation.url.slice(0, -1), cookie, route = 'stream') => {
    const ws = new WebSocket(invitation.url.replace('http:', 'ws:') + route, { origin, headers: cookie ? { Cookie: cookie } : {} });
    ws.received = [];
    ws.on('upgrade', (response) => { ws.cookie = response.headers['set-cookie']?.[0]; });
    ws.on('message', (data, binary) => ws.received.push({ data, binary }));
    ws.on('error', () => {});
    await once(ws, 'open');
    return ws;
  };
  return { receiver, invitation, open, native: () => native, calls: () => calls };
}

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Expected session transition did not happen');
}
async function login(f) {
  const ws = await f.open(); ws.send(f.invitation.key);
  await until(() => ws.received.some((message) => message.binary));
  return ws;
}
async function resumable(f, cookie, extra = {}) {
  const response = await fetch(f.invitation.url + 'stream/session', { headers: { Cookie: cookie, ...extra } });
  return (await response.json()).resumable;
}

test('receiver origin accepts explicit HTTPS origins, no paths or credentials; direct listeners stay private', () => {
  assert.equal(receiverOrigin(), null);
  assert.equal(receiverOrigin('https://desktop.example.ts.net/'), 'https://desktop.example.ts.net');
  assert.equal(receiverOrigin('https://192.168.1.20:27181'), 'https://192.168.1.20:27181');
  assert.equal(isPrivateBind('192.168.1.20'), true);
  assert.equal(isPrivateBind('0.0.0.0'), false); assert.equal(isPrivateBind('8.8.8.8'), false);
  for (const value of ['http://desktop.example.ts.net', 'https://desktop.example.ts.net/path',
    'https://user@desktop.example.ts.net', 'https://desktop.example.ts.net/?key=secret']) assert.throws(() => receiverOrigin(value));
});

test('legacy QR join page loads without putting credentials in requests', async (t) => {
  const f = await fixture(t);
  const page = await fetch(new URL('/join', f.invitation.url));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.match(html, /src="\/receiver.mjs"/);
  assert.ok(!html.includes(f.invitation.key));
  assert.equal(f.calls(), 0);
  assert.equal(f.receiver.status().waiting, true);
  assert.equal((await fetch(new URL('/join/unexpected', f.invitation.url))).status, 404);
});

test('fresh navigation paths serve the receiver without authorizing access or opening other routes', async (t) => {
  const f = await fixture(t);
  const join = new URL(browserJoinUrl(f.invitation.url, f.invitation.key));
  assert.match(join.pathname, /^\/join\/[a-f0-9]{32}$/);
  const requestUrl = join.origin + join.pathname;
  const page = await fetch(requestUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await page.text(), /src="\/receiver.mjs"/);
  assert.ok(!requestUrl.includes(f.invitation.key));
  assert.equal(f.calls(), 0);
  assert.equal(f.receiver.status().waiting, true);
  assert.equal((await fetch(requestUrl, { method: 'POST' })).status, 404);
  for (const suffix of ['/extra', '?connect=not-a-code', '.mjs']) {
    assert.equal((await fetch(requestUrl + suffix)).status, 404);
  }
  assert.equal((await fetch(join.origin + '/join/' + 'a'.repeat(33))).status, 404);
});

test('SRD parser accepts arbitrarily fragmented media and zero-length unavailable status', () => {
  const frames = [];
  const parser = new SrdParser((data, first) => frames.push([data, first]));
  const bytes = Buffer.concat([header, packet(100, 2), packet(0, 16, Buffer.alloc(0)), packet(101, 8)]);
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  assert.equal(frames.length, 4); assert.deepEqual(frames[0], [header, true]);
  assert.equal(frames[3][0].readBigUInt64BE(4), 101n);
  assert.throws(() => new SrdParser(() => {}).push(Buffer.alloc(16)), /header/);
  const oversized = Buffer.alloc(16); oversized.writeUInt32BE(MAX_PACKET + 1);
  const p = new SrdParser(() => {}); p.push(header); assert.throws(() => p.push(oversized), /packet/);
});

test('browser codec/input helpers preserve native wire layout and reject privileged messages', () => {
  assert.deepEqual(fitDisplay(1920, 1080, 390, 620), { width: 390, height: 219.375 });
  const landscape = fitDisplay(1920, 1080, 820, 300);
  assert.equal(landscape.height, 300); assert.ok(landscape.width < 820);
  assert.deepEqual(fitDisplay(1920, 1080, 0, 300), { width: 0, height: 0 });
  const queuedAudio = [10000, 20000, 30000, 40000];
  assert.deepEqual(takeDecodedTimestamps(queuedAudio, 2), [10000, 20000]);
  assert.deepEqual(takeDecodedTimestamps(queuedAudio, 0), [30000, 40000]);
  assert.deepEqual(queuedAudio, []);
  const inline = new Uint8Array([0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 1, 0x68, 42, 0, 0, 1, 0x65, 1, 2, 3]);
  assert.deepEqual(avcParameters(inline), inline.subarray(0, 12));
  assert.equal(avcCodec(new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0, 0x28, 0])), 'avc1.640028');
  assert.throws(() => avcCodec(new Uint8Array([0, 0, 1, 0x68])), /SPS/);
  const input = Buffer.from(touchPacket(2, 2, -20, 600, 640, 480));
  assert.equal(input.readUInt32BE(10), 0); assert.equal(input.readUInt32BE(14), 479);
  assert.equal(validBrowserInput(input, 640, 480), true);
  assert.equal(validBrowserInput(input, 800, 480), false);
  assert.equal(validBrowserInput(Buffer.from([5, 6]), 640, 480), false);
  assert.equal(validBrowserInput(Buffer.from([5, 5]), 640, 480), false);
  assert.equal(validBrowserInput(Buffer.from([0, 0, 0, 0, 0]), 640, 480), false);
  assert.equal(Buffer.from(ack(4, 1234)).readBigUInt64BE(1), 1234n);
});

test('resume cookie is HttpOnly, host-only, path-scoped and useless until authentication', async (t) => {
  const f = await fixture(t);
  const ws = await f.open();
  assert.match(ws.cookie, /HttpOnly; SameSite=Strict; Path=\/stream; Max-Age=43200/);
  assert.doesNotMatch(ws.cookie, /Domain=|Secure/);
  const cookie = ws.cookie.split(';')[0];
  assert.equal(await resumable(f, cookie), false);
  ws.send(f.invitation.key); await until(() => f.calls() === 1);
  assert.equal(await resumable(f, cookie), true);
  assert.equal(await resumable(f, cookie, { Origin: 'https://evil.example' }), false);
  assert.equal(await resumable(f, cookie, { 'Sec-Fetch-Site': 'cross-site' }), false);
  await assert.rejects(f.open('https://evil.example', cookie), /403/);
  await assert.rejects(f.open(f.invitation.url.slice(0, -1), 'dskcpy_resume=invalid'), /403/);
  assert.ok(!JSON.stringify(f.receiver.status()).includes(cookie.split('=')[1]));
  const ended = once(ws, 'close'); ws.close(4000); await ended;
  await until(() => !f.receiver.status().connected);
  assert.equal(await resumable(f, cookie), false);
  await assert.rejects(f.open(undefined, cookie), /403/);
});

test('authenticated scrolling is forwarded, blocked while suspended and rejected when out of bounds', async (t) => {
  const f = await fixture(t), ws = await login(f), inputs = [];
  f.native().on('data', (chunk) => inputs.push(chunk));
  const scroll = Buffer.from(scrollPacket(120, 90, 640, 480, -20, 40));
  ws.send(scroll); await until(() => Buffer.concat(inputs).includes(scroll));
  inputs.length = 0; ws.send('suspend');
  await until(() => Buffer.concat(inputs).includes(Buffer.from([5, 7])));
  inputs.length = 0; ws.send(scroll);
  // A pong is ordered after the preceding message, avoiding an arbitrary sleep.
  ws.ping(); await once(ws, 'pong');
  assert.equal(Buffer.concat(inputs).includes(scroll), false);
  ws.send('resume'); ws.send(scroll);
  await until(() => Buffer.concat(inputs).includes(scroll));
  const invalid = Buffer.from(scroll); invalid.writeInt32BE(121, 17);
  const closed = once(ws, 'close'); ws.send(invalid); await closed;
  assert.equal(f.receiver.status().connected, false);
});

test('page reload reuses capture, cancels contacts, drains ACKs and replays only codec configuration', async (t) => {
  const f = await fixture(t);
  const ws = await login(f), cookie = ws.cookie.split(';')[0];
  const inputs = []; f.native().on('data', (chunk) => inputs.push(chunk));
  const inline = Buffer.from([0, 0, 1, 0x67, 0x64, 0, 0x28, 0, 0, 1, 0x68, 42, 0, 0, 1, 0x65, 1, 2, 3]);
  f.native().write(packet(42, 2, inline));
  f.native().write(packet(0, 4, Buffer.from('OpusHead')));
  await until(() => ws.received.length === 4);
  ws.send(touchPacket(0, 0, 120, 90, 640, 480));
  await until(() => inputs.length > 0);
  const ended = once(ws, 'close'); ws.close(4001); await ended;
  await until(() => Buffer.concat(inputs).includes(Buffer.from(ack(4, 42))));
  assert.ok(Buffer.concat(inputs).includes(Buffer.from(touchPacket(3, 0, 120, 90, 640, 480))));
  assert.equal(f.receiver.status().connected, true);
  assert.equal(f.native().destroyed, false);
  assert.equal(await resumable(f, cookie), true);
  f.native().write(packet(43, 0)); // Detached media is discarded and acknowledged.
  await until(() => Buffer.concat(inputs).includes(Buffer.from(ack(4, 43))));
  const restored = await f.open(undefined, cookie);
  await until(() => restored.received.length === 4);
  assert.equal(f.calls(), 1);
  assert.deepEqual(restored.received[1].data, header);
  assert.deepEqual(restored.received[2].data, packet(0, 1, inline.subarray(0, 12)));
  assert.equal(restored.received[3].data.readUInt32BE(12), 4);
  restored.send('resume'); restored.send(Buffer.from([5, 8]));
  await until(() => Buffer.concat(inputs).includes(Buffer.from([5, 8])));
  f.native().write(packet(44, 2));
  await until(() => restored.received.length === 5);
  restored.send(ack(4, 44));
  await until(() => Buffer.concat(inputs).includes(Buffer.from(ack(4, 44))));
  const revoked = once(restored, 'close'); restored.send(ack(4, 42)); await revoked;
  assert.equal(f.receiver.status().connected, false); // Old ACKs cannot survive a resume.
});

test('background pause, abrupt loss and replacement socket stay on one bounded native session', async (t) => {
  const f = await fixture(t, { resumeMs: 500 });
  const ws = await login(f), cookie = ws.cookie.split(';')[0];
  const inputs = []; f.native().on('data', (chunk) => inputs.push(chunk));
  ws.send('suspend');
  await until(() => Buffer.concat(inputs).includes(Buffer.from([5, 7])));
  const count = Buffer.concat(inputs).length;
  ws.send(touchPacket(0, 1, 20, 20, 640, 480));
  ws.send('resume'); ws.send(Buffer.from([5, 8]));
  await until(() => Buffer.concat(inputs).length > count);
  assert.equal(Buffer.concat(inputs).length, count + 2); // Hidden touch was not forwarded.
  const replaced = once(ws, 'close');
  const replacement = await f.open(undefined, cookie);
  assert.equal((await replaced)[0], 4002); // Old page must not enter a reconnect loop.
  await until(() => replacement.received.length >= 2);
  assert.equal(f.calls(), 1);
  replacement.send('resume'); replacement.send(Buffer.from([5, 8]));
  replacement.terminate();
  await until(() => replacement.readyState === WebSocket.CLOSED);
  const restored = await f.open(undefined, cookie);
  await until(() => restored.received.length >= 2);
  assert.equal(f.calls(), 1);
  restored.send('suspend');
  await until(() => !f.receiver.status().connected);
  assert.equal(await resumable(f, cookie), false);
});

test('desktop stop, detached viewer stop, expiry and native exit revoke resumption', async (t) => {
  for (const cause of ['desktop', 'viewer', 'expiry', 'lifetime', 'native']) {
    const f = await fixture(t, { resumeMs: 50, lifetimeMs: cause === 'lifetime' ? 50 : 43200000 });
    const ws = await login(f), cookie = ws.cookie.split(';')[0];
    if (cause === 'desktop') f.receiver.cancel();
    if (cause === 'native') f.native().destroy();
    if (cause === 'expiry' || cause === 'viewer') {
      const ended = once(ws, 'close'); ws.close(4001); await ended;
    }
    if (cause === 'viewer') {
      const denied = await fetch(f.invitation.url + 'stream/session', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } });
      assert.equal(denied.status, 403);
      const stopped = await fetch(f.invitation.url + 'stream/session', { method: 'POST', headers: { Cookie: cookie, Origin: f.invitation.url.slice(0, -1) } });
      assert.equal(stopped.status, 204);
    }
    await until(() => !f.receiver.status().connected);
    assert.equal(await resumable(f, cookie), false);
    await assert.rejects(f.open(undefined, cookie), /403/);
  }
});

test('receiver serves only fixed assets, rejects Host rebinding, no control routes or key in URL', async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.invitation.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  assert.match(html, /<label for="session-key">Connection code<\/label>/);
  assert.match(html, /Create link and code/);
  assert.match(html, /prepared Android USB connection/);
  const videoModule = await fetch(f.invitation.url + 'video.mjs');
  assert.equal(videoModule.status, 200);
  assert.match(videoModule.headers.get('content-type'), /javascript/);
  assert.match(await videoModule.text(), /export function createVideoReceiver/);
  for (const route of ['api/status', 'api/stream/start', 'receiver.mjs?key=anything', '../server/service.mjs']) {
    assert.equal((await fetch(f.invitation.url + route)).status, 404);
  }
  const code = await new Promise((resolve) => {
    http.get(f.invitation.url, { headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(code, 403);
  assert.equal(f.calls(), 0);
  assert.ok(!JSON.stringify(f.receiver.status()).includes(f.invitation.key));
});

test('wrong key and cross-origin socket cannot start native capture', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.open('https://evil.example'), /403/);
  const ws = await f.open();
  const ended = once(ws, 'close'); ws.send('x'.repeat(32)); await ended;
  assert.equal(f.calls(), 0);
  assert.equal(f.receiver.status().waiting, true);
});

test('authenticated receiver forwards media, accepts real ACK only, consumes key once and cleans up', async (t) => {
  const f = await fixture(t);
  const ws = await f.open();
  const received = [];
  let resolveHeader;
  const firstHeader = new Promise((resolve) => { resolveHeader = resolve; });
  ws.on('message', (data, binary) => { received.push(data); if (binary) resolveHeader(); });
  ws.send(f.invitation.key); await firstHeader;
  assert.deepEqual(received[1], header); assert.equal(f.calls(), 1);
  assert.equal(f.receiver.status().waiting, false);
  await assert.rejects(f.open(), /403/);
  const media = once(ws, 'message'); f.native().write(packet(42, 2)); await media;
  const input = once(f.native(), 'data'); ws.send(ack(4, 42));
  assert.deepEqual((await input)[0], Buffer.from(ack(4, 42)));
  const ended = once(ws, 'close'); ws.send(ack(4, 9999)); await ended;
  assert.equal(f.receiver.status().connected, false);
});

test('invitation expiration, idle authentication and cancel leave no reusable credential', async (t) => {
  const f = await fixture(t, { invitationMs: 150, authMs: 20 });
  const ws = await f.open(); await once(ws, 'close');
  assert.equal(f.calls(), 0);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(f.receiver.status().waiting, false);
  await assert.rejects(f.open(), /403/);
  await f.receiver.invite(); f.receiver.cancel();
  assert.equal(f.receiver.status().waiting, false);
});

test('Wi-Fi, direct IP and VPN use the configured HTTPS receiver without exposing the controller', async (t) => {
  for (const mode of ['wifi', 'ip', 'internet']) {
    const receiver = createBrowserReceiver({ configuredPort: 0, origin: 'https://desktop.example.ts.net' });
    t.after(() => receiver.shutdown());
    const invitation = await receiver.invite(mode);
    assert.equal(invitation.url, 'https://desktop.example.ts.net/');
    assert.equal(invitation.mode, mode); assert.equal(invitation.remote, true);
    assert.ok(receiver.port > 0); receiver.cancel();
  }
});

test('direct TLS validates its certificate and carries authenticated WSS without public binding', async (t) => {
  // Test-only issuer, generated at runtime and never installed or committed.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-tls-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cert = path.join(directory, 'cert.pem'), key = path.join(directory, 'key.pem');
  const config = path.join(directory, 'openssl.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=CA:TRUE\n');
  execFileSync(process.env.OPENSSL || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
    '-config', config, '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: ['ignore', 'ignore', 'pipe'] });
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  let bridge;
  const receiver = createBrowserReceiver({ configuredPort: 0, origin: `https://127.0.0.1:${port}`,
    tls: { cert, key, bind: '127.0.0.1', port }, onConnect: (value) => { bridge = value; } });
  t.after(() => receiver.shutdown());
  const invitation = await receiver.invite('ip');
  const ca = await readFile(cert);
  const result = await new Promise((resolve, reject) => {
    https.get(invitation.url, { ca }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(result, 200);
  const ws = new WebSocket(invitation.url.replace('https:', 'wss:') + 'stream', { origin: invitation.url.slice(0, -1), ca });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  await once(ws, 'open'); const accepted = once(ws, 'message'); ws.send(invitation.key); await accepted;
  assert.ok(bridge.port > 0); assert.equal(receiver.status().connected, true);
  const ended = once(ws, 'close'); ws.close(); await ended;
  for (let i = 0; i < 100 && receiver.status().connected; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(receiver.status().connected, false);
});

test('WebRTC signaling requires the one-use code and retains authenticated input isolation', async (t) => {
  const f = await fixture(t);
  const ws = await f.open(undefined, undefined, 'stream/webrtc');
  assert.equal(f.calls(), 0);
  assert.equal(ws.received.length, 0);
  ws.send(f.invitation.key);
  await until(() => ws.received.some((entry) => entry.binary));
  assert.equal(f.calls(), 1);
  const authenticated = ws.received.filter((entry) => !entry.binary).map((entry) => JSON.parse(entry.data.toString()));
  assert.equal(authenticated[0].mediaMode, 'webrtc');
  f.native().write(packet(0, 1, Buffer.from('000000016742c01e0102030000000168ce3c80', 'hex')));
  await until(() => ws.received.some((entry) => !entry.binary && JSON.parse(entry.data.toString()).type === 'rtc-offer'));
  assert.equal(f.receiver.status().mediaMode, 'webrtc');
  const input = Buffer.from(touchPacket(0, 0, 20, 30, 640, 480));
  const received = [];
  f.native().on('data', (chunk) => received.push(chunk));
  ws.send(input);
  await until(() => Buffer.concat(received).includes(input));
  // Neither arbitrary JSON commands nor forged video acknowledgements are input.
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'rtc-answer', description: { type: 'offer', sdp: 'invalid' } }));
  await closed;
  assert.equal(f.receiver.status().connected, false);
});

test('keyboard capability is authenticated, native input is forwarded, and detach releases held keys', async (t) => {
  const f = await fixture(t, { inputPolicy: { keyboard: true } });
  const ws = await login(f), commands = [];
  f.native().on('data', (data) => commands.push(data));
  const announcement = ws.received.filter((m) => !m.binary).map((m) => JSON.parse(m.data)).find((m) => m.type === 'authenticated');
  assert.equal(announcement.keyboard, true); assert.equal(announcement.viewOnly, false);
  ws.send(Buffer.from([8,0,0,4,8]));
  ws.send(Buffer.from([9,0,2,0xc3,0xa9]));
  await until(() => Buffer.concat(commands).includes(Buffer.from([9,0,2,0xc3,0xa9])));
  assert.ok(Buffer.concat(commands).includes(Buffer.from([8,0,0,4,8])));
  ws.terminate();
  await until(() => Buffer.concat(commands).includes(Buffer.from([8,2,0,0,0])));
});

for (const input of [Buffer.from([8,0,0,4,0]), Buffer.from(touchPacket(0, 1, 20, 20, 640, 480)), Buffer.from([5,10])]) {
  test(`window view-only boundary rejects input type ${input[0]} including forged client messages`, async (t) => {
    const f = await fixture(t, { inputPolicy: { viewOnly: true, keyboard: true } });
    const ws = await login(f);
    const message = ws.received.filter((m) => !m.binary).map((m) => JSON.parse(m.data)).find((m) => m.type === 'authenticated');
    assert.equal(message.viewOnly, true); assert.equal(message.keyboard, false);
    const closed = once(ws, 'close'); ws.send(input); await closed;
    assert.equal(f.receiver.status().connected, false);
  });
}


test('default host arms five-minute recovery; expiration revokes resumption', async (t) => {
  const f = await fixture(t);
  const ws = await login(f), cookie = ws.cookie.split(';')[0];
  const original = globalThis.setTimeout; let expire, duration;
  // Observe only this session's grace timer; keep I/O and WebSocket close
  // timers real so the test cannot strand a socket during fake-clock cleanup.
  const timerMock = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 300000) { expire = fn; duration = ms; }
    return original(fn, ms, ...args);
  });
  const paused = once(f.native(), 'data'); ws.send('suspend'); await paused;
  timerMock.mock.restore();
  assert.equal(duration, 300000); assert.equal(typeof expire, 'function');
  assert.equal(f.receiver.status().connected, true);
  assert.equal(await resumable(f, cookie), true);
  const ended = once(ws, 'close'); expire(); await ended;
  assert.equal(f.receiver.status().connected, false);
  assert.equal(await resumable(f, cookie), false);
});
