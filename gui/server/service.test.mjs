import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrustedDevices, deviceDigest } from './trusted-devices.mjs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { WebSocket } from 'ws';
import net from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { createControlService } from './service.mjs';

const ready = {
  checks: [{ id: 'binary', label: 'Program', ready: true }],
  transports: Object.fromEntries(['usb', 'wifi', 'ip', 'internet', 'browser'].map((mode) => [mode, { ready: true, required: [], message: 'Ready' }])),
};

function fakeChild({ fail = false, ignoreStop = false } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.input = '';
  child.forced = false;
  child.exit = (code) => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.emit('exit', code);
    child.emit('close', code);
  };
  child.stdin = new Writable({ write(chunk, encoding, done) { child.input += chunk; done(); } });
  child.stdin.on('finish', () => { if (!ignoreStop) setImmediate(() => child.exit(0)); });
  child.kill = () => { child.forced = true; child.exit(1); };
  if (fail) setImmediate(() => { child.emit('error', new Error('spawn failed')); child.exit(-2); });
  return child;
}

async function fixture(t, options = {}) {
  const children = [];
  const service = createControlService({
    // The real Node executable satisfies path resolution, but is never launched.
    environment: { ...process.env, SCRCPY_GUI_BINARY: process.execPath },
    configuredPort: 0,
    browserPort: 0,
    readinessProbe: async () => ready,
    commandRunner: async () => ({ stdout: '', stderr: '' }),
    spawnProcess: (executable, args, spawnOptions) => {
      const child = fakeChild();
      children.push({ child, executable, args, spawnOptions });
      return child;
    },
    ...options,
  });
  const port = await service.listen();
  t.after(() => service.shutdown());
  const request = (target, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target,
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { ...service, request, children, port };
}

async function waitFor(predicate) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('Expected state transition did not occur');
}

test('phone startup history survives raw-log overflow and preserves a final partial phase', async t => {
  const f = await fixture(t);
  const started = await f.request('/api/stream/start', { connection: 'wifi', serial: 'fixture._adb-tls-connect._tcp' });
  assert.equal(started.code, 202);
  const child = f.children[0].child;
  child.stdout.write('INFO: Reverse startup: install-');
  child.stdout.write('start\nINFO: Reverse startup: install-ready\nINFO: Reverse startup: launch-start\nINFO: Reverse startup: launch-ready\nINFO: Reverse startup: socket-wait\n');
  for (let n = 0; n < 220; n++) child.stderr.write(`DEBUG: retry ${n} PRIVATE_DIAGNOSTIC\n`);
  assert.equal(f.publicState().logs.length, 160);
  assert.ok(!f.publicState().logs.some(entry => entry.message.includes('launch-ready')));
  child.stderr.write('INFO: Reverse startup: socket-failed'); child.exit(2);
  const value = (await f.request('/api/status')).body.nativeStartup;
  assert.equal(value.current.status, 'failed'); assert.equal(value.current.failure, 'socket-failed');
  assert.deepEqual(value.current.events.map(event => event.phase), ['host-check', 'install-start', 'install-ready', 'launch-start', 'launch-ready', 'socket-wait']);
  assert.ok(!JSON.stringify(value).includes('PRIVATE')); assert.ok(value.current.endedAt);
});
test('automatic reconnect retains earlier startup facts; manual start resets the history', async t => {
  const f = await fixture(t, { reconnectDelayMs: 5 });
  await f.request('/api/stream/start', { connection: 'usb', serial: 'fixture', autoReconnect: true });
  f.children[0].child.stdout.write('INFO: Reverse startup: launch-ready\nINFO: Reverse startup: socket-failed\n');
  f.children[0].child.exit(2); await waitFor(() => f.children.length === 2);
  assert.equal(f.publicState().nativeStartup.current.attempt, 2);
  assert.equal(f.publicState().nativeStartup.previous[0].failure, 'socket-failed');
  await f.request('/api/stream/stop', {}); await waitFor(() => !f.publicState().running);
  assert.equal(f.publicState().nativeStartup.current.status, 'stopped');
  await f.request('/api/stream/start', { connection: 'usb' });
  assert.equal(f.publicState().nativeStartup.current.attempt, 1); assert.deepEqual(f.publicState().nativeStartup.previous, []);
});
test('a preflight failure preserves only fixed host-check context', async t => {
  const f = await fixture(t, { readinessProbe: async () => ({ ...ready, transports: { ...ready.transports, usb: { ready: false, message: 'PRIVATE_PATH' } } }) });
  const result = await f.request('/api/stream/start', { connection: 'usb' });
  assert.equal(result.code, 400); assert.equal(f.children.length, 0);
  const value = f.publicState().nativeStartup;
  assert.equal(value.current.failure, 'host-check-failed'); assert.ok(!JSON.stringify(value).includes('PRIVATE'));
});
test('old native hosts can stream without being mislabeled as still connecting', async t => {
  const f = await fixture(t);
  await f.request('/api/stream/start', { connection: 'usb' });
  f.children[0].child.stdout.write('DEBUG: Reverse display encode-submission-to-decode round-trip: 12.5 ms\n');
  assert.equal(f.publicState().running, true); assert.equal(f.publicState().latencyMs, 12.5);
  assert.equal(f.publicState().nativeStartup.current.status, 'unreported');
  f.children[0].child.stdout.write('INFO: Reverse startup: install-start\n');
  assert.equal(f.publicState().nativeStartup.current.status, 'starting');
});

test('launcher health endpoint exposes only app identity and does not probe or start programs', async (t) => {
  let probes = 0;
  const f = await fixture(t, { readinessProbe: async () => { probes++; return ready; } });
  const response = await f.request('/api/health');
  assert.equal(response.code, 200);
  assert.deepEqual(response.body, { app: 'dskcpy', apiVersion: 1 });
  assert.equal(probes, 0);
  assert.equal(f.children.length, 0);
});

test('Mac encode-submission telemetry updates the live dashboard', async (t) => {
  const f = await fixture(t);
  await f.request('/api/stream/start', { connection: 'usb' });
  f.children[0].child.stderr.write('DEBUG: Reverse display encode-submission-to-decode round-trip: 12.5 ms\n');
  assert.equal(f.publicState().latencyMs, 12.5);
});

