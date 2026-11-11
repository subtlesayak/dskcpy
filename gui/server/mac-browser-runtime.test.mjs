import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyMacBrowserRuntime } from '../scripts/mac-browser-runtime.mjs';

const capabilities = '--reverse-display --reverse-socket ScreenCaptureKit/VideoToolbox';
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-mac-preflight-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'owned-host');
  await writeFile(binary, 'owned fixture; probe is injected'); await chmod(binary, 0o755);
  return { dir, binary, environment: { SCRCPY_GUI_BINARY: binary, PATH: '' } };
}

test('Mac browser preflight rejects directory, missing and empty overrides without probing or fallback', async t => {
  const f = await fixture(t); let calls = 0;
  for (const value of [f.dir, path.join(f.dir, 'missing'), '', ' ']) {
    await assert.rejects(verifyMacBrowserRuntime(f.dir, { ...f.environment, SCRCPY_GUI_BINARY: value }, async () => { calls++; }), /executable Mac/);
  }
  assert.equal(calls, 0);
});

test('Mac browser preflight rejects non-executable files without probing', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await chmod(f.binary, 0o644); let calls = 0;
  await assert.rejects(verifyMacBrowserRuntime(f.dir, f.environment, async () => { calls++; }), /executable Mac/);
  assert.equal(calls, 0);
});

test('Mac browser preflight bounds help and rejects ordinary or non-Mac backends', async t => {
  const f = await fixture(t);
  for (const stdout of ['ordinary upstream scrcpy', '--reverse-display --reverse-socket']) {
    const calls = [];
    await assert.rejects(verifyMacBrowserRuntime(f.dir, f.environment, async (exe, args, options) => {
      calls.push(args); assert.equal(exe, f.binary); assert.equal(options.timeout, 5000);
      assert.equal(options.killSignal, 'SIGKILL');
      assert.equal(options.maxBuffer, 1024 * 1024); return { stdout };
    }), /reverse_macos=true/);
    assert.deepEqual(calls, [['--help']]);
  }
});

test('Mac browser preflight reports loader failures without private diagnostics', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyMacBrowserRuntime(f.dir, f.environment, async () => { throw new Error('PRIVATE loader path'); }), error => {
    assert.match(error.message, /could not load/); assert.ok(!error.message.includes('PRIVATE')); return true;
  });
});

test('a real unresponsive help-only child is killed at the preflight deadline', {
  skip: process.platform === 'win32' || /\s/.test(process.execPath),
}, async t => {
  const f = await fixture(t);
  await writeFile(f.binary, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`);
  const started = performance.now();
  await assert.rejects(verifyMacBrowserRuntime(f.dir, { ...process.env,
    SCRCPY_GUI_BINARY: f.binary, ADB: path.join(f.dir, 'no-adb'),
  }), /could not load/);
  assert.ok(performance.now() - started < 15000, 'The help child must not remain alive indefinitely');
});

test('Mac browser preflight preserves working explicit and PATH selection and default source build', async t => {
  const f = await fixture(t);
  for (const environment of [f.environment, { SCRCPY_GUI_BINARY: 'owned-host', PATH: f.dir }]) {
    const calls = [];
    const result = await verifyMacBrowserRuntime(f.dir, environment, async (_exe, args) => { calls.push(args); return { stdout: capabilities }; });
    assert.equal(result.executable, f.binary); assert.deepEqual(calls, [['--help']]);
  }
  const build = path.join(f.dir, 'build-macos/app'); await mkdir(build, { recursive: true });
  const binary = path.join(build, 'scrcpy'); await writeFile(binary, 'owned default'); await chmod(binary, 0o755);
  const result = await verifyMacBrowserRuntime(f.dir, { PATH: '' }, async () => ({ stdout: capabilities }));
  assert.equal(result.executable, binary);
});

test('actual Mac browser check rejects invalid native overrides before reaching VPN discovery', { skip: process.platform !== 'darwin' }, async t => {
  const f = await fixture(t), execute = promisify(execFile);
  const script = fileURLToPath(new URL('../scripts/start-browser-macos.mjs', import.meta.url));
  await chmod(f.binary, 0o644);
  for (const value of [f.dir, path.join(f.dir, 'missing'), f.binary]) {
    await assert.rejects(execute(process.execPath, [script, '--check'], {
      env: { ...process.env, SCRCPY_GUI_BINARY: value }, timeout: 10000,
    }), error => { assert.equal(error.code, 1); assert.match(error.stderr, /executable Mac/); assert.equal(error.stdout, ''); return true; });
  }
  await assert.rejects(execute(process.execPath, [script, '--check'], {
    env: { ...process.env, SCRCPY_GUI_BINARY: '/usr/bin/true' }, timeout: 10000,
  }), error => { assert.equal(error.code, 1); assert.match(error.stderr, /reverse_macos=true/); assert.equal(error.stdout, ''); return true; });
});
