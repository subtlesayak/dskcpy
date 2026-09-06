import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bash = process.platform === 'win32' ? 'C:/msys64/usr/bin/bash.exe' : '/bin/bash';

test('native thread-name literals fit the shared 15-byte limit, including Mac-only source', () => {
  const names = [];
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!/\.(c|m)$/.test(entry.name)) continue;
      const source = readFileSync(file, 'utf8');
      // Covers literal names at all existing call sites, not the declaration.
      for (const match of source.matchAll(/\bsc_thread_create\s*\(\s*[^,]+,\s*[^,]+,\s*"([^"\\]*)"/g)) {
        names.push({ file: entry.name, name: match[1] });
      }
    }
  }
  scan(path.join(root, 'app/src'));
  assert.ok(names.some(entry => entry.file === 'reverse_display_macos.m'), 'Do not omit the Mac-only backend from regression coverage');
  assert.ok(names.some(entry => entry.file === 'reverse_display.c'));
  for (const { file, name } of names) {
    assert.ok(Buffer.byteLength(name, 'utf8') <= 15,
      `${file}: thread name "${name}" exceeds sc_thread_create's 15-byte limit`);
  }
});

test('Mac scripts have valid shell syntax and reject non-Mac execution before building or launching', { skip: !existsSync(bash) }, () => {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
    env[key] = `C:/msys64/usr/bin;${env[key] || ''}`;
  }
  for (const name of ['macos-build.sh', 'macos-start.sh']) {
    const file = path.join(root, 'tools', name).replaceAll('\\', '/');
    const run = args => spawnSync(bash, args, { env, windowsHide: true, encoding: 'utf8' });
    const syntax = run(['-n', file]);
    assert.equal(syntax.status, 0, syntax.stderr || syntax.error?.message);
    if (process.platform !== 'darwin') {
      const result = run([file]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Terminal on the Mac/);
      assert.equal(result.stdout, '');
    }
  }
});