test('native capture denial reaches the authenticated browser as a fixed recovery category', async (t) => {
  const f = await fixture(t, { platform: 'darwin' });
  const { body } = await f.request('/api/browser/invite', {});
  const ws = new WebSocket(body.url.replace('http:', 'ws:') + 'stream', { origin: body.url.slice(0, -1) });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  await once(ws, 'open'); ws.send(body.key);
  await waitFor(() => f.children.length === 1);
  const closed = once(ws, 'close');
  f.children[0].child.stderr.write('ERROR: Allow Screen Recording for the launching Terminal/dskcpy; PRIVATE_DIAGNOSTIC\n');
  f.children[0].child.exit(1);
  const [code, reason] = await closed;
  assert.equal(code, 1008); assert.equal(reason.toString(), 'capture-permission');
  assert.equal(f.publicState().running, false);
});

test('known Mac geometry changes wait for drained child close, then start a fresh authorized capture', async t=>{
  const f=await fixture(t,{platform:'darwin',readinessProbe:async()=>({...ready,features:{browserCaptureRecovery:true}})});
  const {body}=await f.request('/api/browser/invite',{});
  const ws=new WebSocket(body.url.replace('http:','ws:')+'stream',{origin:body.url.slice(0,-1)});
  let cookie;ws.on('upgrade',res=>cookie=res.headers['set-cookie'][0].split(';')[0]);ws.on('error',()=>{});t.after(()=>ws.terminate());
  await once(ws,'open');ws.send(body.key);await waitFor(()=>f.children.length===1);
  const old=f.children[0].child,closed=once(ws,'close');
  old.exitCode=2;old.emit('exit',2);
  assert.equal(f.children.length,1);assert.equal(f.publicState().running,true);
  // Native reason may arrive after exit but before stdio closes.
  old.stdout.write('DSKCPY_CAPTURE_END display-');old.stdout.write('change\n');old.emit('close',2);
  const [code]=await closed;assert.equal(code,1012);
  await waitFor(()=>f.children.length===2);
  assert.equal(f.publicState().running,true);assert.equal(f.publicState().error,null);
  assert.ok(!JSON.stringify(f.publicState().logs).includes('DSKCPY_CAPTURE_END'));
  const response=await fetch(body.url+'stream/session',{headers:{Cookie:cookie}});
  assert.equal((await response.json()).resumable,true);
  await f.request('/api/stream/stop',{});await waitFor(()=>!f.publicState().running);
  assert.equal(f.children.length,2);assert.equal(f.publicState().browser.connected,false);
});

for(const scenario of ['permission','user-stop','unknown','old-host','window'])test('capture recovery does not restart '+scenario,async t=>{
  const f=await fixture(t,{platform:'darwin',readinessProbe:async()=>({...ready,features:{browserCaptureRecovery:scenario!=='old-host',macWindowCapture:true}})});
  const {body}=await f.request('/api/browser/invite',scenario==='window'?{windowId:12,windowOwnerPid:34}:{});
  const ws=new WebSocket(body.url.replace('http:','ws:')+'stream',{origin:body.url.slice(0,-1)});
  ws.on('error',()=>{});t.after(()=>ws.terminate());await once(ws,'open');ws.send(body.key);
  await waitFor(()=>f.children.length===1);const child=f.children[0].child;
  child.stdout.write('DSKCPY_CAPTURE_END '+(scenario==='unknown'?'untrusted-reason':'display-change')+'\n');
  if(scenario==='permission')child.stdout.write('DSKCPY_CAPTURE_END permission-lost\n');
  if(scenario==='user-stop')child.stdout.write('DSKCPY_CAPTURE_END user-stop\n');
  const ended=once(ws,'close');child.exit(scenario==='user-stop'?0:2);const [code]=await ended;assert.equal(code,1008);
  await waitFor(()=>!f.publicState().running);assert.equal(f.children.length,1);
});

test('owner Stop during recovery readiness cancels the fresh child and preserves stopped access',async t=>{
  let block=false,entered=false,release;const waiting=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{platform:'darwin',readinessProbe:async()=>{
    if(block){entered=true;await waiting;}
    return {...ready,features:{browserCaptureRecovery:true}};
  }});
  const {body}=await f.request('/api/browser/invite',{});
  const ws=new WebSocket(body.url.replace('http:','ws:')+'stream',{origin:body.url.slice(0,-1)});
  ws.on('error',()=>{});t.after(()=>ws.terminate());await once(ws,'open');ws.send(body.key);
  await waitFor(()=>f.children.length===1);block=true;
  f.children[0].child.stdout.write('DSKCPY_CAPTURE_END display-change\n');f.children[0].child.exit(2);
  await waitFor(()=>entered);await f.request('/api/stream/stop',{});release();
  await waitFor(()=>!f.publicState().running);
  assert.equal(f.children.length,1);assert.equal(f.publicState().browser.connected,false);assert.equal(f.publicState().error,null);
});

test('view-only capture drains a late permission reason without acquiring restart permission',async t=>{
 const f=await fixture(t,{platform:'darwin',readinessProbe:async()=>({...ready,features:{browserCaptureRecovery:true,macWindowCapture:true}})});
 const {body}=await f.request('/api/browser/invite',{windowId:12,windowOwnerPid:34});
 const ws=new WebSocket(body.url.replace('http:','ws:')+'stream',{origin:body.url.slice(0,-1)});ws.on('error',()=>{});t.after(()=>ws.terminate());
 await once(ws,'open');ws.send(body.key);await waitFor(()=>f.children.length===1);
 const child=f.children[0].child;child.exitCode=2;child.emit('exit',2);
 assert.equal(f.publicState().running,true);
 child.stdout.write('DSKCPY_CAPTURE_END permission-lost\n');const ended=once(ws,'close');child.emit('close',2);await ended;
 assert.equal(f.children.length,1);assert.match(f.publicState().error,/Screen capture permission/);
});

test('Mac browser launch selects compatible video and reports send RTT without decode latency', async (t) => {
  const f = await fixture(t, { platform: 'darwin' });
  const { body } = await f.request('/api/browser/invite', {});
  const ws = new WebSocket(body.url.replace('http:', 'ws:') + 'stream/webrtc', {
    origin: body.url.slice(0, -1),
  });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  await once(ws, 'open'); ws.send(body.key);
  await waitFor(() => f.children.length === 1);
  assert.equal(f.children[0].spawnOptions.env.DSKCPY_MAC_BROWSER_COMPAT, '1');
  f.children[0].child.stderr.write('DEBUG: Reverse display encode-submission-to-decode round-trip: 12.5 ms\n');
  assert.equal(f.publicState().latencyMs, null);
  assert.match(f.publicState().logs.at(-1).message, /encode-submission-to-WebRTC-send round-trip: 12.5 ms/);
  await f.request('/api/stream/stop', {});
});

