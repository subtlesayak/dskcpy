import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashFile } from '../tools/build-identity.mjs';
const execute = promisify(execFile);

export async function verifyBundle(resources) {
  const app = path.resolve(resources, 'app'), host = path.resolve(resources, 'host');
  const manifest = JSON.parse(await readFile(path.join(host, 'build-manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
  if (packageJson.main !== 'desktop/main.cjs') throw Error('Wrong desktop entry');
  const required = ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/service-entry.cjs',
    'desktop/host-controller.mjs', 'desktop/owned-backend.mjs', 'desktop/private-route.mjs',
    'gui/server/service.mjs', 'gui/receiver/receiver.mjs', 'gui/dist-desktop/desktop/index.html', 'gui/dist/index.html'];
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
    cwd: host, env: { ...process.env, PATH: process.platform === 'win32'
      ? `${path.join(host, 'bin')};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : '/usr/bin:/bin' } });
  if (!stdout.includes('--reverse-socket')) throw Error('Packaged native cannot load');
  return { requiredSourceFiles: required.length, backendDependenciesBundled: true, backendModuleLoad: true,
    nativeHashMatches: true, nativeHelp: true, desktopLaunched: false, captureStarted: false, hardwareQualified: false };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  verifyBundle(process.argv[2]).then(result => console.log(JSON.stringify(result)))
    .catch(() => { console.error('Desktop bundle verification failed: required source, assets, dependencies or native runtime are missing or changed.'); process.exitCode = 1; });
}
