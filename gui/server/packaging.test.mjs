import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bash = process.platform === 'win32' ? 'C:/msys64/usr/bin/bash.exe' : '/bin/bash';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const slash = (value) => value.replaceAll('\\', '/');

test('fresh debug and release wrapper builds both produce the signed companion', { skip: !existsSync(bash) }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy packaging '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const gradle = path.join(dir, 'gradle-fixture');
  const env = { ...process.env, GRADLE: slash(gradle) };
  if (process.platform === 'win32') {
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `C:/msys64/usr/bin;${env[pathKey] || ''}`;
  }
  await writeFile(gradle, '#!/usr/bin/env bash\nset -eu\np="$2"\nmkdir -p "$p/build/outputs/apk/debug" "$p/build/outputs/apk/release"\nprintf signed > "$p/build/outputs/apk/debug/server-debug.apk"\nprintf unsigned > "$p/build/outputs/apk/release/server-release-unsigned.apk"\n');
  await chmod(gradle, 0o755);
  for (const type of ['debug', 'release']) {
    const project = path.join(dir, type, 'project');
    const output = path.join(dir, type, 'output');
    await mkdir(project, { recursive: true }); await mkdir(output, { recursive: true });
    const server = path.join(output, 'scrcpy-server');
    const apk = path.join(output, 'declared-companion.apk');
    const result = spawnSync(bash, [slash(path.join(root, 'server/scripts/build-wrapper.sh')), slash(project), slash(server), type, slash(apk)],
      { env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
    assert.equal(await readFile(server, 'utf8'), type === 'debug' ? 'signed' : 'unsigned');
    assert.equal(await readFile(apk, 'utf8'), 'signed');
  }
});

test('Windows release archive contains both server and companion and rejects a missing APK', { skip: !existsSync(bash) }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy release '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = path.join(dir, 'release');
  await mkdir(release);
  for (const file of ['build_common', 'build_server.sh', 'package_client.sh']) {
    await copyFile(path.join(root, 'release', file), path.join(release, file));
  }
  const gradle = path.join(dir, 'gradle-fixture');
  await writeFile(gradle, '#!/usr/bin/env bash\nset -eu\n[[ "$*" == *assembleRelease* && "$*" == *assembleDebug* ]]\nmkdir -p server/build/outputs/apk/{debug,release}\nprintf signed > server/build/outputs/apk/debug/server-debug.apk\nprintf unsigned > server/build/outputs/apk/release/server-release-unsigned.apk\n');
  await chmod(gradle, 0o755);
  const env = { ...process.env, GRADLE: slash(gradle), VERSION: 'test' };
  if (process.platform === 'win32') {
    const key = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    env[key] = `C:/msys64/usr/bin;${env[key] || ''}`;
  }
  const run = (script, ...args) => spawnSync(bash, [slash(path.join(release, script)), ...args],
    { env, encoding: 'utf8', windowsHide: true });
  const build = run('build_server.sh');
  assert.equal(build.status, 0, build.stderr || build.error?.message);
  const dist = path.join(release, 'work/build-win64/dist');
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'scrcpy.exe'), 'client');
  const packaged = run('package_client.sh', 'win64', 'tar.gz');
  assert.equal(packaged.status, 0, packaged.stderr || packaged.error?.message);
  const archive = path.join(release, 'output/scrcpy-win64-test.tar.gz');
  for (const [file, expected] of [['scrcpy-server', 'unsigned'], ['reverse-display.apk', 'signed'], ['scrcpy.exe', 'client']]) {
    const extracted = spawnSync(bash, ['-c', 'tar -xOf "$1" "$2"', 'archive-test', path.basename(archive), `scrcpy-win64-test/${file}`],
      { cwd: path.dirname(archive), env, encoding: 'utf8', windowsHide: true });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.equal(extracted.stdout, expected);
  }
  await rm(path.join(release, 'work/build-server/server/reverse-display.apk'));
  assert.notEqual(run('package_client.sh', 'win64', 'tar.gz').status, 0);
});