test('Mac capability follows the binary probe and rejects incompatible encoders before spawn', async (t) => {
  const f = await fixture(t, { platform: 'darwin', readinessProbe: async () => ({ ...ready,
    checks: [...ready.checks, { id: 'capture', ready: true }] }) });
  const rejected = await f.request('/api/stream/start', { connection: 'usb', encoder: 'h264_nvenc' });
  assert.equal(rejected.code, 400);
  assert.match(rejected.body.error, /Mac host requires/);
  assert.equal(f.children.length, 0);
  const started = await f.request('/api/stream/start', { connection: 'usb', encoder: 'h264_videotoolbox' });
  assert.equal(started.code, 202);
  assert.equal(f.publicState().hostPlatform, 'macOS');
  assert.equal(f.publicState().reverseDisplaySupported, true);
  assert.ok(f.children[0].args.includes('--video-encoder=h264_videotoolbox'));
  await f.request('/api/stream/stop', {});
});

test('browser invitation reserves capture, key never enters status, Stop invalidates it', async (t) => {
  const f = await fixture(t);
  const invite = await f.request('/api/browser/invite', { maxSize: 1280 });
  assert.equal(invite.code, 201); assert.equal(f.children.length, 0);
  assert.equal(invite.body.status.browser.waiting, true);
  assert.equal(invite.body.status.browser.url, invite.body.url);
  assert.equal(invite.body.status.browser.expiresAt, invite.body.expiresAt);
  assert.equal(invite.body.status.running, false);
  assert.ok(!JSON.stringify(invite.body.status).includes(invite.body.key));
  assert.match(invite.body.key, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(f.publicState()).includes(invite.body.key));
  assert.equal((await f.request('/api/stream/start', { connection: 'usb' })).code, 400);
  assert.equal((await f.request('/api/browser/invite', {})).code, 400);
  await f.request('/api/stream/stop', {});
  assert.equal(f.publicState().browser.waiting, false);
  assert.equal((await f.request('/api/stream/start', { connection: 'browser' })).code, 400);
  assert.equal(f.children.length, 0);
});

test('browser authenticates before native launch, bypasses ADB, and stops its exact process', async (t) => {
  let native;
  const f = await fixture(t, { spawnProcess: (exe, args) => {
    assert.ok(args.includes('--max-size=1280'));
    assert.ok(!args.some((a) => a.startsWith('--connection=')));
    const port = Number(args.find((a) => a.startsWith('--reverse-socket=')).split('=')[1]);
    native = net.connect(port, '127.0.0.1'); native.on('error', () => {});
    const child = fakeChild();
    native.on('close', () => child.exit(2));
    return child;
  } });
  t.after(() => native?.destroy());
  const { body } = await f.request('/api/browser/invite', { maxSize: 1280, sessionKey: 'must-not-persist' });
  const ws = new WebSocket(body.url.replace('http:', 'ws:') + 'stream', { origin: body.url.slice(0, -1) });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  await once(ws, 'open'); ws.send(body.key);
  await waitFor(() => f.publicState().running);
  assert.equal(f.publicState().config.connection, 'browser');
  assert.ok(!JSON.stringify(f.publicState()).includes(body.key));
  assert.ok(!JSON.stringify(f.publicState()).includes('must-not-persist'));
  ws.close();
  await waitFor(() => !f.publicState().running && !f.publicState().browser.connected);
});

test('Stop during browser readiness cancels invitation creation without capture', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { readinessProbe: () => gate });
  const invite = f.request('/api/browser/invite', {});
  await new Promise((resolve) => setTimeout(resolve, 15));
  await f.request('/api/stream/stop', {}); release(ready);
  assert.equal((await invite).code, 400);
  assert.equal(f.publicState().browser.waiting, false); assert.equal(f.children.length, 0);
});

test('browser reload keeps the native process and owned USB tunnel until explicit Stop', async (t) => {
  let native, starts = 0, cookie;
  const commands = [];
  const f = await fixture(t, {
    readinessProbe: async () => ({ ...ready, checks: [...ready.checks, { id: 'adb', ready: true }] }),
    commandRunner: async (exe, args) => {
      commands.push(args);
      return { stdout: args[0] === 'devices' ? 'List of devices attached\ntest-usb device model:Test\n' : '' };
    },
    spawnProcess: (exe, args) => {
      starts++;
      native = net.connect(Number(args.find((arg) => arg.startsWith('--reverse-socket=')).split('=')[1]), '127.0.0.1');
      native.on('error', () => {});
      native.on('connect', () => native.write(Buffer.from('535244310000000100000280000001e0', 'hex')));
      const child = fakeChild(); native.on('close', () => child.exit(2)); return child;
    },
  });
  t.after(() => native?.destroy());
  const { body } = await f.request('/api/browser/invite', { browserTransport: 'usb' });
  const address = body.url.replace('http:', 'ws:') + 'stream';
  const ws = new WebSocket(address, { origin: body.url.slice(0, -1) });
  ws.on('upgrade', (response) => { cookie = response.headers['set-cookie'][0].split(';')[0]; });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  await once(ws, 'open'); ws.send(body.key);
  await waitFor(() => native && !native.connecting && f.publicState().running);
  const away = once(ws, 'close'); ws.close(4001); await away;
  assert.equal(f.publicState().running, true); assert.equal(f.publicState().browser.connected, true);
  assert.ok(!commands.some((args) => args.includes('--remove')));
  const restored = new WebSocket(address, { origin: body.url.slice(0, -1), headers: { Cookie: cookie } });
  restored.on('error', () => {}); t.after(() => restored.terminate());
  let authenticated = false;
  restored.on('message', (data, binary) => { if (!binary) authenticated = JSON.parse(data).type === 'authenticated'; });
  await waitFor(() => authenticated);
  assert.equal(starts, 1);
  assert.ok(!JSON.stringify(f.publicState()).includes(cookie.split('=')[1]));
  await f.request('/api/stream/stop', {});
  await waitFor(() => !f.publicState().running && commands.some((args) => args.includes('--remove')));
  assert.equal(f.publicState().browser.connected, false);
});

