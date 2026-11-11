import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inventory, parseIdentity, readIdentity } from './build-identity.mjs';
import { compareUpgrade, inspectApk, inspectInstalled, parseApkIdentity, parseArgs } from './check-android-upgrade.mjs';

const digest = 'ab'.repeat(32);
const badging = (code = 50002) => `package: name='com.genymobile.scrcpy' versionCode='${code}' versionName='0.1.0-dev' platformBuildVersionName='16'\n`;
const certs = `Signer #1 certificate SHA-256 digest: ${digest}\n`;
const apk = (code = 50002) => parseApkIdentity(badging(code), certs);

test('canonical artifact identity exceeds received 50001 while wire version stays 4.1', async () => {
  const identity = await readIdentity();
  assert.equal(identity.scrcpyProtocol, '4.1');
  assert(identity.androidVersionCode > 50001);
  const properties = await readFile(new URL('../dskcpy.properties', import.meta.url), 'utf8');
  for (const invalid of [properties.replace('50002', '40100'), properties + '\nDSKCPY_VERSION=1', properties.replace('4.1', '$(echo secret)')]) {
    assert.throws(() => parseIdentity(invalid));
  }
  const meson = await readFile(new URL('../meson.build', import.meta.url), 'utf8');
  assert(meson.includes(`version: '${identity.scrcpyProtocol}'`));
});

test('upgrades retain package and signer; downgrade, certificate mismatch and malformed identity fail closed', () => {
  assert.equal(compareUpgrade(apk(), apk(50001)).action, 'upgrade');
  assert.equal(compareUpgrade(apk(), apk()).action, 'same-version replacement');
  assert.throws(() => compareUpgrade(apk(40100), apk(50001)), /Downgrade refused/);
  assert.throws(() => compareUpgrade(apk(), { ...apk(), signerSha256: ['cd'.repeat(32)] }), /certificate differs/);
  assert.throws(() => parseApkIdentity(badging().replace('com.genymobile.scrcpy', 'other.app'), certs));
  assert.throws(() => parseApkIdentity(badging(), 'not verified'));
  assert.throws(() => parseApkIdentity(badging('NaN'), certs));
  assert.throws(() => parseArgs(['--apk', 'file', '--sdk-tools', 'sdk', '--device', '--installed-apk', 'old']));
});

test('APK inspection calls signature verification and hashes actual bytes', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-identity-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'candidate.apk');
  await writeFile(file, 'fixture');
  const calls = [];
  const result = await inspectApk(file, temp, async (exe, args, options) => {
    calls.push({ exe, args, options });
    return { stdout: args.includes('badging') ? badging() : certs };
  });
  assert.equal(result.bytes, 7);
  assert.equal(result.sha256.length, 64);
  assert(calls[1].args.includes('verify'));
  assert(!calls.some(({ args }) => args.includes('sign')));
  assert(calls.every(({ options }) => options.timeout === 30000));
});

test('device preflight only reads selected base APK and deletes the private temporary copy on failure', async () => {
  const calls = []; let copy;
  await assert.rejects(inspectInstalled('adb', 'tools', { serial: 'fixture-serial',
    run: async (_exe, args) => {
      calls.push(args);
      if (args.includes('pull')) { copy = args.at(-1); await writeFile(copy, 'private fixture'); }
      return { stdout: 'package:/data/app/fixture/base.apk\npackage:/data/app/fixture/split.apk\n' };
    }, inspect: async () => { throw new Error('fixture mismatch'); },
  }), /fixture mismatch/);
  assert.deepEqual(calls[0], ['-s', 'fixture-serial', 'shell', 'pm', 'path', 'com.genymobile.scrcpy']);
  assert.equal(calls[1][2], 'pull');
  await assert.rejects(readFile(copy), { code: 'ENOENT' });
  assert(!calls.flat().some((arg) => ['install', 'uninstall', '-d'].includes(arg)));
});

test('artifact inventory is relative, deterministic, hashed and refuses symbolic links', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-manifest-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, 'payload'), 'fixture');
  const result = await inventory(temp);
  assert.equal(result[0].path, 'payload');
  assert.equal(result[0].bytes, 7);
  if (process.platform !== 'win32') {
    await symlink('/etc/passwd', path.join(temp, 'link'));
    await assert.rejects(inventory(temp), /symbolic link/);
  }
});
