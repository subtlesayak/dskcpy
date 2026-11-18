import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createBrowserReceiver } from './browser.mjs';
import { createTrustedDevices, TRUST_LIFETIME_MS } from './trusted-devices.mjs';
import { touchPacket } from '../receiver/protocol.mjs';
const origin = 'https://host.example';
const policy = { keyboard: true, rememberProfile: { maxSize: 1600, maxFps: 30, bitRateMbps: 8 } };
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail('Expected state transition');
}
async function fixture(t, { viewOnly = false, beforeTrusted = async () => {}, now = Date.now } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-browser-trust-'));
  const filename = path.join(dir, 'devices.json');
  let store = createTrustedDevices({ filename, now }); await store.ready;
  const natives = new Set(), controls = []; let captures = 0, receiver;
  const options = { configuredPort: 0, origin, trustedDevices: store, onConnect: async bridge => {
    captures++; const native = net.connect(bridge.port, '127.0.0.1'); natives.add(native); native.on('error', () => {});
    native.on('data',chunk=>controls.push(chunk));
    await once(native, 'connect'); native.write(Buffer.from('535244310000000100000280000001e0', 'hex'));
  }, onTrustedConnect: async device => { await beforeTrusted(); return receiver.invite('internet', { ...policy, rememberProfile: device.profile }, device); } };
  receiver = createBrowserReceiver(options);
  t.after(async () => { for (const n of natives) n.destroy(); await receiver.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const invitation = await receiver.invite('internet', { ...policy, viewOnly });
  const post = (route, cookie, body = {}, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: receiver.port, path: `/stream/${route}`, method: 'POST',
      headers: { Host: 'host.example', Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers } }, res => {
      let bytes = ''; res.on('data', c => bytes += c); res.on('end', () => resolve({ status: res.statusCode,
        body: JSON.parse(bytes || '{}'), cookie: res.headers['set-cookie']?.[0] }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  const connect = async (key, requestOrigin = origin, requestHost = 'host.example', cookie) => {
    const ws = new WebSocket(`ws://127.0.0.1:${receiver.port}/stream`, { origin: requestOrigin, headers: { Host: requestHost, ...(cookie ? {Cookie:cookie} : {}) } });
    ws.on('error', () => {}); ws.received = [];
    ws.on('upgrade', res => ws.cookie = res.headers['set-cookie']?.[0].split(';')[0]);
    ws.on('message', (data, binary) => ws.received.push({ data, binary }));
    await once(ws, 'open'); if(key)ws.send(key); return ws;
  };
  return { get receiver() { return receiver; }, get store() { return store; }, post, connect, invitation, captures: () => captures,
    controls:()=>Buffer.concat(controls), clearControls:()=>{controls.length=0;},
    async restart() {
      for (const native of natives) native.destroy(); await receiver.shutdown();
      store = createTrustedDevices({ filename, now }); await store.ready;
      receiver = createBrowserReceiver({ ...options, trustedDevices: store }); await receiver.standby();
    } };
}
async function enroll(f) {
  const ws = await f.connect(f.invitation.key); await until(() => f.captures() === 1);
  const result = await f.post('remember', ws.cookie, { name: 'Test phone' });
  assert.equal(result.status, 202); assert.match(result.cookie, /HttpOnly; Secure; SameSite=Strict; Path=\/stream; Max-Age=7776000/);
  const cookie = result.cookie.split(';')[0];
  assert.equal((await f.post('trusted/connect', cookie)).status, 403);
  const pending = f.receiver.trustedStatus().pending;
  assert.equal(pending.length, 1); await f.receiver.trustAction('approve', pending[0].id);
  assert.equal((await f.post('remember/status', cookie)).body.status, 'approved');
  return { ws, cookie, id: pending[0].id };
}

test('pair once, host approve, reconnect without a new owner invitation, revoke ends access', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('remember', null, { name: 'Unpaired' })).status, 400);
  const { ws, cookie, id } = await enroll(f);
  assert.equal((await f.post('trusted/connect', cookie)).status, 409); // never displace live viewer
  assert.equal(f.captures(), 1);
  ws.close(4000); await until(() => !f.receiver.status().connected);
  const ticket = await f.post('trusted/connect', cookie); assert.equal(ticket.status, 201);
  assert.match(ticket.body.key, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(f.captures(), 1); // ticket alone does not start capture
  const returning = await f.connect(ticket.body.key); await until(() => f.captures() === 2);
  const closed = once(returning, 'close'); await f.receiver.trustAction('revoke', id); await closed;
  assert.equal((await f.post('trusted/connect', cookie)).status, 403);
  assert.equal(f.receiver.status().connected, false);
});

test('Stop/pause survives registry reload and stale trusted tickets cannot bypass revocation', async t => {
  const f = await fixture(t); const { ws, cookie, id } = await enroll(f);
  ws.close(4000); await until(() => !f.receiver.status().connected);
  const ticket = await f.post('trusted/connect', cookie); assert.equal(ticket.status, 201);
  await f.receiver.trustAction('pause');
  assert.equal((await f.post('remember/status', cookie)).body.paused, true);
  assert.equal((await f.post('trusted/connect', cookie)).status, 403);
  assert.equal(f.store.snapshot().paused, true);
  await f.receiver.trustAction('resume');
  const next = await f.post('trusted/connect', cookie); assert.equal(next.status, 201);
  await f.receiver.trustAction('revoke', id);
  await assert.rejects(f.connect(next.body.key), /403/);
  assert.equal(f.captures(), 1);
});

test('private-origin CSRF guards and view-only session cannot grant full-desktop remembered access', async t => {
  const f = await fixture(t, { viewOnly: true });
  const ws = await f.connect(f.invitation.key); await until(() => f.captures() === 1);
  for (const headers of [{ Origin: 'https://other.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'http://host.example' }]) {
    assert.equal((await f.post('remember', ws.cookie, { name: 'Test' }, headers)).status, 403);
  }
  assert.equal((await f.post('remember', ws.cookie, { name: 'Test' })).status, 400);
  assert.equal(f.receiver.trustedStatus().pending.length, 0); ws.close(4000);
});

test('trusted reconnect and revocation preserve an unrelated temporary invitation', async t => {
  const f = await fixture(t); const { ws, cookie, id } = await enroll(f);
  ws.close(4000); await until(() => !f.receiver.status().connected);
  // A waiting invitation is preserved rather than replaced by trusted reconnect.
  const invitation = await f.receiver.invite('internet', policy);
  assert.equal((await f.post('trusted/connect', cookie)).status, 409);
  assert.equal(f.receiver.status().waiting, true);
  assert.ok(invitation.key); assert.equal(f.captures(), 1);
  await f.receiver.trustAction('revoke', id);
  assert.equal(f.receiver.status().waiting, true); // unrelated temporary invite survives
  f.receiver.cancel();
});


test('a restarted receiver listens without capture and accepts the previously approved browser', async t => {
  const f = await fixture(t); const { ws, cookie } = await enroll(f);
  ws.close(4000); await until(() => !f.receiver.status().connected);
  await f.restart();
  assert.equal(f.receiver.status().waiting, false); assert.equal(f.receiver.status().connected, false);
  assert.equal(f.captures(), 1); assert.ok(f.receiver.port > 0);
  const ticket = await f.post('trusted/connect', cookie); assert.equal(ticket.status, 201);
  const ws2 = await f.connect(ticket.body.key); await until(() => f.captures() === 2); ws2.close(4000);
});

test('revocation during awaited readiness prevents a new ticket and capture', async t => {
  let release, preparing = false;
  const f = await fixture(t, { beforeTrusted: async () => { preparing = true; await new Promise(resolve => release = resolve); } });
  const { ws, cookie, id } = await enroll(f); ws.close(4000); await until(() => !f.receiver.status().connected);
  const pending = f.post('trusted/connect', cookie); await until(() => preparing);
  await f.receiver.trustAction('revoke', id); release();
  assert.equal((await pending).status, 400);
  assert.equal(f.receiver.status().waiting, false); assert.equal(f.captures(), 1);
});


test('shutdown retires an in-flight trusted preparation without capture or a late ticket', async t => {
  let release, preparing = false;
  const f = await fixture(t, { beforeTrusted: async () => { preparing = true; await new Promise(resolve => release = resolve); } });
  const { ws, cookie } = await enroll(f); ws.close(4000); await until(() => !f.receiver.status().connected);
  const pending = f.post('trusted/connect', cookie).catch(() => ({ status: 0 })); await until(() => preparing);
  const shuttingDown = f.receiver.shutdown(); release(); await shuttingDown;
  assert.notEqual((await pending).status, 201);
  assert.equal(f.receiver.status().waiting, false); assert.equal(f.captures(), 1);
});


test('trusted reconnect tickets are bound to the approved private receiver origin', async t => {
  const f = await fixture(t); const { ws, cookie } = await enroll(f);
  ws.close(4000); await until(() => !f.receiver.status().connected);
  const ticket = await f.post('trusted/connect', cookie); assert.equal(ticket.status, 201);
  await assert.rejects(f.connect(ticket.body.key, `http://127.0.0.1:${f.receiver.port}`, `127.0.0.1:${f.receiver.port}`), /403/);
  assert.equal(f.captures(), 1); assert.equal(f.receiver.status().waiting, true);
  const returning = await f.connect(ticket.body.key); await until(() => f.captures() === 2); returning.close(4000);
});

test('an active remembered capture and its resume cannot outlive the approval deadline', { timeout:5000 }, async t => {
  // Model an old approval whose absolute deadline is near now; neither the
  // system clock nor the ordinary 90-day enrollment lifetime is changed.
  let offset=-TRUST_LIFETIME_MS+700;
  const f=await fixture(t,{now:()=>Date.now()+offset});const {ws,cookie}=await enroll(f);
  const deadline=f.store.snapshot().devices[0].expiresAt;offset=0;
  ws.close(4000);await until(()=>!f.receiver.status().connected);
  const ticket=await f.post('trusted/connect',cookie);assert.equal(ticket.status,201);
  const returning=await f.connect(ticket.body.key);await until(()=>returning.received.some(m=>m.binary));
  assert.equal(f.captures(),2);const resumeCookie=returning.cookie;
  const disconnected=once(returning,'close');returning.close(4001);await disconnected;
  const resumed=await f.connect(null,origin,'host.example',resumeCookie);await until(()=>resumed.received.some(m=>m.binary));
  assert.equal(f.captures(),2,'transport resume cannot create a new capture or approval');
  resumed.send('resume');resumed.ping();await once(resumed,'pong');f.clearControls();
  const held=Buffer.from(touchPacket(0,0,20,20,640,480)),key=Buffer.from([8,0,0,4,1]);
  resumed.send(held);resumed.send(key);await until(()=>f.controls().includes(held)&&f.controls().includes(key));
  await until(()=>!f.receiver.status().connected);
  assert.ok(Date.now()>=deadline-20,'approval expiry does not end an otherwise valid session early');
  await until(()=>f.controls().includes(Buffer.from(touchPacket(3,0,20,20,640,480)))&&f.controls().includes(Buffer.from([8,2,0,0,0])));
  assert.equal((await f.post('trusted/connect',cookie)).status,403);
  assert.equal(f.captures(),2);assert.equal(f.receiver.status().waiting,false);
  await assert.rejects(f.connect(null,origin,'host.example',resumeCookie),/403/);
});
