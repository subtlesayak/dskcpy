import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const execute = promisify(execFile);
test('host dependency cache separates native architectures and refuses mismatched or unsupported requests', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-host-arch-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const deps = path.join(directory, 'deps with spaces'), bin = path.join(directory, 'bin'); await mkdir(deps); await mkdir(bin);
  await cp('app/deps/_init', path.join(deps, '_init'));
  const uname = path.join(bin, 'uname');
  const run = (_native, requested) => execute('bash', ['-c', '. "$1"; process_args macos native static; printf "%s" "$DIRNAME"', 'fixture', path.join(deps, '_init')],
    { env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, DSKCPY_MAC_HOST_BUILD: '1', MACOSX_DEPLOYMENT_TARGET: '13.0', DSKCPY_MAC_HOST_ARCH: requested }, timeout: 10000 });
  for (const arch of ['arm64', 'x86_64']) {
    await writeFile(uname, `#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo ${arch};; *) exit 1;; esac\n`, { mode: 0o755 });
    assert.equal((await run(arch, arch)).stdout, `macos-host13-${arch}-native-static`);
    await assert.rejects(run(arch, arch === 'arm64' ? 'x86_64' : 'arm64'), /matching native/);
    await assert.rejects(run(arch, 'riscv64'), /matching native/);
  }
});
test('release build refuses a foreign target before creating output or executing a native program', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-host-foreign-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output');
  const foreign = process.arch === 'arm64' ? 'x86_64' : 'arm64';
  await assert.rejects(execute('bash', ['release/build_macos_host.sh', output], { env: { ...process.env, DSKCPY_MAC_HOST_ARCH: foreign }, timeout: 10000 }), /matching this Mac architecture/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});
