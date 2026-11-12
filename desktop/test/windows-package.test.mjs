import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowsDependencies, isolatedWindowsEnvironment, planRuntimeClosure } from '../collect-windows-runtime.mjs';

test('PE dependency parsing accepts x64 imports only and rejects paths masquerading as DLL names', () => {
  const header = 'host.exe: file format pei-x86-64\n';
  assert.deepEqual(parseWindowsDependencies(header + ' DLL Name: SDL3.dll\n DLL Name: KERNEL32.dll\n DLL Name: SDL3.dll\n'), ['kernel32.dll', 'sdl3.dll']);
  for (const name of ['../evil.dll', 'C:\\evil.dll', 'bad name.dll', 'bad.dll:stream', 'not-a-dll']) {
    assert.throws(() => parseWindowsDependencies(header + ' DLL Name: ' + name + '\n'));
  }
  for (const header of ['file format pei-i386', 'file format elf64-x86-64', '']) assert.throws(() => parseWindowsDependencies(header));
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
