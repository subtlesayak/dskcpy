import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { developmentWindowsConfiguration, developmentWindowsTarget, prepareWindowsDevelopmentInstaller } from '../package-windows-installer.mjs';

const manifest = () => ({ platform: 'win32', architecture: 'x64', product: 'dskcpy-host-desktop-development',
  sourceCommit: 'a'.repeat(40), sourceModified: false, qualification: { publicReleaseReady: false },
  usbRuntime: { linkage: { architecture: 'x86' }, files: ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'] } });
const options = { platform: 'win32', architecture: 'x64', development: true };

test('installer preflight requires native Windows x64, explicit intent and identified clean source', () => {
  assert.doesNotThrow(() => developmentWindowsTarget(manifest(), options));
  assert.throws(() => developmentWindowsTarget(manifest(), { ...options, development: false }), /--development/);
  for (const platform of ['darwin', 'linux']) assert.throws(() => developmentWindowsTarget(manifest(), { ...options, platform }), /native Windows/);
  for (const architecture of ['arm64', 'ia32']) assert.throws(() => developmentWindowsTarget(manifest(), { ...options, architecture }), /native Windows/);
  for (const patch of [{ sourceModified: true }, { sourceCommit: '' }, { platform: 'darwin' }, { architecture: 'arm64' }, { qualification: { publicReleaseReady: true } }])
    assert.throws(() => developmentWindowsTarget({ ...manifest(), ...patch }, options), /identified Windows/);
});

test('x86 USB runtime remains distinct from the x64 host and requires both USB libraries', () => {
  for (const missing of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
    const value = manifest(); value.usbRuntime.files = value.usbRuntime.files.filter(file => file !== missing);
    assert.throws(() => developmentWindowsTarget(value, options), /pinned x86 USB runtime/);
  }
  const wrong = manifest(); wrong.usbRuntime.linkage.architecture = 'x64';
  assert.throws(() => developmentWindowsTarget(wrong, options), /pinned x86 USB runtime/);
});

test('development NSIS plan is per-user, preserves app data and disables signing for every executable artifact', () => {
  const stage = path.resolve('test-stage'), output = path.resolve('new-installer-output');
  const config = developmentWindowsConfiguration(stage, output);
  assert.equal(config.appId, 'com.dskcpy.host');
  assert.deepEqual(config.directories, { app: path.join(stage, 'app'), output });
  assert.deepEqual(config.extraResources, [{ from: path.join(stage, 'host'), to: 'host' }]);
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }]);
  assert.equal(config.win.signAndEditExecutable, false);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.publish, null);
  assert.deepEqual(config.nsis, { oneClick: true, perMachine: false, allowElevation: false, deleteAppDataOnUninstall: false,
    createDesktopShortcut: true, createStartMenuShortcut: true, runAfterFinish: true });
  assert.match(config.artifactName, /development.*setup/);
  assert.equal(config.mac, undefined);
});

test('refusing a build without development intent preserves selected input and creates no output', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-installer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage'), output = path.join(root, 'new-output');
  await mkdir(stage); await writeFile(path.join(stage, 'sentinel'), 'unchanged');
  await assert.rejects(prepareWindowsDevelopmentInstaller({ stage, output }), /--development/);
  assert.equal(await readFile(path.join(stage, 'sentinel'), 'utf8'), 'unchanged');
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

test('an existing output is refused before builder execution', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-installer-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = path.join(root, 'stage'), output = path.join(root, 'existing');
  await mkdir(stage); await mkdir(output); await writeFile(path.join(output, 'sentinel'), 'keep');
  await assert.rejects(prepareWindowsDevelopmentInstaller({ stage, output, development: true }), /already exists/);
  assert.equal(await readFile(path.join(output, 'sentinel'), 'utf8'), 'keep');
});
