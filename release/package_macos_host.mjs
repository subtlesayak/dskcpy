import { execFile } from 'node:child_process';
import { cp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { repository, readIdentity, inventory } from '../tools/build-identity.mjs';

const execute = promisify(execFile);
export function inspectMachO(loadCommands, libraries, architectures, minimum = 13) {
  if (!architectures.trim().split(/\s+/).includes('arm64')) throw new Error('Hosting executable lacks arm64');
  const blocks = loadCommands.split(/Load command \d+/);
  const targets = blocks.flatMap((block) => {
    const match = /cmd LC_BUILD_VERSION\b/.test(block) ? /\bminos (\d+(?:\.\d+)*)/.exec(block)
      : /cmd LC_VERSION_MIN_MACOSX\b/.test(block) ? /\bversion (\d+(?:\.\d+)*)/.exec(block) : null;
    return match ? [match[1]] : [];
  });
  if (!targets.length || targets.some((target) => Number(target.split('.')[0]) > minimum
      || (Number(target.split('.')[0]) === minimum && Number(target.split('.')[1] || 0) > 0))) {
    throw new Error('Executable deployment target exceeds the declared macOS 13.0 minimum or is missing');
  }
  const dependencies = libraries.split(/\r?\n/).slice(1).filter((line) => line.trim())
    .map((line) => line.trim().replace(/ \(compatibility version.*$/, ''));
  if (!dependencies.length || dependencies.some((lib) => !lib.startsWith('/System/Library/') && !lib.startsWith('/usr/lib/'))) {
    throw new Error('Non-system dynamic dependency found; Homebrew/rpath libraries cannot be shipped as a portable host');
  }
  return { architecture: 'arm64', deploymentTargets: targets, systemLibraries: dependencies };
}

async function verifyBinary(file) {
  const options = { timeout: 30000, maxBuffer: 1024 * 1024 };
  const [{ stdout: commands }, { stdout: libraries }, { stdout: architectures }] = await Promise.all([
    execute('/usr/bin/otool', ['-arch', 'arm64', '-l', file], options),
    execute('/usr/bin/otool', ['-arch', 'arm64', '-L', file], options),
    execute('/usr/bin/lipo', ['-archs', file], options),
  ]);
  return inspectMachO(commands, libraries, architectures);
}

export async function packageHost(native, adb, output) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Package on Apple-silicon macOS');
  const { stdout: commit } = await execute('git', ['rev-parse', 'HEAD'], { cwd: repository });
  const { stdout: changes } = await execute('git', ['status', '--porcelain'], { cwd: repository });
  const tree = path.resolve(output);
  // Refuse an existing directory, even an empty one. Every mutation below stays
  // inside the newly owned output; active development/runtime trees are untouched.
  await mkdir(tree);
  const dependencies = { scrcpy: await verifyBinary(native), adb: await verifyBinary(adb) };
  const { stdout: help } = await execute(native, ['--help'], { timeout: 10000, maxBuffer: 1024 * 1024 });
  if (!help.includes('ScreenCaptureKit/VideoToolbox') || !help.includes('--reverse-keyboard')) throw new Error('Mac hosting capabilities missing');
  await mkdir(path.join(tree, 'bin'));
  for (const [source, dest] of [[native, 'bin/scrcpy'], [adb, 'bin/adb'],
    [path.join(repository, 'app/data/scrcpy.png'), 'bin/scrcpy.png'],
    [path.join(repository, 'app/data/disconnected.png'), 'bin/disconnected.png'],
    [path.join(repository, 'LICENSE'), 'LICENSE'],
    [path.join(repository, 'dskcpy.properties'), 'dskcpy.properties'],
    [path.join(repository, 'release/Start-dskcpy-host.command'), 'Start-dskcpy-host.command']]) {
    await cp(source, path.join(tree, dest), { errorOnExist: true, force: false });
  }
  await chmod(path.join(tree, 'Start-dskcpy-host.command'), 0o755);
  await mkdir(path.join(tree, 'gui'));
  for (const name of ['package.json', 'package-lock.json', 'dist', 'server', 'scripts', 'receiver']) {
    await cp(path.join(repository, 'gui', name), path.join(tree, 'gui', name), { recursive: true, errorOnExist: true, force: false });
  }
  await execute('npm', ['ci', '--omit=dev', '--ignore-scripts', '--prefix', path.join(tree, 'gui')], { timeout: 180000, maxBuffer: 1024 * 1024 });
  // Only npm's executable aliases are omitted; runtime modules remain untouched.
  await rm(path.join(tree, 'gui/node_modules/.bin'), { recursive: true, force: true });
  await mkdir(path.join(tree, 'licenses'));
  for (const [name, license] of [['sdl-3.4.12', 'LICENSE.txt'], ['dav1d-1.5.3', 'COPYING'],
    ['opus-1.6.1', 'COPYING'], ['ffmpeg-8.1.2', 'COPYING.LGPLv2.1']]) {
    await cp(path.join(repository, 'app/deps/work/sources', name, license), path.join(tree, 'licenses', `${name}.txt`));
  }
  await cp(path.join(repository, 'app/deps/work/install/adb-macos/NOTICE.txt'), path.join(tree, 'licenses/adb-NOTICE.txt'));
  await writeFile(path.join(tree, 'README.txt'),
    'dskcpy experimental Mac hosting candidate\n\nApple silicon; build deployment target macOS 13.0. Requires Node.js 22.12+ (24 recommended).\n'
    + 'Run ./Start-dskcpy-host.command --check first, then ./Start-dskcpy-host.command.\n'
    + 'Browser receiving is included. ADB is included; the Android companion/server are intentionally separate matching-key artifacts.\n'
    + 'No developer signing, notarization or publication has been performed. Follow your normal local macOS trust policy.\n'
    + 'A deployment-target/link scan is not clean macOS 13 or physical media qualification. See build-manifest.json.\n');
  const build = await readIdentity();
  const files = await inventory(tree);
  const manifest = { schemaVersion: 1, product: 'dskcpy-macos-host', build, source: { commit: commit.trim(), modified: Boolean(changes.trim()) },
    minimumOS: '13.0', architecture: 'arm64', dependencies,
    qualification: { nativeHelp: true, linkedLibraries: 'system only', cleanMinimumOS: false, physicalMedia: false,
      developerSigned: false, notarized: false }, files };
  await writeFile(path.join(tree, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 5) { console.error('Usage: node release/package_macos_host.mjs NATIVE ADB NEW_OUTPUT'); process.exitCode = 1; }
  else packageHost(...process.argv.slice(2)).then((manifest) => console.log(`Verified ${manifest.files.length} packaged files; minimum-OS/device qualification remains open.`))
    .catch(() => { console.error('Mac hosting packaging failed; inspect the local build/dependency setup. Existing outputs were not overwritten.'); process.exitCode = 1; });
}
