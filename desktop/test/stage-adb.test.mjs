import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseWindowsAdbDependencies, isWindowsAdbSystemImport, stageAdb } from '../stage-adb.mjs';
function image(name) {
  const bytes = Buffer.alloc(8192);
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(0x14c, 132); bytes.writeUInt16LE(1, 134); bytes.writeUInt16LE(224, 148);
  bytes.writeUInt16LE(0x10b, 152); bytes.writeUInt32LE(16, 244);
  bytes.writeUInt32LE(0x1000, 256); bytes.writeUInt32LE(40, 260);
  bytes.writeUInt32LE(0x1000, 388); bytes.writeUInt32LE(7168, 392); bytes.writeUInt32LE(1024, 396);
  bytes.writeUInt32LE(0x1400, 1036); bytes.write(name + '\0', 2048, 'ascii'); return bytes;
}
test('pinned ADB imports require x86 PE32 and reject mixed architectures and unsafe DLL names', () => {
  assert.deepEqual(parseWindowsAdbDependencies(image('AdbWinApi.dll')), ['adbwinapi.dll']);
  for (const name of ['../bad.dll', 'C:\\bad.dll', 'bad.dll:stream']) assert.throws(() => parseWindowsAdbDependencies(image(name)));
  const x64 = image('kernel32.dll'); x64.writeUInt16LE(0x8664, 132); assert.throws(() => parseWindowsAdbDependencies(x64));
  assert.throws(() => parseWindowsAdbDependencies(image('a.dll').subarray(0, 100)));
});
test('ADB system imports require WOW64 files and do not weaken native host system checks', async () => {
  const checked = [], systemRoot = 'C:\\Windows', stat = async file => { checked.push(file); return { isFile: () => true }; };
  for (const name of ['KERNEL32.dll', 'dbghelp.dll', 'wlanapi.dll', 'winusb.dll']) assert.equal(await isWindowsAdbSystemImport(name, { systemRoot, stat }), true);
  assert.deepEqual(checked, ['kernel32.dll', 'dbghelp.dll', 'wlanapi.dll', 'winusb.dll'].map(name => `C:\\Windows\\SysWOW64\\${name}`));
  for (const name of ['adbwinapi.dll', 'adbwinusbapi.dll', '../winusb.dll']) assert.equal(await isWindowsAdbSystemImport(name, { systemRoot, stat }), false);
  assert.equal(await isWindowsAdbSystemImport('winusb.dll', { systemRoot, stat: async () => { throw Error('missing'); } }), false);
  assert.equal(await isWindowsAdbSystemImport('winusb.dll', { systemRoot: 'relative', stat }), false);
});
test('USB staging rejects missing notices and linked executables before any execution', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-adb-input-'));
  try {
    await writeFile(path.join(dir, 'source'), 'fixture, not executable');
    await symlink(path.join(dir, 'source'), path.join(dir, 'adb'));
    await writeFile(path.join(dir, 'NOTICE.txt'), 'fixture notice');
    await assert.rejects(stageAdb(dir, path.join(dir, 'not-created'), 'darwin'), /regular files/);
    await rm(path.join(dir, 'adb')); await writeFile(path.join(dir, 'adb'), 'fixture'); await rm(path.join(dir, 'NOTICE.txt'));
    await assert.rejects(stageAdb(dir, path.join(dir, 'not-created'), 'darwin'), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