test('USB browser mode owns one non-rebinding tunnel and removes only that tunnel', async (t) => {
  const commands = [];
  const f = await fixture(t, {
    readinessProbe: async () => ({ ...ready, checks: [...ready.checks, { id: 'adb', ready: true }] }),
    commandRunner: async (exe, args) => {
      commands.push(args);
      return { stdout: args[0] === 'devices' ? 'List of devices attached\ntest-usb device model:Test\n' : '' };
    },
  });
  const result = await f.request('/api/browser/invite', { browserTransport: 'usb' });
  assert.equal(result.code, 201); assert.equal(result.body.mode, 'usb');
  const reverse = commands.find((args) => args.includes('--no-rebind'));
  assert.deepEqual(reverse.slice(0, 4), ['-s', 'test-usb', 'reverse', '--no-rebind']);
  assert.equal(reverse[4], reverse[5]);
  assert.equal(Number(reverse[4].slice(4)), Number(new URL(result.body.url).port));
  assert.equal(result.body.openedOnPhone, true);
  const open = commands.find(args => args.includes('android.intent.action.VIEW'));
  assert.deepEqual(open.slice(0, 5), ['-s', 'test-usb', 'shell', 'am', 'start']);
  const join = new URL(open.at(-1));
  assert.equal(join.hostname, '127.0.0.1'); assert.match(join.pathname, /^\/join\/[a-f0-9]{32}$/);
  assert.equal(join.hash, `#connect=${result.body.key}`);
  assert.ok(!JSON.stringify(f.publicState()).includes(result.body.key));
  assert.equal(f.children.length, 0);
  await f.request('/api/stream/stop', {});
  await waitFor(() => commands.some((args) => args.includes('--remove')));
  assert.deepEqual(commands.find((args) => args.includes('--remove')), ['-s', 'test-usb', 'reverse', '--remove', reverse[4]]);
  assert.ok(!commands.flat().includes('--remove-all'));
});

test('USB phone may authenticate before its browser-launch command returns', async (t) => {
  let ws, f;
  f = await fixture(t, {
    readinessProbe: async () => ({ ...ready, checks: [...ready.checks, { id: 'adb', ready: true }] }),
    commandRunner: async (_exe, args) => {
      if (args[0] === 'devices') return { stdout: 'List of devices attached\ntest-usb device model:Test\n' };
      if (args.includes('android.intent.action.VIEW')) {
        const join = new URL(args.at(-1));
        ws = new WebSocket(new URL('/stream', join).href.replace('http:', 'ws:'), { origin: join.origin });
        ws.on('error', () => {}); await once(ws, 'open'); ws.send(join.hash.slice('#connect='.length));
        await waitFor(() => f.children.length === 1);
      }
      return { stdout: '' };
    },
  });
  t.after(() => ws?.terminate());
  const response = await f.request('/api/browser/invite', { browserTransport: 'usb' });
  assert.equal(response.code, 201); assert.equal(response.body.openedOnPhone, true);
  assert.equal(response.body.status.browser.connected, true);
  assert.equal(f.publicState().running, true);
});

test('USB browser launch failure keeps manual fallback without leaking its raw diagnostics', async (t) => {
  const f = await fixture(t, {
    readinessProbe: async () => ({ ...ready, checks: [...ready.checks, { id: 'adb', ready: true }] }),
    commandRunner: async (_exe, args) => {
      if (args.includes('android.intent.action.VIEW')) throw new Error('PRIVATE_ADB_DIAGNOSTIC');
      return { stdout: 'List of devices attached\ntest-usb device model:Test\n' };
    },
  });
  const response = await f.request('/api/browser/invite', { browserTransport: 'usb' });
  assert.equal(response.code, 201); assert.equal(response.body.openedOnPhone, false);
  assert.equal(f.publicState().browser.waiting, true);
  assert.ok(!JSON.stringify(response.body).includes('PRIVATE_ADB_DIAGNOSTIC'));
});

test('USB tunnel creation failure never overwrites an existing mapping or leaks an invitation', async (t) => {
  const f = await fixture(t, {
    readinessProbe: async () => ({ ...ready, checks: [...ready.checks, { id: 'adb', ready: true }] }),
    commandRunner: async (exe, args) => {
      if (args.includes('--no-rebind')) throw new Error('existing mapping');
      return { stdout: 'List of devices attached\ntest-usb device model:Test\n' };
    },
  });
  const result = await f.request('/api/browser/invite', { browserTransport: 'usb' });
  assert.equal(result.code, 400); assert.match(result.body.error, /will not be overwritten/);
  assert.equal(f.publicState().browser.waiting, false); assert.equal(f.children.length, 0);
});

test('remote browser modes fail closed without trusted HTTPS and never fall back to ADB', async (t) => {
  const f = await fixture(t, { commandRunner: async () => { throw new Error('ADB must not run'); } });
  for (const browserTransport of ['wifi', 'ip', 'internet']) {
    const result = await f.request('/api/browser/invite', { browserTransport });
    assert.equal(result.code, 400); assert.match(result.body.error, /trusted HTTPS/);
    assert.equal(f.publicState().browser.waiting, false);
  }
  assert.equal(f.children.length, 0);
});

test('Mac private-network discovery forces CLI mode and never launches Tailscale UI', async (t) => {
  let cli = false;
  const f = await fixture(t, { platform: 'darwin', commandRunner: async (exe, args, options) => {
    if (args[0] === 'status') {
      cli = options.env.TAILSCALE_BE_CLI === '1';
      return { stdout: JSON.stringify({ BackendState: 'Stopped' }) };
    }
    return { stdout: '' };
  } });
  const result = await f.request('/api/internet/status');
  assert.equal(result.code, 200);
  assert.equal(cli, true);
  assert.equal(result.body.ready, false);
});

test('discovery coalesces concurrent requests, returns separate ports, and never launches capture', async (t) => {
  let resolveScan;
  const gate = new Promise((resolve) => { resolveScan = resolve; });
  const commands = [];
  const f = await fixture(t, { commandRunner: async (exe, args, options) => {
    commands.push({ args, options });
    await gate;
    return { stdout: 'List of discovered mdns services\nphone _adb-tls-pairing._tcp 192.168.1.20:33333\nphone _adb-tls-connect._tcp 192.168.1.20:44444', stderr: '' };
  } });
  const first = f.request('/api/wireless/discover', {});
  const second = f.request('/api/wireless/discover', {});
  await waitFor(() => commands.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  resolveScan();
  const responses = await Promise.all([first, second]);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].args, ['mdns', 'services']);
  assert.equal(commands[0].options.timeoutMs, 5000);
  assert.equal(responses[0].body.services.length, 2);
  assert.deepEqual(responses[0].body, responses[1].body);
  assert.equal(f.children.length, 0);
  assert.equal(f.publicState().running, false);
});

