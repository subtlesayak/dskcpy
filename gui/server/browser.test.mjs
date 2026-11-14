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
import { ack, avcCodec, avcParameters, touchPacket, scrollPacket, takeDecodedTimestamps, fitDisplay, browserJoinUrl, MEDIA_FALLBACK_PROTOCOL } from '../receiver/protocol.mjs';

const header = Buffer.from('535244310000000100000280000001e0', 'hex');
function packet(pts, flags, payload = Buffer.from([1, 2, 3])) {
  const result = Buffer.alloc(16 + payload.length);
  result.writeUInt32BE(payload.length); result.writeBigUInt64BE(BigInt(pts), 4);
  result.writeUInt32BE(flags, 12); payload.copy(result, 16); return result;
}
async function fixture(t, options = {}) {
  let native, bridgeState, calls = 0;
  const receiver = createBrowserReceiver({ configuredPort: 0, onConnect: async (bridge) => {
    calls++; bridgeState=bridge;
    native = net.connect(bridge.port, '127.0.0.1');
    native.on('error', () => {});
    await once(native, 'connect');
    native.write(options.headers?.[calls-1] || header);
  }, ...options });
  t.after(async () => { native?.destroy(); await receiver.shutdown(); });
  const invitation = await receiver.invite('local', options.inputPolicy);
  const open = async (origin = invitation.url.slice(0, -1), cookie, route = 'stream', protocol) => {
    const ws = new WebSocket(invitation.url.replace('http:', 'ws:') + route, protocol ? [protocol] : [], { origin, headers: cookie ? { Cookie: cookie } : {} });
    ws.received = [];
    ws.on('upgrade', (response) => { ws.cookie = response.headers['set-cookie']?.[0]; });
    ws.on('message', (data, binary) => ws.received.push({ data, binary }));
    ws.on('error', () => {});
    await once(ws, 'open');
    return ws;
  };
  return { receiver, invitation, open, native: () => native, bridge:()=>bridgeState, calls: () => calls };
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

test('native capture recovery preserves authorization, clears old media and adopts fresh geometry', async t => {
  const nextHeader=Buffer.from(header);nextHeader.writeUInt32BE(1280,8);nextHeader.writeUInt32BE(720,12);
  const f=await fixture(t,{inputPolicy:{keyboard:true,captureRecovery:true},headers:[header,nextHeader]});
  const first=await login(f),cookie=first.cookie.split(';')[0],original=f.native(),bridge=f.bridge();
  const received=[];original.on('data',chunk=>received.push(chunk));
  first.send(touchPacket(0,0,10,10,640,480));first.send(Buffer.from([8,0,0,224,1]));
  await until(()=>Buffer.concat(received).includes(Buffer.from([8,0,0,224,1])));
  const stopped=once(first,'close');
  await bridge.restartNative();await stopped;
  assert.equal(f.calls(),2);assert.equal(await resumable(f,cookie),true);
  await until(()=>!f.receiver.status().recovering);
  await until(()=>Buffer.concat(received).includes(Buffer.from([8,2,0,0,0])));
  const second=await f.open(undefined,cookie);
  await until(()=>second.received.some(m=>m.binary));
  const binary=second.received.filter(m=>m.binary);
  assert.deepEqual(binary[0].data,nextHeader);
  assert.equal(binary.length,1); // No old codec, frame or audio replay.
  second.send('resume');
  second.send(Buffer.from([5,8]));
  const nextInput=[];f.native().on('data',chunk=>nextInput.push(chunk));
  second.send(touchPacket(0,0,1200,700,1280,720));
  await until(()=>Buffer.concat(nextInput).includes(Buffer.from(touchPacket(0,0,1200,700,1280,720))));
  second.close(4000);
});

test('native transport loss holds only a bounded owner-classification grace; it does not itself start capture', async t=>{
  const f=await fixture(t,{inputPolicy:{captureRecovery:true},nativeEndGraceMs:40});
  const ws=await login(f),cookie=ws.cookie.split(';')[0];
  const ended=once(ws,'close');f.native().destroy();
  await until(()=>f.receiver.status().recovering);
  assert.equal(await resumable(f,cookie),true);
  const [code]=await ended;assert.equal(code,1008);assert.equal(f.calls(),1);
  assert.equal(await resumable(f,cookie),false);assert.equal(f.calls(),1);
});

test('capture recovery budget and cancellation never create an unbounded or unauthorized restart', async t=>{
  const f=await fixture(t,{inputPolicy:{captureRecovery:true}});
  const ws=await login(f),cookie=ws.cookie.split(';')[0];
  for(let i=0;i<3;i++){assert.equal(await f.bridge().restartNative(),true);await until(()=>!f.receiver.status().recovering);}
  assert.equal(await f.bridge().restartNative(),false);assert.equal(f.calls(),4);
  assert.equal(await resumable(f,cookie),false);
  const other=await fixture(t,{inputPolicy:{captureRecovery:true}});await login(other);
  const stale=other.bridge();other.receiver.cancel();
  assert.equal(await stale.restartNative(),false);assert.equal(other.calls(),1);
});

test('WebRTC keyframe feedback cannot undo an explicit video pause',async t=>{
 let feedback;
 const f=await fixture(t,{rtcMediaFactory:options=>{
  feedback=options.onKeyframe;
  return {offer:async()=>({type:'offer',sdp:'synthetic'}),answer:async()=>{},close:async()=>{},frame:async()=>{},sound:async()=>{}};
 }});
 const ws=await f.open(undefined,undefined,'stream/webrtc');ws.send(f.invitation.key);
 await until(()=>f.calls()===1);
 f.native().write(packet(0,1,Buffer.from('000000016742c01e0102030000000168ce3c80','hex')));
 await until(()=>feedback);
 const chunks=[];f.native().on('data',chunk=>chunks.push(chunk));
 ws.send(Buffer.from([5,7]));await until(()=>Buffer.concat(chunks).includes(Buffer.from([5,7])));
 let before=Buffer.concat(chunks).length;feedback();ws.ping();await once(ws,'pong');
 assert.equal(Buffer.concat(chunks).length,before);
 ws.send(Buffer.from([5,8]));await until(()=>Buffer.concat(chunks).length>before);
 before=Buffer.concat(chunks).length;feedback();await until(()=>Buffer.concat(chunks).length>before);
 ws.close(4000);
});

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
  const shortcutModule = await fetch(f.invitation.url + 'shortcuts.mjs');
  assert.equal(shortcutModule.status, 200);
  assert.match(await shortcutModule.text(), /export function createKeyboardShortcuts/);
  const viewModule = await fetch(f.invitation.url + 'view.mjs');
  assert.equal(viewModule.status, 200);
  assert.match(viewModule.headers.get('content-type'), /javascript/);
  assert.match(await viewModule.text(), /export function createDesktopView/);
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


test('older cached viewers stay connected without optional focus messages', async t => {
  const f = await fixture(t, { inputPolicy: { keyboard: true, textFocus: true } });
  const ws = await login(f);
  f.bridge().focusHint(true);
  f.native().write(packet(101, 0));
  await until(() => ws.received.some(m => m.binary && m.data.length > 16 && m.data.readBigUInt64BE(4) === 101n));
  assert.equal(ws.received.some(m => !m.binary && JSON.parse(m.data).type === 'text-focus'), false);
  assert.equal(ws.readyState, WebSocket.OPEN);
});

test('text focus is bounded advisory metadata on an authenticated capable session',async t=>{
  const f=await fixture(t,{inputPolicy:{keyboard:true,textFocus:true}});const ws=await login(f);
  const subscribed = once(f.native(), 'data');
  ws.send('text-focus-subscribe'); ws.send(Buffer.from([8,2,0,0,0])); await subscribed;
  assert.equal(f.bridge().textFocus,true);f.bridge().focusHint(true);
  await until(()=>ws.received.some(m=>!m.binary&&m.data.toString().includes('text-focus')));
  const hints=()=>ws.received.filter(m=>!m.binary&&m.data.toString().includes('text-focus'));
  assert.deepEqual(JSON.parse(hints()[0].data.toString()),{type:'text-focus',focused:true});
  f.bridge().focusHint('private text');await new Promise(setImmediate);assert.equal(hints().length,1);
  const paused=once(f.native(),'data');ws.send('suspend');await paused;
  f.bridge().focusHint(false);await new Promise(setImmediate);assert.equal(hints().length,1);
});

test('focus subscriptions belong to the current socket, not a resumed session', async t => {
  const f = await fixture(t, { inputPolicy: { keyboard: true, textFocus: true } });
  const first = await login(f);
  const cookie = first.cookie.split(';')[0];
  let barrier = once(f.native(), 'data');
  first.send('text-focus-subscribe'); first.send(Buffer.from([8,2,0,0,0])); await barrier;
  f.bridge().focusHint(true);
  await until(() => first.received.some(m => !m.binary && JSON.parse(m.data).type === 'text-focus'));
  barrier = once(f.native(), 'data'); first.terminate(); await barrier;
  const second = await f.open(undefined, cookie);
  await until(() => second.received.some(m => m.binary));
  barrier = once(f.native(), 'data'); second.send('resume'); second.send(Buffer.from([8,2,0,0,0])); await barrier;
  f.bridge().focusHint(false); f.native().write(packet(102, 0));
  await until(() => second.received.some(m => m.binary && m.data.length > 16 && m.data.readBigUInt64BE(4) === 102n));
  assert.equal(second.received.some(m => !m.binary && JSON.parse(m.data).type === 'text-focus'), false);
  barrier = once(f.native(), 'data'); second.send('text-focus-subscribe'); second.send(Buffer.from([8,2,0,0,0])); await barrier;
  f.bridge().focusHint(true);
  await until(() => second.received.some(m => !m.binary && JSON.parse(m.data).type === 'text-focus'));
  assert.equal(f.calls(), 1);
});

test('focus subscription cannot enable a capability the host did not advertise', async t => {
  const f = await fixture(t, { inputPolicy: { keyboard: true } });
  const ws = await login(f), ended = once(ws, 'close');
  ws.send('text-focus-subscribe'); await ended;
  assert.equal(f.receiver.status().connected, false);
});

for(const policy of [{keyboard:false,textFocus:true},{keyboard:true,textFocus:true,viewOnly:true},{keyboard:true}]){
 test(`focus hints require full-desktop negotiated capability ${JSON.stringify(policy)}`,async t=>{
  const f=await fixture(t,{inputPolicy:policy});const ws=await login(f);
  assert.equal(f.bridge().textFocus,false);f.bridge().focusHint(true);await new Promise(setImmediate);
  assert.equal(ws.received.some(m=>!m.binary&&m.data.toString().includes('text-focus')),false);
 });
}

test('keyboard status requires this socket subscription and never disconnects an older viewer',async t=>{
  const f=await fixture(t,{inputPolicy:{keyboard:true}});const ws=await login(f);const cookie=ws.cookie.split(';')[0];
  const statuses=socket=>socket.received.filter(m=>!m.binary&&JSON.parse(m.data.toString()).type==='keyboard-status');
  f.bridge().keyboardStatus('blocked');await new Promise(setImmediate);
  assert.equal(statuses(ws).length,0);assert.equal(ws.readyState,WebSocket.OPEN);
  ws.send('keyboard-status-subscribe');await until(()=>statuses(ws).length===1);
  assert.deepEqual(JSON.parse(statuses(ws)[0].data.toString()),{type:'keyboard-status',status:'blocked'});
  f.bridge().keyboardStatus('not-a-status');await new Promise(setImmediate);assert.equal(statuses(ws).length,1);
  const next=await f.open(undefined,cookie);await until(()=>next.received.length>=2);next.send('resume');
  await new Promise(setImmediate);f.bridge().keyboardStatus('ready');await new Promise(setImmediate);
  assert.equal(statuses(next).length,0);assert.equal(f.calls(),1);
  next.send('keyboard-status-subscribe');await until(()=>statuses(next).length===1);
  assert.equal(JSON.parse(statuses(next)[0].data.toString()).status,'ready');
});
for(const policy of [{keyboard:false},{keyboard:true,viewOnly:true}]){
 test(`unsupported keyboard-status subscription remains rejected ${JSON.stringify(policy)}`,async t=>{
  const f=await fixture(t,{inputPolicy:policy});const ws=await login(f);const ended=once(ws,'close');
  ws.send('keyboard-status-subscribe');await ended;assert.equal(f.receiver.status().connected,false);
 });
}

test('clipboard is current-viewer opt-in and native metadata is never forwarded as a media frame or status', async t => {
  const {clipboardRequest}=await import('../receiver/clipboard.mjs');
  const f=await fixture(t,{inputPolicy:{keyboard:true,clipboard:true}}),ws=await login(f),received=[];
  f.native().on('data',chunk=>received.push(chunk));
  assert.equal(JSON.parse(ws.received.find(x=>!x.binary).data).clipboard,true);
  // A native unsolicited payload cannot disclose text to an unnegotiated page.
  const payload=(id,text)=>{const b=Buffer.from(text),p=Buffer.alloc(8+b.length);p.writeUInt32BE(id,2);p.writeUInt16BE(b.length,6);b.copy(p,8);return p;};
  f.native().write(packet(0,32,payload(77,'unsolicited fixture')));
  await new Promise(r=>setTimeout(r,15));assert.ok(!ws.received.some(x=>x.data.includes('unsolicited fixture')));
  ws.send('clipboard-enable');ws.send(clipboardRequest(0,13));
  await until(()=>Buffer.concat(received).includes(Buffer.from(clipboardRequest(0,1))));
  f.native().write(packet(0,32,payload(1,'PRIVATE_FIXTURE_ONLY')));
  await until(()=>ws.received.some(x=>!x.binary&&x.data.includes('clipboard-result')));
  const result=JSON.parse(ws.received.find(x=>!x.binary&&x.data.includes('clipboard-result')).data);
  assert.deepEqual(result,{type:'clipboard-result',op:0,id:13,status:0,text:'PRIVATE_FIXTURE_ONLY'});
  assert.ok(!JSON.stringify(f.receiver.status()).includes('PRIVATE_FIXTURE_ONLY'));
  assert.equal(ws.received.filter(x=>x.binary).length,1,'only the stream header is a media message');
  ws.send('clipboard-disable');const before=received.length;ws.send(clipboardRequest(0,14));await once(ws,'close');
  assert.ok(!Buffer.concat(received.slice(before)).includes(Buffer.from(clipboardRequest(0,2))));
});
for (const policy of [{keyboard:true},{keyboard:true,clipboard:true,viewOnly:true},{clipboard:true}]) test('clipboard cannot elevate host policy '+JSON.stringify(policy),async t=>{
  const f=await fixture(t,{inputPolicy:policy}),ws=await login(f);assert.equal(JSON.parse(ws.received.find(x=>!x.binary).data).clipboard,false);
  ws.send('clipboard-enable');const [code]=await once(ws,'close');assert.equal(code,1008);
});

test('a remembered grant cannot carry clipboard permission even if an internal caller supplies it',async t=>{
  let native;const receiver=createBrowserReceiver({configuredPort:0,trustedDevices:{allowed:()=>true,snapshot:()=>({available:false,paused:false,devices:[]})},onConnect:async bridge=>{
    assert.equal(bridge.clipboard,false);native=net.connect(bridge.port,'127.0.0.1');native.on('error',()=>{});await once(native,'connect');native.write(header);
  }});t.after(async()=>{native?.destroy();await receiver.shutdown();});
  const grant={id:'fixture',digest:'fixture',origin:''},invitation=await receiver.invite('local',{keyboard:true,clipboard:true},grant);grant.origin=invitation.url.slice(0,-1);
  const ws=new WebSocket(invitation.url.replace('http:','ws:')+'stream',{origin:grant.origin});ws.on('error',()=>{});t.after(()=>ws.terminate());await once(ws,'open');
  const first=once(ws,'message');ws.send(invitation.key);const [bytes,binary]=await first;assert.equal(binary,false);assert.equal(JSON.parse(bytes).clipboard,false);
});

test('native keyboard denial cancels clipboard and suppresses its queued private result',async t=>{
  const {clipboardRequest}=await import('../receiver/clipboard.mjs');
  const f=await fixture(t,{inputPolicy:{keyboard:true,clipboard:true}}),ws=await login(f),input=[];f.native().on('data',b=>input.push(b));
  ws.send('keyboard-status-subscribe');ws.send('clipboard-enable');ws.send(clipboardRequest(0,1));
  await until(()=>Buffer.concat(input).includes(Buffer.from(clipboardRequest(0,1))));f.bridge().keyboardStatus('blocked');
  await until(()=>Buffer.concat(input).includes(Buffer.from([10,3,0,0,0,0,0,0])));
  const bytes=Buffer.from('not delivered'),p=Buffer.alloc(8+bytes.length);p.writeUInt32BE(1,2);p.writeUInt16BE(bytes.length,6);bytes.copy(p,8);f.native().write(packet(0,32,p));
  await new Promise(r=>setTimeout(r,15));assert.ok(!ws.received.some(m=>!m.binary&&m.data.includes('clipboard-result')));assert.equal(ws.readyState,WebSocket.OPEN);
});

test('owned receiver health preparation grants no session and exposes only a fresh launch marker', async t => {
  let starts = 0;
  const receiver = createBrowserReceiver({ configuredPort: 0, origin: 'https://owned.test.ts.net:8443', onConnect: async () => { starts++; } });
  t.after(() => receiver.shutdown());
  const descriptor = await receiver.prepare();
  assert.equal(descriptor.url, 'https://owned.test.ts.net:8443/'); assert.match(descriptor.instance, /^[a-f0-9]{32}$/);
  const local = `http://127.0.0.1:${receiver.port}`;
  const response = await fetch(local + '/health'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { service: 'dskcpy-browser-receiver', instance: descriptor.instance });
  assert.equal(receiver.status().waiting, false); assert.equal(receiver.status().connected, false); assert.equal(starts, 0);
  assert.ok(!JSON.stringify(receiver.status()).includes(descriptor.instance));
  assert.equal((await fetch(local + '/health', { method: 'POST' })).status, 404);
  assert.equal((await fetch(local + '/health?key=unrelated')).status, 404);
  assert.equal(await new Promise((resolve, reject) => { const req = http.get(local + '/health', { headers: { Host: 'unrelated.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); }), 403);
  assert.deepEqual(await (await fetch(local + '/stream/session')).json(), { resumable: false });
  await receiver.invite('local'); await assert.rejects(receiver.prepare(), /already open/); assert.equal(starts, 0);
});

const fallbackParameters = Buffer.from('000000016742c01e0102030000000168ce3c80', 'hex');
const fakeRtc = () => ({ offer: async () => ({ type: 'offer', sdp: 'owned-fake-offer' }), answer: async () => {},
  frame: async () => {}, sound: async () => {}, close: async () => {} });
async function rtcLogin(f, protocol = MEDIA_FALLBACK_PROTOCOL) {
  const ws = await f.open(undefined, undefined, 'stream/webrtc', protocol); ws.send(f.invitation.key);
  await until(() => ws.received.some(m => m.binary));
  return ws;
}
const authentication = ws => ws.received.filter(m => !m.binary).map(m => JSON.parse(m.data.toString())).find(m => m.type === 'authenticated');

test('negotiated media recovery retains authorization and capture, drains RTC and isolates stale work', async t => {
  let rejectFrame, rejectAnswer, rejectSound;
  const f = await fixture(t, { inputPolicy: { keyboard: true }, rtcMediaFactory: () => ({ ...fakeRtc(),
    frame: () => new Promise((resolve, reject) => { rejectFrame = reject; }),
    answer: () => new Promise((resolve, reject) => { rejectAnswer = reject; }),
    sound: () => new Promise((resolve, reject) => { rejectSound = reject; }),
  }) });
  const first = await rtcLogin(f), cookie = first.cookie.split(';')[0], native = f.native(), chunks = [];
  native.on('data', c => chunks.push(c));
  assert.equal(authentication(first).mediaFallback, true);
  native.write(packet(0, 1, fallbackParameters));
  await until(() => first.received.some(m => !m.binary && JSON.parse(m.data.toString()).type === 'rtc-offer'));
  first.send('resume'); first.send(Buffer.from([5, 8]));
  const down = Buffer.from(touchPacket(0, 0, 20, 30, 640, 480));
  first.send(down); first.send(Buffer.from([8, 0, 0, 224, 1]));
  first.send(JSON.stringify({ type: 'rtc-answer', description: { type: 'answer', sdp: 'owned' } }));
  native.write(packet(100, 2)); native.write(packet(101, 8));
  await until(() => rejectFrame && rejectAnswer && rejectSound && Buffer.concat(chunks).includes(down));
  const ended = once(first, 'close'); first.send('media-fallback');
  const [code, reason] = await ended; assert.equal(code, 1012); assert.equal(reason.toString(), 'media-fallback');
  assert.ok(first.received.some(m => !m.binary && JSON.parse(m.data.toString()).type === 'media-fallback' && JSON.parse(m.data.toString()).mediaMode === 'webcodecs'));
  await until(() => Buffer.concat(chunks).includes(Buffer.from([8, 2, 0, 0, 0])));
  assert.ok(Buffer.concat(chunks).includes(Buffer.from(touchPacket(3, 0, 20, 30, 640, 480))));
  assert.ok(Buffer.concat(chunks).includes(ack(4, 100))); assert.ok(Buffer.concat(chunks).includes(ack(6, 101)));
  assert.equal(f.receiver.status().mediaMode, 'webcodecs'); assert.equal(f.calls(), 1); assert.equal(f.native(), native);
  assert.equal(await resumable(f, cookie), true); assert.equal(await resumable(f, 'invalid'), false);
  await assert.rejects(f.open('https://other.test', cookie));
  await assert.rejects(f.open(undefined, cookie, 'stream/webrtc', MEDIA_FALLBACK_PROTOCOL));
  const second = await f.open(undefined, cookie);
  await until(() => second.received.filter(m => m.binary).length >= 2);
  assert.equal(authentication(second).keyboard, true); assert.equal(authentication(second).viewOnly, false);
  assert.equal(authentication(second).mediaFallback, false);
  assert.deepEqual(second.received.filter(m => m.binary)[0].data, header);
  second.send('resume'); second.send(Buffer.from([5, 8])); second.send(Buffer.from([5, 11]));
  rejectFrame(Error('old frame')); rejectAnswer(Error('old answer')); rejectSound(Error('old audio'));
  await new Promise(r => setTimeout(r, 20)); assert.equal(second.readyState, WebSocket.OPEN);
  native.write(packet(200, 2));
  await until(() => second.received.some(m => m.binary && m.data.length > 16 && m.data.readBigUInt64BE(4) === 200n));
  second.send(ack(4, 200)); await until(() => Buffer.concat(chunks).includes(ack(4, 200)));
  assert.equal(f.calls(), 1); second.close(4000);
});

test('RTC startup or transport failure can recover only for the negotiated viewer', async t => {
  for (const stage of ['constructor', 'offer', 'transport']) for (const negotiated of [false, true]) {
    let failure;
    const f = await fixture(t, { rtcMediaFactory: options => {
      failure = options.onFailure;
      if (stage === 'constructor') throw Error('owned constructor failure');
      return { ...fakeRtc(), offer: async () => { if (stage === 'offer') throw Error('owned fixture failure'); return { type: 'offer', sdp: 'owned' }; } };
    } });
    const ws = await rtcLogin(f, negotiated ? MEDIA_FALLBACK_PROTOCOL : '');
    // rtcLogin's default negotiates: an explicit legacy token selects no capability.
    if (!negotiated) assert.notEqual(ws.protocol, MEDIA_FALLBACK_PROTOCOL);
    const cookie = ws.cookie.split(';')[0], ended = once(ws, 'close');
    f.native().write(packet(0, 1, fallbackParameters)); await until(() => failure);
    if (stage === 'transport') failure();
    const [code] = await ended; assert.equal(code, negotiated ? 1012 : 1008);
    assert.equal(await resumable(f, cookie), negotiated); assert.equal(f.calls(), 1);
  }
});

test('a view-only viewer may recover media without acquiring keyboard, pointer or clipboard rights', async t => {
  const f = await fixture(t, { inputPolicy: { viewOnly: true, keyboard: true, clipboard: true }, rtcMediaFactory: fakeRtc });
  const first = await rtcLogin(f), cookie = first.cookie.split(';')[0];
  const ended = once(first, 'close'); first.send('media-fallback'); await ended;
  const second = await f.open(undefined, cookie); await until(() => second.received.some(m => m.binary));
  const policy = authentication(second); assert.equal(policy.viewOnly, true); assert.equal(policy.clipboard, false);
  const chunks = []; f.native().on('data', c => chunks.push(c));
  second.send('resume'); second.send(Buffer.from([5, 8]));
  const input = Buffer.from(touchPacket(0, 0, 20, 30, 640, 480)), closed = once(second, 'close'); second.send(input);
  assert.equal((await closed)[0], 1008); assert.equal(Buffer.concat(chunks).includes(input), false); assert.equal(f.calls(), 1);
});

test('media recovery cannot be requested without negotiation or repeated after downgrade', async t => {
  for (const protocol of [undefined, 'unrelated.test.protocol']) {
    const f = await fixture(t, { rtcMediaFactory: fakeRtc });
    const ws = await f.open(undefined, undefined, 'stream/webrtc', protocol); ws.send(f.invitation.key);
    await until(() => ws.received.some(m => m.binary)); assert.equal(authentication(ws).mediaFallback, false);
    const cookie = ws.cookie.split(';')[0], ended = once(ws, 'close'); ws.send('media-fallback');
    assert.equal((await ended)[0], 1008); assert.equal(await resumable(f, cookie), false);
  }
  const f = await fixture(t, { rtcMediaFactory: fakeRtc }); const first = await rtcLogin(f), cookie = first.cookie.split(';')[0];
  const ended = once(first, 'close'); first.send('media-fallback'); await ended;
  const second = await f.open(undefined, cookie, 'stream', MEDIA_FALLBACK_PROTOCOL); await until(() => second.received.some(m => m.binary));
  const repeated = once(second, 'close'); second.send('media-fallback');
  assert.equal((await repeated)[0], 1008); assert.equal(await resumable(f, cookie), false); assert.equal(f.calls(), 1);
});


test('media recovery cannot reset the original session lifetime', { timeout: 6000 }, async t => {
  const f = await fixture(t, { lifetimeMs: 3000, rtcMediaFactory: fakeRtc });
  const started = Date.now(), first = await rtcLogin(f), cookie = first.cookie.split(';')[0];
  f.native().write(packet(0, 1, fallbackParameters));
  await new Promise(r => setTimeout(r, 1800));
  const retired = once(first, 'close'); first.send('media-fallback'); await retired;
  const second = await f.open(undefined, cookie); await until(() => second.received.some(m => m.binary));
  const expired = once(second, 'close'); assert.equal((await expired)[0], 1008);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 2500 && elapsed < 4300, 'expiry stays on the original three-second grant, not a new grant after recovery');
  assert.equal(await resumable(f, cookie), false); assert.equal(f.calls(), 1);
});

test('viewer Disconnect revokes the retained capture during media handoff', async t => {
  const f = await fixture(t, { rtcMediaFactory: fakeRtc });
  const first = await rtcLogin(f), cookie = first.cookie.split(';')[0], native = f.native();
  native.resume(); // Consume cancellation packets so the fixture observes EOF.
  first.send('media-fallback');
  await until(() => f.receiver.status().mediaMode === 'webcodecs');
  const endpoint = f.invitation.url + 'stream/session';
  const denied = await fetch(endpoint, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403); assert.equal(await resumable(f, cookie), true);
  const stopped = await fetch(endpoint, { method: 'POST', headers: { Cookie: cookie, Origin: f.invitation.url.slice(0, -1) } });
  assert.equal(stopped.status, 204);
  await until(() => native.destroyed);
  assert.equal(await resumable(f, cookie), false); assert.equal(f.calls(), 1);
  await assert.rejects(f.open(undefined, cookie), /403/);
});
