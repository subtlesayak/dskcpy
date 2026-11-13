import path from 'node:path';
import { verifyRuntimePayload } from './payload-integrity.mjs';
import { isolatedWindowsEnvironment } from './collect-windows-runtime.mjs';
import { readFile, stat, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { macHostArchitecture } from '../release/package_macos_host.mjs';
import { hashFile } from '../tools/build-identity.mjs';
import { verifyRuntimeNotices } from './runtime-notices.mjs';
const execute = promisify(execFile);

export async function verifyBundle(resources) {
  const app = path.resolve(resources, 'app'), host = path.resolve(resources, 'host');
  const manifest = JSON.parse(await readFile(path.join(host, 'build-manifest.json'), 'utf8'));
  if (manifest.platform !== process.platform || manifest.architecture !== process.arch
      || (process.platform === 'darwin' && (manifest.linkage?.architecture !== macHostArchitecture() || manifest.usbRuntime?.linkage?.architecture !== macHostArchitecture()))) throw Error('Candidate architecture differs from this verification host');
  // Validate all first-party code/assets and native runtime before importing
  // bundled modules or executing even --help from the candidate.
  const payload = await verifyRuntimePayload(path.resolve(resources), manifest);
  const notices = await verifyRuntimeNotices(app, host, manifest);
  const packageJson = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
  if (packageJson.main !== 'desktop/main.cjs') throw Error('Wrong desktop entry');
  const required = ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/service-entry.cjs',
    'desktop/host-controller.mjs', 'desktop/owned-backend.mjs', 'desktop/receiver-probe.mjs', 'desktop/private-route.mjs', 'desktop/startup-preference.mjs', 'desktop/usb-devices.mjs',
    'gui/server/service.mjs', 'gui/server/native-startup.mjs', 'gui/server/trusted-devices.mjs', 'gui/server/browser-clipboard.mjs', 'gui/receiver/trackpad.mjs', 'gui/receiver/clipboard.mjs', 'gui/receiver/remembered.mjs', 'gui/receiver/lifecycle.mjs', 'gui/receiver/receiver.mjs', 'gui/dist-desktop/desktop/index.html', 'gui/dist/index.html'];
  for (const relative of required) {
    const file = path.join(app, relative);
    if (!(await stat(file)).isFile()) throw Error('Missing application file');
    const expected = manifest.files.find(entry => entry.path === `app/${relative}`)?.sha256;
    if (!expected || expected !== await hashFile(file)) throw Error('Packaged source differs from stage');
  }
  const html = await readFile(path.join(app, 'gui/dist-desktop/desktop/index.html'), 'utf8');
  for (const [, asset] of html.matchAll(/(?:src|href)="(\.\.\/assets\/[^"?#]+)"/g))
    if (!(await stat(path.resolve(app, 'gui/dist-desktop/desktop', asset))).isFile()) throw Error('Missing view asset');
  const require = createRequire(path.join(app, 'package.json'));
  for (const name of ['werift', 'ws']) {
    const resolved = require.resolve(name);
    if (!resolved.startsWith(app + path.sep)) throw Error('Runtime dependency escaped the app');
  }
  // Module loading only: no factory calls, sockets, permissions or capture.
  await import(pathToFileURL(path.join(app, 'gui/server/service.mjs')).href);
  await import(pathToFileURL(path.join(app, 'desktop/private-route.mjs')).href);
  const native = path.join(host, 'bin', manifest.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy');
  if (await hashFile(native) !== manifest.nativeSha256) throw Error('Native hash changed');
  const { stdout } = await execute(native, ['--help'], { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    cwd: host, env: process.platform === 'win32' ? isolatedWindowsEnvironment(process.env, path.join(host, 'bin')) : { ...process.env, PATH: '/usr/bin:/bin' } });
  if (!stdout.includes('--reverse-socket')) throw Error('Packaged native cannot load');
  const adb = path.join(host, 'bin', manifest.platform === 'win32' ? 'adb.exe' : 'adb');
  if (!manifest.usbRuntime?.sha256 || await hashFile(adb) !== manifest.usbRuntime.sha256) throw Error('USB runtime hash changed');
  const notice = manifest.files.find(entry => entry.path === 'host/licenses/adb-NOTICE.txt');
  const noticeInfo = await lstat(path.join(host, 'licenses/adb-NOTICE.txt'));
  if (!noticeInfo.isFile() || noticeInfo.isSymbolicLink()) throw Error('USB notice must be a regular file');
  if (!notice || notice.sha256 !== await hashFile(path.join(host, 'licenses/adb-NOTICE.txt'))) throw Error('USB runtime notice missing or changed');
  const { stdout: adbVersion } = await execute(adb, ['version'], { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    cwd: host, env: process.platform === 'win32' ? isolatedWindowsEnvironment(process.env, path.join(host, 'bin')) : { ...process.env, PATH: '/usr/bin:/bin' } });
  if (!/^Android Debug Bridge version /m.test(adbVersion)) throw Error('USB runtime cannot load');
  return { ...payload, ...notices, requiredSourceFiles: required.length, backendDependenciesBundled: true, backendModuleLoad: true,
    nativeHashMatches: true, nativeHelp: true, bundledAdbVersion: true, usbNotice: true, desktopLaunched: false, captureStarted: false, hardwareQualified: false };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  verifyBundle(process.argv[2]).then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error('Desktop bundle verification failed: required source, assets, dependencies or native runtime are missing or changed.'); process.exitCode = 1; });
}