test('discovery explains empty and unsupported results without reflecting command errors', async (t) => {
  let fail = false;
  const f = await fixture(t, { commandRunner: async () => {
    if (fail) throw new Error('private diagnostic');
    return { stdout: 'List of discovered mdns services\n', stderr: '' };
  } });
  assert.match((await f.request('/api/wireless/discover', {})).body.message, /No advertised/);
  fail = true;
  const result = await f.request('/api/wireless/discover', {});
  assert.equal(result.code, 400);
  assert.match(result.body.error, /manually/);
  assert.ok(!JSON.stringify(result).includes('private diagnostic'));
});

test('automatic retries preserve the chosen target, stop after three attempts, and never reset on spawn', async (t) => {
  const f = await fixture(t, { reconnectDelayMs: 5 });
  await f.request('/api/stream/start', { connection: 'wifi', serial: 'phone._adb-tls-connect._tcp', autoReconnect: true });
  f.children[0].child.exit(2);
  assert.equal(f.publicState().reconnecting, true);
  assert.equal((await f.request('/api/stream/start', { connection: 'usb' })).code, 400);
  for (let n = 1; n <= 3; n++) {
    await waitFor(() => f.children.length === n + 1);
    assert.ok(f.children[n].args.includes('--serial=phone._adb-tls-connect._tcp'));
    assert.equal(f.publicState().reconnectAttempt, n);
    f.children[n].child.exit(1); // Reconnection cannot reach the missing phone.
  }
  assert.equal(f.publicState().running, false);
  assert.match(f.publicState().error, /after 3 attempts/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.children.length, 4);
});

test('Stop cancels a pending retry and a fresh manual start has no stale timer', async (t) => {
  const f = await fixture(t, { reconnectDelayMs: 40 });
  await f.request('/api/stream/start', { connection: 'usb', serial: 'chosen', autoReconnect: true });
  f.children[0].child.exit(2);
  await f.request('/api/stream/stop', {});
  assert.equal(f.publicState().running, false);
  assert.equal(f.publicState().nextRetryAt, null);
  await f.request('/api/stream/start', { connection: 'usb', serial: 'other' });
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(f.children.length, 2);
  assert.ok(f.children[1].args.includes('--serial=other'));
});

test('Stop during retry readiness cancels the attempt before spawning', async (t) => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { reconnectDelayMs: 5, readinessProbe: async () => ++calls === 1 ? ready : gate });
  await f.request('/api/stream/start', { connection: 'usb', serial: 'chosen', autoReconnect: true });
  f.children[0].child.exit(2);
  await waitFor(() => calls === 2);
  await f.request('/api/stream/stop', {});
  release(ready);
  await waitFor(() => !f.publicState().running);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.children.length, 1);
  assert.equal(f.publicState().error, null);
});

test('clean phone exit and disabled reconnect never restart capture', async (t) => {
  const f = await fixture(t, { reconnectDelayMs: 5 });
  await f.request('/api/stream/start', { connection: 'usb', serial: 'chosen', autoReconnect: true });
  f.children[0].child.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.children.length, 1);
  await f.request('/api/stream/start', { connection: 'usb' });
  f.children[1].child.exit(2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.children.length, 2);
});

test('Internet never retains or retries a single-use session secret', async (t) => {
  let bridges = 0;
  const f = await fixture(t, { reconnectDelayMs: 5,
    readInternetStatus: async () => ({ ready: true }),
    bridgeOpener: async () => { bridges++; return { port: 34567, close() {} }; },
  });
  const secret = 'abandon ability able';
  await f.request('/api/stream/start', { connection: 'internet', address: '100.64.0.2', sessionKey: secret, autoReconnect: true });
  assert.equal(f.publicState().config.autoReconnect, false);
  f.children[0].child.exit(2);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(bridges, 1);
  assert.equal(f.children.length, 1);
  assert.ok(!JSON.stringify(f.publicState()).includes(secret));
});

test('automatic selection pins one authorized device and rejects ambiguity', async (t) => {
  let output = 'List of devices attached\nfirst device model:Phone\n';
  const f = await fixture(t, { reconnectDelayMs: 5, commandRunner: async () => ({ stdout: output, stderr: '' }) });
  await f.request('/api/stream/start', { connection: 'usb', autoReconnect: true });
  assert.equal(f.publicState().config.serial, 'first');
  output += 'second device model:Phone\n';
  f.children[0].child.exit(2);
  await waitFor(() => f.children.length === 2);
  assert.ok(f.children[1].args.includes('--serial=first'));
  await f.request('/api/stream/stop', {});
  await waitFor(() => !f.publicState().running);
  assert.equal((await f.request('/api/stream/start', { connection: 'usb', autoReconnect: true })).code, 400);
  assert.equal(f.children.length, 2);
});

test('repeated readiness failures exhaust the retry budget and shutdown cancels waiting retries', async (t) => {
  let calls = 0;
  const f = await fixture(t, { reconnectDelayMs: 5, readinessProbe: async () => {
    if (++calls > 1) throw new Error('Runtime unavailable');
    return ready;
  } });
  await f.request('/api/stream/start', { connection: 'usb', serial: 'chosen', autoReconnect: true });
  f.children[0].child.exit(2);
  await waitFor(() => !f.publicState().running);
  assert.equal(calls, 4);
  assert.equal(f.children.length, 1);
  assert.match(f.publicState().error, /after 3 attempts/);
  const other = await fixture(t, { reconnectDelayMs: 30 });
  await other.request('/api/stream/start', { connection: 'usb', serial: 'chosen', autoReconnect: true });
  other.children[0].child.exit(2);
  await other.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(other.children.length, 1);
  assert.equal(other.publicState().reconnecting, false);
});

test('malformed HTTP targets return 400 and the service remains available', async (t) => {
  const f = await fixture(t);
  for (const target of ['http://[', '/%zz', 'http://example.invalid/api/status']) {
    assert.equal((await f.request(target)).code, 400);
    assert.equal((await f.request('/api/status')).code, 200);
  }
  assert.equal(f.children.length, 0);
});

test('repeated start/stop uses a pipe, releases the slot, and never forces a responsive child', async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 2; n++) {
    assert.equal((await f.request('/api/stream/start', { connection: 'usb' })).code, 202);
    assert.equal((await f.request('/api/stream/start', { connection: 'usb' })).code, 400);
    const { child, spawnOptions } = f.children[n];
    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.env.SCRCPY_GUI_CONTROL, 'stdin-v1');
    assert.equal((await f.request('/api/stream/stop', {})).code, 202);
    await waitFor(() => !f.publicState().running);
    assert.equal(child.input, 'q');
    assert.equal(child.forced, false);
    assert.equal(f.publicState().error, null);
  }
});

