import path from 'node:path';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inventory } from '../tools/build-identity.mjs';
import { verifyRuntimePayload } from './payload-integrity.mjs';
import { verifyRuntimeNotices } from './runtime-notices.mjs';
import { parseWindowsDependencies } from './collect-windows-runtime.mjs';
import { parseWindowsAdbDependencies } from './stage-adb.mjs';

const require = createRequire(import.meta.url), base = require('./electron-builder.cjs');
const execute = promisify(execFile);
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}

export function developmentWindowsTarget(manifest, { platform = process.platform, architecture = process.arch, development = false } = {}) {
  if (!development) throw Error('Use --development explicitly; this is not a release installer');
  if (platform !== 'win32' || architecture !== 'x64') throw Error('Build the installer on native Windows x64');
  if (manifest?.product !== 'dskcpy-host-desktop-development' || manifest.platform !== 'win32' || manifest.architecture !== 'x64'
      || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '') || manifest.sourceModified !== false
      || manifest.qualification?.publicReleaseReady !== false || manifest.usbRuntime?.linkage?.architecture !== 'x86' || !Array.isArray(manifest.usbRuntime?.files)
      || !['adb.exe', 'adbwinapi.dll', 'adbwinusbapi.dll'].every(name => manifest.usbRuntime?.files?.some(file => typeof file === 'string' && file.toLowerCase() === name)))
    throw Error('Expected an identified Windows x64 development stage with the pinned x86 USB runtime');
}

export function developmentWindowsConfiguration(stage, output) {
  const { mac, win, directories, extraResources, ...shared } = base;
  return { ...shared, directories: { app: path.join(stage, 'app'), output },
    extraResources: [{ from: path.join(stage, 'host'), to: 'host' }],
    artifactName: 'dskcpy-Host-${version}-development-${arch}-setup.${ext}', forceCodeSigning: false, publish: null,
    // signAndEditExecutable alone does not disable signing of NSIS installers.
    // Pinned electron-builder's signIf checks signExecutable for all artifacts.
    win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false, signExecutable: false },
    nsis: { oneClick: true, perMachine: false, allowElevation: false, deleteAppDataOnUninstall: false,
      createDesktopShortcut: true, createStartMenuShortcut: true, runAfterFinish: true } };
}

export async function prepareWindowsDevelopmentInstaller({ stage, output, development = false }) {
  if (!development || process.platform !== 'win32' || process.arch !== 'x64') developmentWindowsTarget(null, { development });
  if (typeof stage !== 'string' || typeof output !== 'string') throw Error('Choose a verified stage and a new output directory');
  stage = path.resolve(stage); output = path.resolve(output);
  const sourceInfo = await lstat(stage);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw Error('Stage must be a regular directory');
  stage = await realpath(stage);
  output = path.join(await realpath(path.dirname(output)), path.basename(output));
  if (inside(stage, output)) throw Error('Output must be outside the stage');
  try { await lstat(output); throw Error('Output already exists; choose a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const original = await inventory(stage); // Reject all stage links before following a metadata path.
  const manifestFile = path.join(stage, 'host/build-manifest.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  developmentWindowsTarget(manifest, { development });
  const payload = await verifyRuntimePayload(stage, manifest);
  const notices = await verifyRuntimeNotices(path.join(stage, 'app'), path.join(stage, 'host'), manifest);
  parseWindowsDependencies(await readFile(path.join(stage, 'host/bin/scrcpy.exe')));
  for (const name of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'])
    parseWindowsAdbDependencies(await readFile(path.join(stage, 'host/bin', name)));
  const metadata = JSON.parse(await readFile(path.join(stage, 'app/package.json'), 'utf8'));
  if (metadata.main !== 'desktop/main.cjs' || !/^[0-9A-Za-z.+-]+$/.test(metadata.version || '')) throw Error('Unexpected staged application metadata');
  const cli = require.resolve('electron-builder/cli.js');
  await mkdir(output);
  const config = path.join(output, 'development-installer.json');
  await writeFile(config, JSON.stringify(developmentWindowsConfiguration(stage, output), null, 2) + '\n', { flag: 'wx' });
  try {
    const result = await execute(process.execPath, [cli, '--config', config, '--win', 'nsis', '--x64', '--publish', 'never'],
      { cwd: path.dirname(fileURLToPath(import.meta.url)), timeout: 600000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
    await writeFile(path.join(output, 'build.log'), result.stdout + result.stderr, { flag: 'wx' });
  } catch (error) {
    await writeFile(path.join(output, 'build.log'), `${error.stdout || ''}${error.stderr || ''}`, { flag: 'wx' });
    throw Error('Development installer compilation failed; generated output retained');
  }
  if (!isDeepStrictEqual(original, await inventory(stage))) throw Error('Input stage changed during installer compilation');
  const name = `dskcpy-Host-${metadata.version}-development-x64-setup.exe`;
  if (!(await readdir(output, { withFileTypes: true })).some(entry => entry.isFile() && entry.name === name)) throw Error('Expected installer artifact missing');
  const installer = path.join(output, name);
  const receipt = { schemaVersion: 1, product: 'dskcpy-windows-development-installer', sourceCommit: manifest.sourceCommit,
    installerBuilderSha256: await hash(fileURLToPath(import.meta.url)), architecture: 'x64', hostManifestSha256: await hash(manifestFile),
    installer: name, installerBytes: (await lstat(installer)).size, installerSha256: await hash(installer), ...payload, ...notices,
    inputStageUnchanged: true, perUser: true, oneClick: true, finishedInstallerLaunchedByWrapper: false,
    compilerUsesUninstallerGenerationStub: true, signingPerformed: false,
    installed: false, published: false, physicalInstallQualified: false, upgradeCompatibilityProven: false, releaseReady: false,
    limits: ['Unsigned development installer only; Windows acceptance, install/uninstall and upgrades unqualified',
      'Full notices, stable signing, minimum OS and physical host/browser/transport qualification remain open'] };
  await writeFile(path.join(output, 'installer-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--development') {
    console.error('Usage: node desktop/package-windows-installer.mjs --development VERIFIED_STAGE NEW_OUTPUT_DIRECTORY'); process.exitCode = 1;
  } else prepareWindowsDevelopmentInstaller({ development: true, stage: args[1], output: args[2] })
    .then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error('Development Windows installer preparation failed. Build on native Windows x64 with a verified stage and new output. Existing outputs are not replaced.'); process.exitCode = 1; });
}
