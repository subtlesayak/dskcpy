import assert from 'node:assert/strict';
import test from 'node:test';
import { detectWindowsCrt, windowsRuntimeEnvironment } from './windows-runtime.mjs';

function image(names, plus = true) {
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(1, 134);
  const optional = 152, length = plus ? 240 : 224;
  const directory = plus ? 112 : 96;
  bytes.writeUInt16LE(length, 148); bytes.writeUInt16LE(plus ? 0x20b : 0x10b, optional);
  bytes.writeUInt32LE(16, optional + directory - 4);
  bytes.writeUInt32LE(0x1000, optional + directory + 8);
  bytes.writeUInt32LE((names.length + 1) * 20, optional + directory + 12);
  const section = optional + length;
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(3072, section + 16); bytes.writeUInt32LE(1024, section + 20);
  names.forEach((name, index) => {
    bytes.writeUInt32LE(0x1400 + index * 256, 1024 + index * 20 + 12);
    bytes.write(name + '\0', 2048 + index * 256, 'ascii');
  });
  return bytes;
}

test('PE import classification distinguishes UCRT and legacy without executing the image', () => {
  for (const plus of [false, true]) {
    assert.equal(detectWindowsCrt(image(['KERNEL32.dll', 'ucrtbase.dll'], plus)), 'ucrt64');
    assert.equal(detectWindowsCrt(image(['api-ms-win-crt-runtime-l1-1-0.dll'], plus)), 'ucrt64');
    assert.equal(detectWindowsCrt(image(['msvcrt.dll'], plus)), 'mingw64');
  }
  assert.equal(detectWindowsCrt(image(['msvcrt.dll', 'ucrtbase.dll'])), null);
  assert.equal(detectWindowsCrt(image(['KERNEL32.dll'])), null);
  const badDelay = image(['ucrtbase.dll']); badDelay.writeUInt32LE(0xffffffff, 368); badDelay.writeUInt32LE(64, 372);
  assert.equal(detectWindowsCrt(badDelay), 'ucrt64'); // CRT discovery retains its ordinary-import-only behavior.
  const spoof = image(['KERNEL32.dll']); spoof.write('ucrtbase.dll', 3500);
  assert.equal(detectWindowsCrt(spoof), null);
});

test('malformed/truncated images fail closed with bounded parsing', () => {
  const valid = image(['ucrtbase.dll']);
  for (let size = 0; size < valid.length; size += 13) assert.doesNotThrow(() => detectWindowsCrt(valid.subarray(0, size)));
  for (const offset of [60, 134, 148, 152, 260, 272, 404, 408, 412, 1060]) {
    const bytes = Buffer.from(valid); bytes.writeUInt32LE(0xffffffff, offset);
    assert.doesNotThrow(() => detectWindowsCrt(bytes));
  }
  assert.equal(detectWindowsCrt(Buffer.alloc(0)), null);
  let state = 0x5ad15;
  for (let i = 0; i < 512; ++i) {
    const bytes = Buffer.from(valid);
    for (let j = 0; j < 8; ++j) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const offset = state % (bytes.length - 4);
      bytes.writeUInt32LE(state, offset);
    }
    assert.doesNotThrow(() => detectWindowsCrt(bytes));
  }
});

test('discovery follows the binary family and removes conflicting MSYS runtime PATH entries', () => {
  const input = { Path: 'C:\\Windows\\System32;D:\\msys64\\mingw64\\bin;D:\\msys64\\ucrt64\\bin;C:\\custom' };
  for (const family of ['ucrt64', 'mingw64']) {
    const result = windowsRuntimeEnvironment(input, null, { family, exists: (file) => file.startsWith('D:') });
    assert.equal(result.runtime, `D:\\msys64\\${family}\\bin`);
    assert.equal(result.env.Path, `${result.runtime};C:\\Windows\\System32;C:\\custom`);
  }
  assert.equal(input.Path.split(';').length, 4);
});

test('fresh environments prefer matching default install; explicit settings remain authoritative', () => {
  const exists = () => true;
  assert.equal(windowsRuntimeEnvironment({}, null, { family: 'ucrt64', exists }).runtime, 'C:\\msys64\\ucrt64\\bin');
  assert.equal(windowsRuntimeEnvironment({}, null, { family: 'mingw64', exists }).runtime, 'C:\\msys64\\mingw64\\bin');
  assert.equal(windowsRuntimeEnvironment({}, null, { family: null, exists }).runtime, 'C:\\msys64\\ucrt64\\bin');
  assert.equal(windowsRuntimeEnvironment({ SCRCPY_RUNTIME_DIR: 'Z:\\missing', MINGW_PREFIX: 'D:\\custom' }, null,
    { family: 'ucrt64', exists }).runtime, 'Z:\\missing');
  assert.equal(windowsRuntimeEnvironment({ MINGW_PREFIX: 'D:\\custom' }, null,
    { family: 'ucrt64', exists }).runtime, 'D:\\custom\\bin');
  assert.equal(windowsRuntimeEnvironment({ PATH: 'C:\\Windows\\System32' }, null,
    { family: 'ucrt64', exists: () => false }).runtime, 'C:\\msys64\\ucrt64\\bin');
});