test('a failed launch resets state and permits a subsequent start', async (t) => {
  let fail = true;
  const f = await fixture(t, { spawnProcess: () => fakeChild({ fail }) });
  await f.request('/api/stream/start', { connection: 'usb' });
  await waitFor(() => !f.publicState().running);
  assert.match(f.publicState().error, /spawn failed/);
  fail = false;
  assert.equal((await f.request('/api/stream/start', { connection: 'usb' })).code, 202);
  await f.request('/api/stream/stop', {});
  await waitFor(() => !f.publicState().running);
});

test('disconnect and timeout errors are visible and a new stream can start', async (t) => {
  const f = await fixture(t);
  await f.request('/api/stream/start', { connection: 'usb' });
  f.children[0].child.exit(2);
  assert.match(f.publicState().error, /connection was lost/);
  await f.request('/api/stream/start', { connection: 'usb' });
  f.children[1].child.stderr.write('ERROR: Reverse display stalled for 10 seconds. Check the phone and reconnect the stream.\n');
  f.children[1].child.exit(1);
  assert.match(f.publicState().error, /stalled.*reconnect/);
  assert.equal(f.publicState().running, false);
});

test('stop during readiness validation prevents capture and rejects concurrent starts', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { readinessProbe: () => gate });
  const start = f.request('/api/stream/start', { connection: 'usb' });
  await waitFor(() => f.publicState().running);
  assert.equal((await f.request('/api/stream/start', { connection: 'usb' })).code, 400);
  await f.request('/api/stream/stop', {});
  release(ready);
  assert.match((await start).body.error, /cancelled/);
  assert.equal(f.children.length, 0);
  assert.equal(f.publicState().running, false);
  assert.equal(f.publicState().error, null);
});

test('Internet cancellation closes the bridge and never stores the secret', async (t) => {
  let connecting = false;
  let closed = false;
  const f = await fixture(t, {
    readInternetStatus: async () => ({ ready: true, peers: [] }),
    bridgeOpener: ({ signal }) => new Promise((resolve, reject) => {
      connecting = true;
      signal.addEventListener('abort', () => { closed = true; reject(new Error('cancelled')); }, { once: true });
    }),
  });
  const secret = 'abandon ability able';
  const start = f.request('/api/stream/start', { connection: 'internet', address: '100.64.0.2', sessionKey: secret });
  await waitFor(() => connecting);
  assert.ok(!JSON.stringify(f.publicState()).includes(secret));
  await f.request('/api/stream/stop', {});
  assert.equal((await start).code, 400);
  assert.equal(closed, true);
  assert.equal(f.children.length, 0);
});

test('readiness failures block launch at the API boundary', async (t) => {
  const f = await fixture(t, { readinessProbe: async () => ({ ...ready,
    transports: { ...ready.transports, usb: { ready: false, message: 'Companion missing', required: ['companion'] } },
  }) });
  assert.match((await f.request('/api/stream/start', { connection: 'usb' })).body.error, /Companion missing/);
  assert.equal(f.children.length, 0);
  assert.equal(f.publicState().running, false);
});

test('an unresponsive child is forced only after the grace period', async (t) => {
  const child = fakeChild({ ignoreStop: true });
  // Exercise the portable fallback without ever running taskkill against a real PID.
  const f = await fixture(t, { platform: 'linux', spawnProcess: () => child, stopGraceMs: 30 });
  await f.request('/api/stream/start', { connection: 'usb' });
  await f.request('/api/stream/stop', {});
  assert.equal(child.forced, false);
  await waitFor(() => !f.publicState().running);
  assert.equal(child.input, 'q');
  assert.equal(child.forced, true);
});

test('shutdown ends event streams and gracefully stops its child', async (t) => {
  const f = await fixture(t);
  await f.request('/api/stream/start', { connection: 'usb' });
  const ended = new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${f.port}/api/events`, (res) => {
      res.once('data', () => { void f.shutdown(); });
      res.on('end', resolve);
      res.on('error', reject);
      res.resume();
    });
    req.on('error', reject);
  });
  await ended;
  await waitFor(() => !f.publicState().running);
  assert.equal(f.children[0].child.input, 'q');
});

test('large status snapshots drain and coalesce without disconnecting the dashboard', async (t) => {
  const f = await fixture(t);
  await f.request('/api/stream/start', { connection: 'usb' });
  const child = f.children[0].child;
  // Exceed even Node versions with a 64 KiB high-water mark using bounded logs.
  for (let n = 0; n < 150; n++) child.stdout.write(`diagnostic ${n} ${'x'.repeat(900)}\n`);
  assert.ok(JSON.stringify(f.publicState()).length > 65536);
  const events = [], failures = [];
  let body = '';
  const res = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${f.port}/api/events`, resolve);
    req.on('error', reject);
  });
  t.after(() => res.destroy());
  res.on('error', error => failures.push(error.message));
  res.on('data', chunk => {
    body += chunk;
    let end;
    while ((end = body.indexOf('\n\n')) >= 0) {
      const event = body.slice(0, end); body = body.slice(end + 2);
      if (event.startsWith('data: ')) events.push(JSON.parse(event.slice(6)));
    }
  });
  await waitFor(() => events.length > 0);
  for (let n = 0; n < 120; n++) child.stdout.write(`burst ${n}\n`);
  child.stdout.write('newest status marker\n');
  await waitFor(() => events.some(event => event.logs.at(-1)?.message === 'newest status marker'));
  assert.equal(res.destroyed, false);
  assert.deepEqual(failures, []);
  assert.ok(events.length < 120, 'Burst snapshots are coalesced while draining');
  // A later update must still arrive over the same connection.
  child.stdout.write('later status marker\n');
  await waitFor(() => events.some(event => event.logs.at(-1)?.message === 'later status marker'));
  res.destroy();
});

