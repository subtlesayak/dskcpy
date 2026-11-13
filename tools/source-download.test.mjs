import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

test('production source downloader retries a reset and never caches a bad checksum', {
  skip: process.platform === 'win32' ? 'Mac source builder requires POSIX bash/curl/shasum' : false,
  timeout: 30000,
}, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-source-download-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  // Copy the actual production shell helper so all its scratch directories
  // stay in the test's owned temporary tree, not a developer dependency cache.
  const init = path.join(temp, '_init');
  await writeFile(init, await readFile(new URL('../app/deps/_init', import.meta.url)));
  const bytes = Buffer.from('original fixture archive');
  const digest = createHash('sha256').update(bytes).digest('hex');
  let requests = 0;
  const server = http.createServer((request, response) => {
    if (++requests === 1) { request.socket.destroy(); return; }
    response.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/fixture`;
  const run = (file, sha) => promisify(execFile)('bash', ['-ec',
    '. "$1"; cd "$2"; get_file "$3" "$4" "$5"', 'dskcpy-source-test', init, temp, url, file, sha],
  { env: { ...process.env, DSKCPY_MAC_HOST_BUILD: '1' }, timeout: 20000, maxBuffer: 1024 * 1024 });
  await run('fixture.tar.gz', digest);
  assert.equal(requests, 2);
  assert.deepEqual(await readFile(path.join(temp, 'fixture.tar.gz')), bytes);
  await assert.rejects(access(path.join(temp, 'fixture.tar.gz.download')), { code: 'ENOENT' });
  await run('fixture.tar.gz', digest); // Verified cache avoids another request.
  assert.equal(requests, 2);
  await assert.rejects(run('bad.tar.gz', '00'.repeat(32)));
  await assert.rejects(access(path.join(temp, 'bad.tar.gz')), { code: 'ENOENT' });
});

test('dependency checksum uses available SHA-256 tools and fails closed without one', {
  skip: process.platform === 'win32' ? 'POSIX PATH-isolation fixture; real MSYS2 checksum is exercised by Windows packaging' : false,
}, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-checksum-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const init = path.join(temp, '_init'); await writeFile(init, await readFile(new URL('../app/deps/_init', import.meta.url)));
  const bytes = Buffer.from('verified input'), file = path.join(temp, 'fixture'); await writeFile(file, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const execute = promisify(execFile);
  const actual = (await execute('/bin/bash', ['-ec', 'command -v shasum || command -v sha256sum'])).stdout.trim();
  const { mkdir } = await import('node:fs/promises');
  for (const tool of ['sha256sum', 'shasum', 'none']) {
    const bin = path.join(temp, tool); await mkdir(bin);
    if (tool !== 'none') {
      // Translate the selected CLI into an independently installed real
      // checksum implementation; mismatched bytes must still fail its check.
      const actualIsShasum = actual.endsWith('/shasum');
      const args = actualIsShasum ? (tool === 'sha256sum' ? '-a256 "$@"' : '"$@"') : (tool === 'shasum' ? '"${@:2}"' : '"$@"');
      await writeFile(path.join(bin, tool), '#!/bin/bash\nexec "' + actual + '" ' + args + '\n', { mode: 0o755 });
    }
    const run = sha => execute('/bin/bash', ['-ec', '. "$1"; PATH="$2"; checksum "$3" "$4"', 'checksum-fixture', init, bin, file, sha], { timeout: 5000 });
    if (tool === 'none') await assert.rejects(run(digest), error => /requires sha256sum or shasum/.test(error.stderr));
    else { await run(digest); await assert.rejects(run('00'.repeat(32))); }
  }
});
