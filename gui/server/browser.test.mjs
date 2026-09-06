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
import { ack, avcCodec, avcParameters, touchPacket, takeDecodedTimestamps } from '../receiver/protocol.mjs';

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
  const invitation = await receiver.invite();
  const open = async (origin = invitation.url.slice(0, -1)) => {
    const ws = new WebSocket(invitation.url.replace('http:', 'ws:') + 'stream', { origin });
    ws.on('error', () => {});
    await once(ws, 'open');
    return ws;
  };
  return { receiver, invitation, open, native: () => native, calls: () => calls };
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

test('receiver serves only fixed assets, rejects Host rebinding, no control routes or key in URL', async (t) => {
  const f = await fixture(t);
  const response = await fetch(f.invitation.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /Temporary session key/);
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
