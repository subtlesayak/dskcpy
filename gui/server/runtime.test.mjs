import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { inspectReadiness, resolveRuntime } from './runtime.mjs';

async function files(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-runtime-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy');
  await writeFile(binary, 'fixture');
  await chmod(binary, 0o755);
  return { dir, binary };
}

test('custom binary uses colocated assets and explicit overrides remain intact', async (t) => {
  const { dir, binary } = await files(t);
  const defaults = resolveRuntime('/unused-repo', { SCRCPY_GUI_BINARY: binary });
  assert.equal(defaults.env.SCRCPY_REVERSE_DISPLAY_APK, path.join(dir, 'reverse-display.apk'));
  assert.equal(defaults.env.SCRCPY_SERVER_PATH, path.join(dir, 'scrcpy-server'));
  const apk = path.join(dir, 'other.apk');
  const server = path.join(dir, 'other-server');
  const result = resolveRuntime(dir, { SCRCPY_GUI_BINARY: binary,
    SCRCPY_REVERSE_DISPLAY_APK: apk, SCRCPY_SERVER_PATH: server, SCRCPY_ICON_DIR: dir });
  assert.equal(result.env.SCRCPY_REVERSE_DISPLAY_APK, apk);
  assert.equal(result.env.SCRCPY_SERVER_PATH, server);
  assert.equal(result.env.SCRCPY_ICON_DIR, dir);
});

test('PATH discovery is real and a missing executable is never reported available', async (t) => {
  const { dir, binary } = await files(t);
  const runtime = resolveRuntime(dir, { PATH: dir });
  assert.equal(runtime.executable, binary);
  assert.equal(resolveRuntime(dir, { PATH: '' }).executable, null);
  assert.equal(resolveRuntime(dir, { SCRCPY_GUI_BINARY: path.join(dir, 'missing') }).executable, null);
});

test('build-directory binaries resolve sibling artifacts', async (t) => {
  const { dir } = await files(t);
  await mkdir(path.join(dir, 'app'));
  const binary = path.join(dir, 'app', process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy');
  await writeFile(binary, 'fixture'); await chmod(binary, 0o755);
  assert.equal(resolveRuntime(dir, { SCRCPY_GUI_BINARY: binary }).env.SCRCPY_REVERSE_DISPLAY_APK,
    path.join(dir, 'server', 'reverse-display.apk'));
});

test('runtime loading, fork support, companion and ADB are independent checks', async (t) => {
  const { dir, binary } = await files(t);
  const runtime = resolveRuntime(dir, { SCRCPY_GUI_BINARY: binary, ADB: binary });
  runtime.platform = 'win32';
  const probe = async () => ({ stdout: '--reverse-display --reverse-socket' });
  let status = await inspectReadiness(runtime, probe);
  assert.equal(status.transports.internet.ready, true);
  assert.equal(status.transports.usb.ready, false);
  await writeFile(runtime.env.SCRCPY_REVERSE_DISPLAY_APK, 'signed APK fixture');
  status = await inspectReadiness(runtime, probe);
  assert.equal(status.transports.usb.ready, true);
  status = await inspectReadiness(runtime, async () => { throw new Error('missing DLL'); });
  assert.equal(status.transports.internet.ready, false);
  assert.equal(status.checks.find((c) => c.id === 'binary').ready, true);
  assert.equal(status.checks.find((c) => c.id === 'runtime').ready, false);
  status = await inspectReadiness(runtime, async () => ({ stdout: 'ordinary upstream build' }));
  assert.equal(status.checks.find((c) => c.id === 'capture').ready, false);
});

test('Mac readiness requires the compiled opt-in marker, not just upstream reverse flags', async (t) => {
  const { dir, binary } = await files(t);
  const runtime = resolveRuntime(dir, { SCRCPY_GUI_BINARY: binary, ADB: binary });
  runtime.platform = 'darwin';
  const flags = '--reverse-display --reverse-socket';
  let status = await inspectReadiness(runtime, async () => ({ stdout: flags }));
  assert.equal(status.transports.internet.ready, false);
  assert.match(status.checks.find((c) => c.id === 'capture').message, /reverse_macos=true/);
  const probe = async () => ({ stdout: `${flags} ScreenCaptureKit/VideoToolbox` });
  status = await inspectReadiness(runtime, probe);
  assert.equal(status.transports.internet.ready, true);
  assert.equal(status.transports.usb.ready, false);
  assert.match(status.checks.find((c) => c.id === 'capture').message, /audio forwarding is experimental/);
  await writeFile(runtime.env.SCRCPY_REVERSE_DISPLAY_APK, 'APK fixture');
  status = await inspectReadiness(runtime, probe);
  for (const mode of ['usb', 'wifi', 'ip']) assert.equal(status.transports[mode].ready, true);
  runtime.platform = 'linux';
  status = await inspectReadiness(runtime, probe);
  assert.equal(status.transports.internet.ready, false);
});

test('ADB readiness distinguishes a missing installation from a found executable that cannot start', async (t) => {
  const { dir, binary } = await files(t);
  const runtime = resolveRuntime(dir, { SCRCPY_GUI_BINARY: binary, ADB: binary });
  const failed = await inspectReadiness(runtime, async () => { throw new Error('private user-directory failure'); });
  const adb = failed.checks.find((check) => check.id === 'adb');
  assert.equal(adb.ready, false);
  assert.match(adb.message, /found but could not start/);
  assert.ok(!adb.message.includes('private user-directory failure'));
  const missing = resolveRuntime(dir, { SCRCPY_GUI_BINARY: binary, ADB: path.join(dir, 'missing-adb.exe') });
  const absent = await inspectReadiness(missing, async () => ({ stdout: '' }));
  assert.match(absent.checks.find((check) => check.id === 'adb').message, /Install or configure/);
});

test('ADB SDK discovery supports SDK_ROOT while keeping explicit ADB and ANDROID_HOME authoritative', async (t) => {
  const { dir } = await files(t);
  const sdk = path.join(dir, 'SDK with spaces');
  const adb = path.join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  await mkdir(path.dirname(adb), { recursive: true });
  await writeFile(adb, 'fixture'); await chmod(adb, 0o755);
  assert.equal(resolveRuntime(dir, { ANDROID_SDK_ROOT: sdk }).adb, adb);
  assert.equal(resolveRuntime(dir, { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: '/missing' }).adb, adb);
  assert.equal(resolveRuntime(dir, { ANDROID_HOME: '/missing', ANDROID_SDK_ROOT: sdk }).adb, null);
  assert.equal(resolveRuntime(dir, { ADB: '/missing-adb', ANDROID_HOME: sdk }).adb, null);
  assert.equal(resolveRuntime(dir, { PATH: path.dirname(adb) }).adb, adb);
});
