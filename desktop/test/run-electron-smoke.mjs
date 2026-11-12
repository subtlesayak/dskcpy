import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile), require = createRequire(import.meta.url);
if (process.platform === 'win32') throw Error('The fake native shell fixture is POSIX only; Windows runtime qualification remains separate.');
const resources = path.resolve(process.argv[2] || 'desktop/out/mac-arm64/dskcpy Host.app/Contents/Resources');
const application = path.join(resources, 'app');
await readFile(path.join(application, 'desktop/preload.cjs')); // Fail before launching if the assembled bundle is absent.
const ownedDirectory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-electron-check-'));
const result = path.join(ownedDirectory, 'result.json'), fakeNative = path.join(ownedDirectory, 'fake-host');
await writeFile(fakeNative, '#!/bin/sh\nif [ "$#" -ne 1 ] || [ "$1" != "--help" ]; then exit 64; fi\nprintf "%s\\n" "--reverse-display --reverse-socket --reverse-keyboard ScreenCaptureKit/VideoToolbox"\n', { mode: 0o755 });
await writeFile(path.join(ownedDirectory, 'config.json'), JSON.stringify({ application, fakeNative, ownedDirectory, result }));
try {
  await execute(require('electron'), [fileURLToPath(new URL('./electron-smoke.cjs', import.meta.url)),
    `--smoke-config=${path.join(ownedDirectory, 'config.json')}`], {
    cwd: ownedDirectory, timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const receipt = JSON.parse(await readFile(result, 'utf8'));
  if (!receipt.utilityProcessIpc || !receipt.bridgeLoaded || !receipt.hiddenWindow) throw Error('Runtime check incomplete');
  await mkdir('desktop/out/runtime-verification', { recursive: true });
  await writeFile('desktop/out/runtime-verification/electron-smoke.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally { await rm(ownedDirectory, { recursive: true, force: true }); }
