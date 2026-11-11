import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { detectWindowsCrt } from './windows-runtime.mjs';
import { resolveRuntime, inspectReadiness } from './runtime.mjs';

const candidate = process.env.SCRCPY_WINDOWS_RUNTIME_TEST_BINARY;
test('actual UCRT64 native image loads through auto-selected child runtime', {
  skip: process.platform !== 'win32' || !candidate ? 'Requires the Windows CI native fixture' : false,
}, async () => {
  const binary = path.resolve(candidate);
  assert.equal(detectWindowsCrt(await readFile(binary)), 'ucrt64');
  const environment = { ...process.env, SCRCPY_GUI_BINARY: binary };
  delete environment.SCRCPY_RUNTIME_DIR;
  delete environment.MINGW_PREFIX;
  const runtime = resolveRuntime(process.cwd(), environment);
  const run = promisify(execFile);
  const readiness = await inspectReadiness(runtime, (exe, args, options) => run(exe, args,
    { ...options, timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }));
  assert.equal(readiness.checks.find((check) => check.id === 'runtime').ready, true);
  assert.equal(readiness.checks.find((check) => check.id === 'capture').ready, true);
});