test('Mac window catalog stays local and does not start capture; selection enables view-only native window arguments', async (t) => {
  const features = { macWindowCapture: true, browserKeyboard: true };
  const f = await fixture(t, { platform: 'darwin', readinessProbe: async () => ({ ...ready, features }),
    commandRunner: async (_exe, args) => {
      assert.deepEqual(args, ['--list-reverse-windows']);
      return { stdout: 'scrcpy fixture\nDSKCPY_WINDOWS [{"id":17,"ownerPid":123,"title":"Private fixture title","application":"Test app"}]\n' };
    } });
  const catalog = await f.request('/api/browser/windows', {});
  assert.equal(catalog.code, 200); assert.equal(catalog.body.windows[0].id, 17);
  assert.equal(f.children.length, 0); assert.equal(JSON.stringify(f.publicState()).includes('Private fixture title'), false);
  const invitation = await f.request('/api/browser/invite', { windowId: 17, windowOwnerPid: 123 });
  assert.equal(invitation.code, 201);
  const ws = new WebSocket(invitation.body.url.replace('http:', 'ws:') + 'stream', { origin: invitation.body.url.slice(0, -1) });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  await once(ws, 'open'); ws.send(invitation.body.key);
  await waitFor(() => f.children.length === 1);
  assert.ok(f.children[0].args.includes('--reverse-window=17')); assert.ok(f.children[0].args.includes('--no-audio'));
  assert.equal(f.children[0].args.includes('--reverse-keyboard'), false);
  await f.request('/api/stream/stop', {});
});

test('older hosts reject window selection and never receive new keyboard arguments', async (t) => {
  const f = await fixture(t, { platform: 'darwin' });
  assert.equal((await f.request('/api/browser/invite', { windowId: 17, windowOwnerPid: 123 })).code, 400);
  assert.equal(f.children.length, 0);
  assert.equal((await f.request('/api/browser/windows', {})).code, 400);
});

test('same-computer preview omits keyboard self-injection even on a capable Mac host', async (t) => {
  const f = await fixture(t, { platform: 'darwin', readinessProbe: async () => ({ ...ready,
    features: { macWindowCapture: true, browserKeyboard: true } }) });
  const { body } = await f.request('/api/browser/invite', {});
  const ws = new WebSocket(body.url.replace('http:', 'ws:') + 'stream', { origin: body.url.slice(0, -1) });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  await once(ws, 'open'); ws.send(body.key); await waitFor(() => f.children.length === 1);
  assert.equal(f.children[0].args.includes('--reverse-keyboard'), false);
  await f.request('/api/stream/stop', {});
});

test('private remote Mac desktop session opts into keyboard support only after authentication', async (t) => {
  const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const browserPort = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const origin = 'https://viewer.example.test';
  const f = await fixture(t, { platform: 'darwin', browserPort,
    environment: { ...process.env, SCRCPY_GUI_BINARY: process.execPath, DSKCPY_VIEWER_ORIGIN: origin },
    readinessProbe: async () => ({ ...ready, features: { macWindowCapture: true, browserKeyboard: true } }) });
  const { body, code } = await f.request('/api/browser/invite', { browserTransport: 'wifi' });
  assert.equal(code, 201); assert.equal(f.children.length, 0);
  // Model the configured HTTPS proxy reaching the loopback-only receiver.
  const ws = new WebSocket(`ws://127.0.0.1:${browserPort}/stream`, { origin, headers: { Host: 'viewer.example.test' } });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  await once(ws, 'open'); ws.send(body.key); await waitFor(() => f.children.length === 1);
  assert.ok(f.children[0].args.includes('--reverse-keyboard'));
  await f.request('/api/stream/stop', {});
});


test('owner Stop durably pauses remembered access; remote origin cannot re-enable it', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-owner-trust-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'devices.json'); const store = createTrustedDevices({ filename }); await store.ready;
  await store.approve({ id: 'a'.repeat(32), digest: deviceDigest('x'.repeat(43)), name: 'Test browser',
    origin: 'https://host.example', profile: { maxSize: 1600, maxFps: 30, bitRateMbps: 8 } });
  const f = await fixture(t, { trustedDevicesPath: filename, environment: { SCRCPY_GUI_BINARY: process.execPath, DSKCPY_VIEWER_ORIGIN: 'https://host.example' } });
  assert.equal((await f.request('/api/browser/trusted')).body.devices.length, 1);
  assert.equal(f.children.length, 0); assert.equal(f.publicState().browser.waiting, false);
  assert.equal((await f.request('/api/stream/stop', {})).code, 202);
  const restart = createTrustedDevices({ filename }); await restart.ready; assert.equal(restart.snapshot().paused, true);
  const denied = await fetch(`http://127.0.0.1:${f.port}/api/browser/trusted`, { method: 'POST',
    headers: { Origin: 'https://host.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
  assert.equal(denied.status, 403);
  assert.equal((await f.request('/api/browser/trusted', { action: 'resume' })).body.paused, false);
  assert.equal(f.children.length, 0);
});

for(const reason of ['user-stop','permission-lost'])test('native '+reason+' durably pauses existing remembered grants',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dskcpy-native-stop-trust-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const filename=path.join(dir,'devices.json'),store=createTrustedDevices({filename});await store.ready;
 await store.approve({id:'b'.repeat(32),digest:deviceDigest('y'.repeat(43)),name:'Synthetic browser',origin:'https://host.example',profile:{maxSize:1600,maxFps:30,bitRateMbps:8}});
 await store.pause(false);
 const f=await fixture(t,{platform:'darwin',trustedDevicesPath:filename,readinessProbe:async()=>({...ready,features:{browserCaptureRecovery:true}})});
 const {body}=await f.request('/api/browser/invite',{}),ws=new WebSocket(body.url.replace('http:','ws:')+'stream',{origin:body.url.slice(0,-1)});
 ws.on('error',()=>{});t.after(()=>ws.terminate());await once(ws,'open');ws.send(body.key);await waitFor(()=>f.children.length===1);
 const ended=once(ws,'close');f.children[0].child.stdout.write('DSKCPY_CAPTURE_END '+reason+'\n');f.children[0].child.exit(reason==='user-stop'?0:2);await ended;
 const status=(await f.request('/api/browser/trusted')).body;
 assert.equal(status.paused,true);assert.equal(status.storageError,false);
 assert.equal(JSON.parse(await readFile(filename,'utf8')).paused,true);
 const reloaded=createTrustedDevices({filename});await reloaded.ready;assert.equal(reloaded.snapshot().paused,true);
 assert.equal(f.children.length,1);
});

