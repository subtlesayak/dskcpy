import test from 'node:test';
import assert from 'node:assert/strict';
import { smokeFailure, electronUiEnvironment } from './smoke-diagnostics.mjs';
test('runtime failures retain only a bounded stage and category, never exception paths or output', () => {
  const secret = 'PRIVATE_FIXTURE_PATH_OR_TOKEN';
  const result = smokeFailure({ stage: 'utility-readiness', category: 'assertion', detail: secret },
    { code: 1, stderr: secret, stdout: secret, message: secret, stack: secret });
  assert.equal(result.stage, 'utility-readiness'); assert.equal(result.category, 'assertion'); assert.equal(result.exitCode, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  const unknown = smokeFailure({ stage: secret }, { code: secret, signal: secret, killed: true });
  assert.equal(unknown.stage, 'electron-process'); assert.equal(unknown.exitCode, null); assert.equal(unknown.signal, null); assert.equal(unknown.category, 'timeout');
});


test('GUI child launch deletes the Electron Node selector instead of defining it empty', () => {
  const input = { ELECTRON_RUN_AS_NODE: '', electron_run_as_node: '1', PATH: 'retained', OTHER: 'unchanged' };
  const env = electronUiEnvironment(input);
  assert.deepEqual(env, { PATH: 'retained', OTHER: 'unchanged' });
  assert.equal(input.electron_run_as_node, '1'); assert.ok('ELECTRON_RUN_AS_NODE' in input);
});
