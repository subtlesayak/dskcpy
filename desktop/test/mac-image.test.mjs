import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { developmentImageTarget, inventoryMacBundle, prepareMacDevelopmentImage, verifyMacDeploymentTarget } from '../package-mac-image.mjs';

test('embedded Mach-O minimum must agree with the advertised macOS minimum', () => {
  const build = (version, platform = 'MACOS') => `file (architecture arm64):\nLoad command 13\n  cmd LC_BUILD_VERSION\n  cmdsize 32\n  platform ${platform}\n  minos ${version}\n  sdk 26.5\n`;
  assert.equal(verifyMacDeploymentTarget(build('13.0'), '13.0'), '13.0');
  assert.equal(verifyMacDeploymentTarget(build('12.10'), '13.0'), '12.10');
  assert.equal(verifyMacDeploymentTarget('Load command 2\n cmd LC_VERSION_MIN_MACOSX\n version 10.14\n sdk 10.15\n', '13.0'), '10.14');
  assert.throws(() => verifyMacDeploymentTarget(build('13.0.1'), '13.0'), /above bundle minimum/);
  assert.throws(() => verifyMacDeploymentTarget(build('13.0', 'IOS'), '13.0'), /macOS Mach-O/);
  assert.throws(() => verifyMacDeploymentTarget('', '13.0'), /Expected one/);
  assert.throws(() => verifyMacDeploymentTarget(build('13.0'), undefined), /LSMinimumSystemVersion/);
});

function candidate(architecture = 'arm64') {
  const macho = architecture === 'arm64' ? 'arm64' : 'x86_64';
  return { platform: 'darwin', architecture, linkage: { architecture: macho }, usbRuntime: { linkage: { architecture: macho } },
    product: 'dskcpy-host-desktop-development', sourceCommit: 'a'.repeat(40), sourceModified: false, qualification: { publicReleaseReady: false } };
}
const info = { CFBundleIdentifier: 'com.dskcpy.host', CFBundleVersion: '0.1.0' };
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-image-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('development image requires explicit intent and matching native host/ADB architecture', () => {
  for (const architecture of ['arm64', 'x64']) {
    const options = { platform: 'darwin', architecture, development: true };
    assert.equal(developmentImageTarget(info, candidate(architecture), options).architecture, architecture);
    assert.throws(() => developmentImageTarget(info, candidate(architecture), { ...options, development: false }), /--development/);
    assert.throws(() => developmentImageTarget(info, candidate(architecture === 'arm64' ? 'x64' : 'arm64'), options), /matching/);
    assert.throws(() => developmentImageTarget(info, { ...candidate(architecture), usbRuntime: { linkage: { architecture: 'wrong' } } }, options), /matching/);
    assert.throws(() => developmentImageTarget(info, candidate(architecture), { ...options, platform: 'win32' }), /native macOS/);
  }
});

test('unknown app identity, dirty source and release-like inputs cannot be relabelled as a development image', () => {
  const options = { platform: 'darwin', architecture: 'arm64', development: true };
  for (const change of [{ CFBundleIdentifier: 'com.other.app' }, { CFBundleVersion: '../file' }])
    assert.throws(() => developmentImageTarget({ ...info, ...change }, candidate(), options), /identity/);
  for (const change of [{ sourceModified: true }, { sourceCommit: '' }, { qualification: { publicReleaseReady: true } }, { product: 'unrelated' }])
    assert.throws(() => developmentImageTarget(info, { ...candidate(), ...change }, options), /unmodified development/);
});

test('bundle inventory detects byte, executable-mode and internal framework-link changes', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t);
  await mkdir(path.join(root, 'Versions/A'), { recursive: true });
  await writeFile(path.join(root, 'Versions/A/runtime'), 'original');
  await chmod(path.join(root, 'Versions/A/runtime'), 0o755);
  await symlink('A', path.join(root, 'Versions/Current'));
  await symlink('Versions/Current/runtime', path.join(root, 'runtime'));
  const original = await inventoryMacBundle(root);
  assert.deepEqual(original.filter(entry => entry.link).map(entry => entry.link), ['A', 'Versions/Current/runtime']);
  assert.equal(original.find(entry => entry.path === 'Versions/A/runtime').mode, 0o755);
  await writeFile(path.join(root, 'Versions/A/runtime'), 'modified');
  const changed = await inventoryMacBundle(root);
  assert.notEqual(changed.find(entry => entry.sha256).sha256, original.find(entry => entry.sha256).sha256);
  await chmod(path.join(root, 'Versions/A/runtime'), 0o644);
  assert.equal((await inventoryMacBundle(root)).find(entry => entry.path === 'Versions/A/runtime').mode, 0o644);
});

test('external and broken links are rejected without reading their target contents', { skip: process.platform === 'win32' }, async t => {
  const parent = await temporary(t), app = path.join(parent, 'app');
  await mkdir(app);
  await writeFile(path.join(parent, 'private-file'), 'not part of the app');
  await symlink('../private-file', path.join(app, 'escape'));
  await assert.rejects(inventoryMacBundle(app), /escapes the bundle/);
  assert.equal(await readFile(path.join(parent, 'private-file'), 'utf8'), 'not part of the app');
  await rm(path.join(app, 'escape'));
  await symlink('missing', path.join(app, 'broken'));
  await assert.rejects(inventoryMacBundle(app), { code: 'ENOENT' });
});

test('missing development intent cannot create an output or alter a selected app', async t => {
  const root = await temporary(t), app = path.join(root, 'dskcpy Host.app'), output = path.join(root, 'new-output');
  await mkdir(app); await writeFile(path.join(app, 'sentinel'), 'unchanged');
  await assert.rejects(prepareMacDevelopmentImage({ app, output }), /--development/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(app, 'sentinel'), 'utf8'), 'unchanged');
});

test('existing output and output inside the app are refused before copying or image tools', { skip: process.platform !== 'darwin' }, async t => {
  const root = await temporary(t), app = path.join(root, 'dskcpy Host.app'), output = path.join(root, 'existing');
  await mkdir(app); await mkdir(output); await writeFile(path.join(output, 'sentinel'), 'keep');
  await assert.rejects(prepareMacDevelopmentImage({ app, output, development: true }), /already exists/);
  await assert.rejects(prepareMacDevelopmentImage({ app, output: path.join(app, 'output'), development: true }), /outside/);
  assert.equal(await readFile(path.join(output, 'sentinel'), 'utf8'), 'keep');
});
