import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { isolatedWindowsEnvironment } from './collect-windows-runtime.mjs';
import { fileURLToPath } from 'node:url';
import { inventory, hashFile } from '../tools/build-identity.mjs';
import { inspectMachO } from '../release/package_macos_host.mjs';
import { stageAdb } from './stage-adb.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../', import.meta.url));
export async function stageHost({ native, output = path.join(repository, 'desktop/stage'), licenses, adb }) {
  if (!adb) throw Error('Supply the pinned platform-tools directory');
  if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Build on the target host platform.');
  const filename = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';
  if (!(await lstat(native)).isFile() || path.basename(native) !== filename) throw new Error('Choose a native host executable.');
  const { stdout: help } = await execute(native, ['--help'], { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  if (!help.includes('--reverse-socket') || !help.includes('--reverse-display')) throw new Error('Native browser hosting unavailable');
  let linkage;
  if (process.platform === 'darwin') {
    const options = { timeout: 10000, maxBuffer: 1024 * 1024 };
    const [commands, libraries, architectures] = await Promise.all([
      execute('/usr/bin/otool', ['-l', native], options), execute('/usr/bin/otool', ['-L', native], options),
      execute('/usr/bin/lipo', ['-archs', native], options),
    ]);
    linkage = inspectMachO(commands.stdout, libraries.stdout, architectures.stdout);
    if (!help.includes('ScreenCaptureKit/VideoToolbox') || !help.includes('--reverse-keyboard')) throw new Error('Mac browser capture/typing unavailable');
  }
  // Refuse an existing output and copy only source/code + declared native files.
  // Never include a developer HOME, .git, environment, signing keys or live data.
  await mkdir(output);
  const appDir = path.join(output, 'app'), hostDir = path.join(output, 'host');
  await mkdir(path.join(appDir, 'desktop'), { recursive: true });
  await mkdir(path.join(appDir, 'gui')); await mkdir(path.join(hostDir, 'bin'), { recursive: true });
  for (const file of ['main.cjs', 'preload.cjs', 'service-entry.cjs', 'host-controller.mjs', 'owned-backend.mjs', 'private-route.mjs', 'startup-preference.mjs', 'usb-devices.mjs'])
    await cp(path.join(repository, 'desktop', file), path.join(appDir, 'desktop', file));
  for (const file of ['server', 'receiver', 'dist', 'dist-desktop', 'package.json', 'package-lock.json'])
    await cp(path.join(repository, 'gui', file), path.join(appDir, 'gui', file), { recursive: true });
  const desktop = JSON.parse(await readFile(path.join(repository, 'desktop/package.json'), 'utf8'));
  const gui = JSON.parse(await readFile(path.join(repository, 'gui/package.json'), 'utf8'));
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: desktop.name, version: desktop.version,
    description: desktop.description, author: 'dskcpy contributors', license: 'Apache-2.0', main: 'desktop/main.cjs',
    dependencies: gui.dependencies }, null, 2));
  await cp(path.join(repository, 'gui/package-lock.json'), path.join(appDir, 'package-lock.json'));
  await cp(path.join(repository, 'LICENSE'), path.join(appDir, 'LICENSE'));
  await cp(native, path.join(hostDir, 'bin', filename));
  // Windows builds must supply their complete runtime beside scrcpy.exe. Probe
  // --help again from the copied directory below, with only this DLL location.
  if (process.platform === 'win32') for (const file of await readdir(path.dirname(native))) {
    if (/^[a-z0-9_.+-]+\.dll$/i.test(file)) {
      const source = path.join(path.dirname(native), file);
      if (!(await lstat(source)).isFile()) throw new Error('DLL links are not permitted');
      await cp(source, path.join(hostDir, 'bin', file));
    }
  }
  for (const file of ['scrcpy.png', 'disconnected.png', 'icon.ico'])
    await cp(path.join(repository, 'app/data', file), path.join(hostDir, 'bin', file));
  if (licenses) await cp(licenses, path.join(hostDir, 'licenses'), { recursive: true, dereference: false });
  // The app's fixed ADB path must work without Homebrew, Android Studio or PATH.
  // A missing declared input is a packaging failure, not a user setup task.
  // The supplied native license directory may already include this notice.
  await rm(path.join(hostDir, 'licenses/adb-NOTICE.txt'), { force: true });
  const usbRuntime = await stageAdb(adb, hostDir);
  const npmArgs = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--prefix', appDir];
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  await execute(process.platform === 'win32' ? process.execPath : 'npm', process.platform === 'win32' ? [npmCli, ...npmArgs] : npmArgs,
    { timeout: 180000, maxBuffer: 1024 * 1024 });
  await rm(path.join(appDir, 'node_modules/.bin'), { recursive: true, force: true });
  const { stdout: stagedHelp } = await execute(path.join(hostDir, 'bin', filename), ['--help'], {
    cwd: hostDir, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: process.platform === 'win32' ? isolatedWindowsEnvironment(process.env, path.join(hostDir, 'bin')) : { ...process.env, PATH: '/usr/bin:/bin' },
  });
  if (!stagedHelp.includes('--reverse-socket')) throw new Error('Packaged native runtime failed');
  const { stdout: commit } = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const { stdout: changes } = await execute('git', ['status', '--porcelain'], { cwd: repository });
  const manifest = { schemaVersion: 1, product: 'dskcpy-host-desktop-development', sourceCommit: commit.trim(), sourceModified: Boolean(changes.trim()),
    nativeSha256: await hashFile(native), platform: process.platform, architecture: process.arch, linkage, usbRuntime,
    qualification: { helpOnly: true, nativePhysicalTest: false, desktopPhysicalTest: false,
      signed: false, notarized: false, nativeNoticesIncluded: Boolean(licenses), thirdPartyNoticesReviewed: false, publicReleaseReady: false },
    files: await inventory(output) };
  await writeFile(path.join(hostDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [native, licenses, adb] = process.argv.slice(2);
  if (!native || !adb) { console.error('Usage: node desktop/stage.mjs NATIVE NATIVE_LICENSES_DIRECTORY PLATFORM_TOOLS_DIRECTORY'); process.exitCode = 1; }
  else stageHost({ native: path.resolve(native), licenses: licenses && licenses !== '-' ? path.resolve(licenses) : undefined, adb: path.resolve(adb) })
    .then(result => console.log(`Staged ${result.files.length} files. Development build; release qualification remains open.`))
    .catch(() => { console.error('Staging failed. Check native capabilities, dependencies, built GUI and the new output directory.'); process.exitCode = 1; });
}
