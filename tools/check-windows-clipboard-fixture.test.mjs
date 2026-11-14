import test from 'node:test';
import assert from 'node:assert/strict';
import { checkClipboardFixtureImage } from './check-windows-clipboard-fixture.mjs';
const image = { machine: 0x8664, kind: 'pe32+', imports: ['KERNEL32.dll', 'ucrtbase.dll'], delayImports: [] };
test('standalone conversion fixture accepts only OS Unicode and C runtime dependencies', () => {
  assert.deepEqual(checkClipboardFixtureImage(image).imports, ['kernel32.dll', 'ucrtbase.dll']);
  assert.equal(checkClipboardFixtureImage({ ...image, imports: ['kernel32.dll', 'api-ms-win-crt-stdio-l1-1-0.dll'] }).osClipboardDllImported, false);
});
test('clipboard, capture and arbitrary DLL dependencies are rejected before fixture execution', () => {
  for (const name of ['user32.dll', 'SDL3.dll', 'avcodec-62.dll', 'custom.dll', 'api-ms-win-crt-../user32.dll']) {
    assert.throws(() => checkClipboardFixtureImage({ ...image, imports: [...image.imports, name] }));
    assert.throws(() => checkClipboardFixtureImage({ ...image, delayImports: [name] }));
  }
});
test('missing, malformed and wrong-architecture fixture metadata fail closed', () => {
  for (const value of [null, {}, { ...image, machine: 0x14c }, { ...image, kind: 'pe32' },
    { ...image, imports: [] }, { ...image, imports: null }, { ...image, delayImports: null }])
    assert.throws(() => checkClipboardFixtureImage(value));
});
