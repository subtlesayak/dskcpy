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

test('launcher health endpoint exposes only app identity and does not probe or start programs', async (t) => {
  let probes = 0;
  const f = await fixture(t, { readinessProbe: async () => { probes++; return ready; } });
  const response = await f.request('/api/health');
  assert.equal(response.code, 200);
  assert.deepEqual(response.body, { app: 'dskcpy', apiVersion: 1 });
  assert.equal(probes, 0);
  assert.equal(f.children.length, 0);
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
  assert.equal(f.children.length, 0);
  await f.request('/api/stream/stop', {});
  await waitFor(() => commands.some((args) => args.includes('--remove')));
  assert.deepEqual(commands.find((args) => args.includes('--remove')), ['-s', 'test-usb', 'reverse', '--remove', reverse[4]]);
  assert.ok(!commands.flat().includes('--remove-all'));
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
