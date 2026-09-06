import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createControlService } from './service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binary = path.resolve(root, process.env.SCRCPY_LOG_PIPE_TEST_BINARY ||
  (process.platform === 'win32' ? '.tmp/x-tests/app/log-pipe-fixture.exe' : 'build-macos/app/log-pipe-fixture'));

test('native buffered-pipe telemetry updates the dashboard BEFORE process exit', {
  skip: !process.env.SCRCPY_LOG_PIPE_TEST_BINARY && !existsSync(binary), timeout: 10000,
}, async t => {
  assert.ok(existsSync(binary), 'Explicit logger fixture override must exist');
  const children = [];
  const service = createControlService({
    platform: 'darwin', configuredPort: 0,
    environment: { ...process.env, SCRCPY_GUI_BINARY: process.execPath },
    commandRunner: async () => ({ stdout: '' }),
    readinessProbe: async () => ({ checks: [{ id: 'binary', ready: true }, { id: 'capture', ready: true }],
      transports: { wifi: { ready: true } } }),
    // Only a no-capture logger fixture runs. No ADB, Mac SDK or actual stream.
    spawnProcess: (exe, args, options) => {
      const env = { ...options.env };
      if (process.platform === 'win32') {
        const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
        env[key] = `C:/msys64/mingw64/bin;${env[key] || ''}`;
      }
      const child = spawn(binary, [], { ...options, env });
      children.push(child);
      return child;
    },
  });
  const port = await service.listen();
  t.after(async () => { await service.shutdown(); for (const child of children) if (child.exitCode === null) child.kill(); });
  async function post(route, body = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok);
    return response.json();
  }
  async function until(predicate, message) {
    for (let n = 0; n < 100; n++) {
      if (predicate()) return;
      assert.ok(children.every(child => child.exitCode === null), 'Logger fixture exited before telemetry arrived');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail(message);
  }
  const config = { connection: 'wifi', serial: 'fixture._adb-tls-connect._tcp' };
  await post('/api/stream/start', config);
  assert.equal(service.publicState().latencyMs, null);
  children[0].stdin.write('e');
  await until(() => service.publicState().encoder === 'h264_videotoolbox', 'Encoder must arrive while the child is still running, not on exit');
  assert.equal(service.publicState().latencyMs, null, 'Do not manufacture a latency from encoder readiness');
  children[0].stdin.write('m');
  await until(() => service.publicState().latencyMs === 12.5, 'Decode-ack telemetry must arrive without waiting for the stdout buffer to fill');
  assert.equal(children[0].exitCode, null);
  assert.equal(service.publicState().running, true);
  await post('/api/stream/stop');
  await until(() => !service.publicState().running, 'Stop must complete');
  assert.equal(service.publicState().latencyMs, 12.5, 'Retain the last measurement after Stop');
  await post('/api/stream/start', config);
  assert.equal(service.publicState().latencyMs, null, 'A new stream must not inherit the old measurement');
  assert.equal(service.publicState().encoder, null);
  await post('/api/stream/stop');
});
