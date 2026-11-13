import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { macHostArchitecture } from '../release/package_macos_host.mjs';
import { verifyRuntimePayload } from './payload-integrity.mjs';

export function macDesktopTarget(architecture, manifest) {
  const macho = macHostArchitecture(architecture);
  if (manifest?.platform !== 'darwin' || manifest.architecture !== architecture || manifest.linkage?.architecture !== macho || manifest.usbRuntime?.linkage?.architecture !== macho)
    throw Error('Stage a native Mac host matching this packaging architecture');
  return { architecture, macho, flag: architecture === 'arm64' ? '--arm64' : '--x64', output: architecture === 'arm64' ? 'mac-arm64' : 'mac' };
}

export async function packageMac() {
  if (process.platform !== 'darwin') throw Error('Package on the matching native Mac');
  const directory = fileURLToPath(new URL('./', import.meta.url));
  const stage = path.join(directory, 'stage');
  const manifest = JSON.parse(await readFile(path.join(stage, 'host/build-manifest.json'), 'utf8'));
  const target = macDesktopTarget(process.arch, manifest);
  // Check hashes before the packager copies any candidate payload. No native
  // program, permissions or sharing app is launched by this architecture gate.
  await verifyRuntimePayload(stage, manifest);
  const require = createRequire(import.meta.url);
  const cli = require.resolve('electron-builder/cli.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--config', path.join(directory, 'electron-builder.cjs'), '--mac', 'dir', target.flag, '--publish', 'never'],
      { cwd: directory, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Unsigned Mac packaging failed')));
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  packageMac().catch(error => { console.error(error.message); process.exitCode = 1; });
