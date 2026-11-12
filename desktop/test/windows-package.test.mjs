import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowsDependencies, isolatedWindowsEnvironment, planRuntimeClosure } from '../collect-windows-runtime.mjs';

function image(names, delayed = []) {
  const bytes = Buffer.alloc(8192);
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60);
  bytes.writeUInt32LE(0x4550, 128); bytes.writeUInt16LE(0x8664, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(0x20b, 152); bytes.writeBigUInt64LE(0x140000000n, 176);
  bytes.writeUInt32LE(16, 260); bytes.writeUInt32LE(0x1000, 272); bytes.writeUInt32LE((names.length + 1) * 20, 276);
  bytes.writeUInt32LE(0x1000, 404); bytes.writeUInt32LE(7168, 408); bytes.writeUInt32LE(1024, 412);
  names.forEach((name, i) => { bytes.writeUInt32LE(0x1400 + i * 256, 1024 + i * 20 + 12); bytes.write(name + '\0', 2048 + i * 256, 'ascii'); });
  if (delayed.length) {
    bytes.writeUInt32LE(0x1c00, 368); bytes.writeUInt32LE((delayed.length + 1) * 32, 372);
    delayed.forEach((name, i) => { bytes.writeUInt32LE(1, 4096 + i * 32); bytes.writeUInt32LE(0x2000 + i * 256, 4100 + i * 32); bytes.write(name + '\0', 5120 + i * 256, 'ascii'); });
  }
  return bytes;
}
test('bounded PE imports include delay-loaded libraries and reject unsafe paths or foreign architectures', () => {
  assert.deepEqual(parseWindowsDependencies(image(['SDL3.dll', 'KERNEL32.dll', 'SDL3.dll'], ['codec.dll'])), ['codec.dll', 'kernel32.dll', 'sdl3.dll']);
  for (const name of ['../evil.dll', 'C:\\evil.dll', 'bad name.dll', 'bad.dll:stream', 'not-a-dll']) assert.throws(() => parseWindowsDependencies(image([name])));
  const foreign = image([]); foreign.writeUInt16LE(0xaa64, 132); assert.throws(() => parseWindowsDependencies(foreign));
  const invalid = image(['x.dll'], ['y.dll']); invalid.writeUInt32LE(0xffffffff, 4100); assert.throws(() => parseWindowsDependencies(invalid));
  const legacy = image([], ['legacy.dll']); legacy.writeBigUInt64LE(0x10000000n, 176); legacy.writeUInt32LE(0, 4096); legacy.writeUInt32LE(0x10002000, 4100); assert.deepEqual(parseWindowsDependencies(legacy), ['legacy.dll']);
  const flags = image([], ['flags.dll']); flags.writeUInt32LE(2, 4096); assert.throws(() => parseWindowsDependencies(flags));
  for (let n = 0; n < 8192; n += 29) { try { parseWindowsDependencies(image(['a.dll']).subarray(0, n)); } catch (error) { assert.match(error.message, /PE|import/); } }
});
test('the runtime closure includes transitive libraries exactly once and terminates cycles', async () => {
  const graph = { host: ['a.dll', 'kernel32.dll'], a: ['b.dll', 'c.dll'], b: ['a.dll'], c: [] };
  const plan = await planRuntimeClosure({ entry: { name: 'scrcpy.exe', file: 'host' }, inspect: async file => graph[file],
    resolve: async name => name[0], system: async name => name === 'kernel32.dll' });
  assert.deepEqual(plan.files.map(file => file.name), ['a.dll', 'b.dll', 'c.dll', 'scrcpy.exe']);
  assert.deepEqual(plan.systemImports, ['kernel32.dll']);
});
test('missing dependencies and unbounded closures fail before a packaging plan is returned', async () => {
  const base = { entry: { name: 'scrcpy.exe', file: 'host' }, inspect: async () => ['missing.dll'], system: async () => false };
  await assert.rejects(planRuntimeClosure({ ...base, resolve: async () => null }), /Missing runtime dependency: missing.dll/);
  await assert.rejects(planRuntimeClosure({ ...base, resolve: async name => name, limit: 1 }), /limit/);
  await assert.rejects(planRuntimeClosure({ ...base, inspect: async () => ['z.dll', 'a.dll'], resolve: async () => null }), /Missing runtime dependencies: a.dll, z.dll/);
});
test('the validation child has exactly one PATH and cannot load an external MSYS runtime', () => {
  const original = { Path: 'C:\\msys64\\mingw64\\bin', PATH: 'C:\\msys64\\ucrt64\\bin', SystemRoot: 'C:\\Windows', OTHER: 'retained' };
  const env = isolatedWindowsEnvironment(original, 'D:\\package\\bin');
  assert.deepEqual(Object.keys(env).filter(name => name.toLowerCase() === 'path'), ['PATH']);
  assert.equal(env.PATH, 'D:\\package\\bin;C:\\Windows\\System32;C:\\Windows');
  assert.equal(env.OTHER, 'retained'); assert.equal(original.Path, 'C:\\msys64\\mingw64\\bin');
});
