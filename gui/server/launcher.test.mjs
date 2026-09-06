import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkInstallation, launch, parseOptions, probeDashboard } from '../scripts/launch.mjs';

const ready = { checks: [{ label: 'Streaming program', ready: true }], transports: { browser: { ready: true } } };

function fixture(overrides = {}) {
  const calls = [], messages = [];
  const service = {
    listen: async () => calls.push('listen'),
    shutdown: async () => calls.push('shutdown'),
  };
  const options = {
    environment: {}, probe: async () => 'free',
    inspect: async () => calls.push('inspect'), readiness: async () => ready,
    createService: async (config) => { calls.push(config); return service; },
    open: async (url) => calls.push(url), log: (message) => messages.push(message), ...overrides,
  };
  return { calls, messages, service, options };
}

test('launcher validates ports and flags without reflecting invalid values', () => {
  for (const value of ['', '0', '-1', '65536', 'NaN', '27183/path', 'private-value']) {
    assert.throws(() => parseOptions([], { DISPLAY_BRIDGE_PORT: value }), /port number/);
  }
  assert.throws(() => parseOptions(['--unsafe-value']), /Unknown option/);
  assert.equal(parseOptions([], {}).port, 27183);
  assert.equal(parseOptions(['--no-open'], { DISPLAY_BRIDGE_PORT: '29183' }).open, false);
});

test('running dashboard is reused without readiness probes, spawn, stop or environment changes', async () => {
  const f = fixture({ probe: async () => 'dskcpy' });
  const result = await launch(f.options);
  assert.equal(result.reused, true);
  assert.deepEqual(f.calls, ['http://127.0.0.1:27183']);
});

test('occupied or unresponsive port never starts or stops anything', async () => {
  const f = fixture({ probe: async () => 'occupied' });
  await assert.rejects(launch(f.options), /Nothing was stopped/);
  assert.deepEqual(f.calls, []);
});

test('check and help never start a service, open a browser or capture', async () => {
  const f = fixture({ args: ['--check'] });
  assert.equal((await launch(f.options)).exitCode, 0);
  assert.deepEqual(f.calls, ['inspect']);
  f.calls.length = 0;
  await launch({ ...f.options, args: ['--help'] });
  assert.deepEqual(f.calls, []);
  const failed = { ...ready, transports: { browser: { ready: false } } };
  assert.equal((await launch({ ...f.options, readiness: async () => failed })).exitCode, 1);
});

test('check reports local components even if an existing dashboard is running', async () => {
  const f = fixture({ args: ['--check'], probe: async () => 'dskcpy' });
  await launch(f.options);
  assert.deepEqual(f.calls, ['inspect']);
  assert.ok(f.messages.some((message) => /left unchanged/.test(message)));
});

test('launcher preserves explicit configuration and opens only the configured loopback controller', async () => {
  const environment = Object.freeze({ DISPLAY_BRIDGE_PORT: '29183', ADB: 'SDK with spaces/adb.exe',
    SCRCPY_GUI_BINARY: 'build with spaces/scrcpy.exe', DSKCPY_VIEWER_ORIGIN: 'https://host.example',
    DSKCPY_VIEWER_TLS_KEY: 'private-key-file', SCRCPY_RUNTIME_DIR: 'runtime' });
  const f = fixture({ environment });
  const result = await launch(f.options);
  assert.equal(result.service, f.service);
  assert.deepEqual(f.calls[1], { environment, configuredPort: 29183 });
  assert.notEqual(f.calls[1].environment, environment);
  assert.deepEqual(f.calls.slice(2), ['listen', 'http://127.0.0.1:29183']);
  assert.ok(!f.messages.join('').includes('private-key-file'));
  assert.ok(!f.messages.join('').includes('host.example'));
});

test('no-open keeps the service available without opening a browser', async () => {
  const f = fixture({ args: ['--no-open'] });
  assert.equal((await launch(f.options)).service, f.service);
  assert.equal(f.calls.at(-1), 'listen');
});

test('browser launch failure leaves the service running and prints a manual link', async () => {
  const f = fixture({ open: async () => { throw new Error('private system details'); } });
  assert.equal((await launch(f.options)).service, f.service);
  assert.ok(!f.calls.includes('shutdown'));
  assert.match(f.messages.join('\n'), /Open the dashboard address/);
  assert.ok(!f.messages.join('').includes('private system details'));
});

test('missing native components still allow dashboard diagnostics but not a passing check', async () => {
  const f = fixture({ readiness: async () => ({ checks: [{ label: 'Program', ready: false, message: 'Build this fork.' }],
    transports: { browser: { ready: false } } }) });
  assert.equal((await launch(f.options)).service, f.service);
  assert.match(f.messages.join('\n'), /CHECK - Program: Build this fork/);
});

test('simultaneous launchers close only their own unbound server and reuse the winner', async () => {
  let probes = 0;
  const f = fixture({ probe: async () => ++probes === 1 ? 'free' : 'dskcpy' });
  f.service.listen = async () => { throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' }); };
  assert.equal((await launch(f.options)).reused, true);
  assert.deepEqual(f.calls.slice(-2), ['shutdown', 'http://127.0.0.1:27183']);
});

test('startup failure closes the owned service without opening a browser', async () => {
  const f = fixture();
  f.service.listen = async () => { throw new Error('startup failure'); };
  await assert.rejects(launch(f.options), /startup failure/);
  assert.equal(f.calls.at(-1), 'shutdown');
});

test('installation checks Node, dependencies and built assets including paths with spaces', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy launcher '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(checkInstallation(dir, '22.11.0'), /Node.js 22.12/);
  await assert.rejects(checkInstallation(dir, '24.0.0'), /dependencies are missing/);
  const dep = path.join(dir, 'gui/node_modules/ws');
  await mkdir(dep, { recursive: true });
  await writeFile(path.join(dep, 'index.js'), '');
  await assert.rejects(checkInstallation(dir, '22.12.0'), /not built/);
  await mkdir(path.join(dir, 'gui/dist'));
  await writeFile(path.join(dir, 'gui/dist/index.html'), '<html></html>');
  await checkInstallation(dir, '24.0.0');
});

async function httpFixture(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return server.address().port;
}

test('health probe accepts exact identity without requesting private status', async (t) => {
  const port = await httpFixture(t, (req, res) => {
    assert.equal(req.url, '/api/health');
    res.end(JSON.stringify({ app: 'dskcpy', apiVersion: 1 }));
  });
  assert.equal(await probeDashboard(port), 'dskcpy');
});

test('health probe bounds stalled, oversized, redirected and unrelated responses', async (t) => {
  for (const respond of [
    (res) => res.end('another application'),
    (res) => res.end('x'.repeat(2048)),
    (res) => res.end(JSON.stringify({ app: 'dskcpy', apiVersion: 2 })),
    (res) => { res.writeHead(302, { Location: 'https://example.invalid' }); res.end(); },
    () => {},
  ]) {
    const port = await httpFixture(t, (_req, res) => respond(res));
    assert.equal(await probeDashboard(port, 100), 'occupied');
  }
});

test('health probe identifies a closed port', async () => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probeDashboard(port), 'free');
});