test('current native child focus metadata reaches only its capable browser and is not logged',async t=>{
  const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
  const browserPort=reserve.address().port;await new Promise(r=>reserve.close(r));
  const origin='https://viewer.example.test';
  const f=await fixture(t,{platform:'darwin',browserPort,
    environment:{...process.env,SCRCPY_GUI_BINARY:process.execPath,DSKCPY_VIEWER_ORIGIN:origin},
    readinessProbe:async()=>({...ready,features:{browserKeyboard:true,browserTextFocus:true}})});
  const {body}=await f.request('/api/browser/invite',{browserTransport:'wifi'});assert.equal(f.children.length,0);
  const ws=new WebSocket(`ws://127.0.0.1:${browserPort}/stream`,{origin,headers:{Host:'viewer.example.test'}});
  ws.on('error',()=>{});t.after(()=>ws.terminate());const messages=[];
  ws.on('message',(data,binary)=>{if(!binary)messages.push(JSON.parse(data));});
  await once(ws,'open');ws.send(body.key);await waitFor(()=>f.children.length===1);
  const child=f.children[0];assert.ok(child.args.includes('--reverse-text-focus'));
  const port=Number(child.args.find(x=>x.startsWith('--reverse-socket=')).split('=')[1]);
  const native=net.connect(port,'127.0.0.1');native.on('error',()=>{});t.after(()=>native.destroy());await once(native,'connect');
  native.write(Buffer.from('535244310000000100000280000001e0','hex'));
  await waitFor(() => messages.some(m => m.type === 'authenticated'));
  const subscribed = once(native, 'data');
  ws.send('text-focus-subscribe'); ws.send(Buffer.from([8,2,0,0,0])); await subscribed;
  child.child.stdout.write('DSKCPY_TEXT_');child.child.stdout.write('FOCUS 1\n');
  await waitFor(()=>messages.some(m=>m.type==='text-focus'));
  assert.deepEqual(messages.find(m=>m.type==='text-focus'),{type:'text-focus',focused:true});
  child.child.stdout.write('DSKCPY_TEXT_FOCUS never-forward-this\n');
  assert.equal(f.publicState().logs.some(x=>x.message.includes('DSKCPY_TEXT_FOCUS')||x.message.includes('never-forward')),false);
  await f.request('/api/stream/stop',{});
});


test('Windows browser keyboard is authenticated and fixed status IPC is not logged',async t=>{
 const reserve=net.createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');
 const browserPort=reserve.address().port;await new Promise(r=>reserve.close(r));
 const origin='https://viewer.example.test';
 const directory=await mkdtemp(path.join(os.tmpdir(),'dskcpy-windows-host-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const binary=path.join(directory,'fixture.exe');await writeFile(binary,'fake executable, never launched',{mode:0o755});
 const f=await fixture(t,{platform:'win32',browserPort,
  environment:{...process.env,SCRCPY_GUI_BINARY:binary,DSKCPY_VIEWER_ORIGIN:origin},
  readinessProbe:async()=>({...ready,features:{browserKeyboard:true,browserTextFocus:false}})});
 const {body,code}=await f.request('/api/browser/invite',{browserTransport:'wifi'});assert.equal(code,201);assert.equal(f.children.length,0);
 const ws=new WebSocket(`ws://127.0.0.1:${browserPort}/stream`,{origin,headers:{Host:'viewer.example.test'}});
 ws.on('error',()=>{});t.after(()=>ws.terminate());const messages=[];
 ws.on('message',(data,binary)=>{if(!binary)messages.push(JSON.parse(data));});
 await once(ws,'open');ws.send(body.key);await waitFor(()=>f.children.length===1);
 const child=f.children[0];assert.ok(child.args.includes('--reverse-keyboard'));assert.equal(child.args.includes('--reverse-text-focus'),false);
 ws.send('keyboard-status-subscribe');
 const port=Number(child.args.find(x=>x.startsWith('--reverse-socket=')).split('=')[1]);
 const native=net.connect(port,'127.0.0.1');native.on('error',()=>{});t.after(()=>native.destroy());await once(native,'connect');
 native.write(Buffer.from('535244310000000100000280000001e0','hex'));
 child.child.stdout.write('DSKCPY_KEYBOARD_STA');child.child.stdout.write('TUS blocked\n');
 await waitFor(()=>messages.some(m=>m.type==='keyboard-status'));
 assert.deepEqual(messages.find(m=>m.type==='keyboard-status'),{type:'keyboard-status',status:'blocked'});
 child.child.stdout.write('DSKCPY_KEYBOARD_STATUS private-sample\n');
 assert.equal(f.publicState().logs.some(x=>x.message.includes('DSKCPY_KEYBOARD_STATUS')||x.message.includes('private-sample')),false);
 await f.request('/api/stream/stop',{});
});

test('owner clipboard consent reaches native only for a capable full desktop private invitation', async t => {
  for (const [consent,capable,expected] of [[true,true,true],[false,true,false],[true,false,false]]) {
    const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const browserPort=reservation.address().port;await new Promise(r=>reservation.close(r));
    const origin='https://clipboard.example.test';
    const f=await fixture(t,{platform:'darwin',browserPort,environment:{...process.env,SCRCPY_GUI_BINARY:process.execPath,DSKCPY_VIEWER_ORIGIN:origin},readinessProbe:async()=>({...ready,features:{browserKeyboard:true,browserClipboard:capable}})});
    const {body}=await f.request('/api/browser/invite',{browserTransport:'wifi',browserClipboard:consent});
    const ws=new WebSocket(`ws://127.0.0.1:${browserPort}/stream`,{origin,headers:{Host:'clipboard.example.test'}});ws.on('error',()=>{});t.after(()=>ws.terminate());
    await once(ws,'open');ws.send(body.key);await waitFor(()=>f.children.length===1);
    assert.equal(f.children[0].args.includes('--reverse-clipboard'),expected);
    assert.ok(!JSON.stringify(f.publicState()).includes('clipboard text'));
    await f.request('/api/stream/stop',{});ws.terminate();
  }
});

test('controller prepares an owned HTTPS receiver without granting access or launching native capture', async t => {
  const f = await fixture(t, { environment: { ...process.env, SCRCPY_GUI_BINARY: process.execPath, DSKCPY_VIEWER_ORIGIN: 'https://owned.test.ts.net:8443' } });
  const result = await f.request('/api/browser/prepare', { mode: 'internet' });
  assert.equal(result.code, 200); assert.equal(result.body.url, 'https://owned.test.ts.net:8443/'); assert.match(result.body.instance, /^[a-f0-9]{32}$/);
  assert.equal(f.children.length, 0); assert.equal(f.publicState().running, false); assert.equal(f.publicState().browser.waiting, false);
  assert.ok(!JSON.stringify(f.publicState()).includes(result.body.instance));
  const invalid = await f.request('/api/browser/prepare', { mode: 'usb' }); assert.equal(invalid.code, 400);
  await f.request('/api/browser/invite', { browserTransport: 'local' });
  assert.equal((await f.request('/api/browser/prepare', { mode: 'internet' })).code, 400);
});
