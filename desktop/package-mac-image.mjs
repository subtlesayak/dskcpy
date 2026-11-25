import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { macDesktopTarget } from './package-mac.mjs';
import { verifyRuntimePayload } from './payload-integrity.mjs';
import { verifyRuntimeNotices } from './runtime-notices.mjs';

const execute = promisify(execFile);
const inside = (root, file) => { const relative = path.relative(root, file); return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}

// Framework symlinks are normal in an Electron app. Preserve their targets,
// but never package a developer file reached through an external/broken link.
export async function inventoryMacBundle(directory) {
  const root = await realpath(directory), entries = [];
  async function walk(relative = '') {
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      const entry = path.join(relative, name), file = path.join(root, entry);
      const info = await lstat(file);
      if (info.isSymbolicLink()) {
        if (!inside(root, await realpath(file))) throw Error('Application link escapes the bundle');
        entries.push({ path: entry.split(path.sep).join('/'), link: await readlink(file) });
      } else if (info.isDirectory()) await walk(entry);
      else if (info.isFile()) entries.push({ path: entry.split(path.sep).join('/'), bytes: info.size, mode: info.mode & 0o777, sha256: await hash(file) });
      else throw Error('Application contains a special file');
      if (entries.length > 100000) throw Error('Application inventory is too large');
    }
  }
  await walk();
  return entries;
}

export function developmentImageTarget(info, manifest, { platform = process.platform, architecture = process.arch, development = false } = {}) {
  if (!development) throw Error('Use --development explicitly; this is not a release installer');
  if (platform !== 'darwin') throw Error('Prepare the development image on native macOS');
  if (info?.CFBundleIdentifier !== 'com.dskcpy.host' || typeof info.CFBundleVersion !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(info.CFBundleVersion))
    throw Error('Expected the packaged dskcpy Host application identity');
  if (manifest?.product !== 'dskcpy-host-desktop-development' || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '')
      || manifest.sourceModified !== false || manifest.qualification?.publicReleaseReady !== false)
    throw Error('Expected an identified, unmodified development package');
  return macDesktopTarget(architecture, manifest);
}

const machOMagic = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const versionPattern = /^\d{1,4}(?:\.\d{1,4}){1,2}$/;

export function verifyMacDeploymentTarget(build, minimumOS) {
  if (!versionPattern.test(minimumOS || '')) throw Error('Missing or invalid LSMinimumSystemVersion');
  const commands = build.split(/^Load command \d+\s*$/m).slice(1);
  const declarations = commands.filter(command => /^\s*cmd\s+LC_(?:BUILD_VERSION|VERSION_MIN_\w+)\s*$/m.test(command));
  if (declarations.length !== 1) throw Error('Expected one Mach-O deployment target');
  const declaration = declarations[0];
  const modern = /^\s*cmd\s+LC_BUILD_VERSION\s*$/m.test(declaration);
  const platform = /^\s*platform\s+(?:MACOS|1)\s*$/m.test(declaration);
  const legacy = /^\s*cmd\s+LC_VERSION_MIN_MACOSX\s*$/m.test(declaration);
  if (!(modern && platform) && !legacy) throw Error('Expected a macOS Mach-O slice');
  const version = (modern ? /^\s*minos\s+(\S+)\s*$/m : /^\s*version\s+(\S+)\s*$/m).exec(declaration)?.[1];
  if (!versionPattern.test(version || '')) throw Error('Missing or invalid Mach-O deployment target');
  const required = version.split('.').map(Number), advertised = minimumOS.split('.').map(Number);
  for (let i = 0; i < 3; ++i) {
    const difference = (required[i] ?? 0) - (advertised[i] ?? 0);
    if (difference > 0) throw Error(`Binary targets macOS ${version}, above bundle minimum ${minimumOS}`);
    if (difference < 0) break;
  }
  return version;
}

async function verifyBundleDeployment(app, original, target, minimumOS) {
  const binaries = [];
  for (const entry of original) {
    if (entry.bytes === undefined || entry.bytes < 8) continue;
    const file = path.join(app, entry.path);
    const handle = await open(file, 'r');
    const magic = Buffer.alloc(8);
    try { await handle.read(magic, 0, magic.length, 0); }
    finally { await handle.close(); }
    if (!machOMagic.has(magic.readUInt32BE(0))) continue;
    // Java class files share FAT_MAGIC. The following word is a Java version
    // pair rather than a plausible count of universal Mach-O slices.
    if (magic.readUInt32BE(0) === 0xcafebabe && magic.readUInt32BE(4) > 64 && !(entry.mode & 0o111)) continue;
    try {
      const { stdout } = await execute('/usr/bin/vtool', ['-arch', target.macho, '-show-build', file], { timeout: 10000, maxBuffer: 1024 * 1024 });
      binaries.push({ path: entry.path, minimumOS: verifyMacDeploymentTarget(stdout, minimumOS) });
    } catch (error) {
      throw Error(`Cannot verify ${target.macho} deployment target for ${entry.path}: ${error.code ? 'vtool failed' : error.message}`);
    }
  }
  for (const required of ['Contents/MacOS/dskcpy Host', 'Contents/Resources/host/bin/scrcpy', 'Contents/Resources/host/bin/adb']) {
    if (!binaries.some(binary => binary.path === required)) throw Error(`Missing Mach-O executable ${required}`);
  }
  return { architecture: target.macho, declaredMinimumOS: minimumOS, binaries };
}

export async function prepareMacDevelopmentImage({ app, output, development = false }) {
  // Refuse release-like use before any filesystem mutation or tool call.
  if (!development || process.platform !== 'darwin') developmentImageTarget(null, null, { development });
  if (typeof app !== 'string' || typeof output !== 'string') throw Error('Choose an application and a new output directory');
  app = path.resolve(app); output = path.resolve(output);
  const sourceInfo = await lstat(app);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || path.basename(app) !== 'dskcpy Host.app') throw Error('Choose the packaged dskcpy Host.app directory');
  app = await realpath(app);
  const parent = await realpath(path.dirname(output));
  output = path.join(parent, path.basename(output));
  if (inside(app, output)) throw Error('Output must be outside the application');
  try { await lstat(output); throw Error('Output already exists; choose a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const resources = path.join(app, 'Contents/Resources');
  const manifestFile = path.join(resources, 'host/build-manifest.json');
  const manifestInfo = await lstat(manifestFile);
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw Error('Package manifest must be a regular file');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  const original = await inventoryMacBundle(app);
  const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const info = JSON.parse(stdout);
  const target = developmentImageTarget(info, manifest, { development });
  const payload = await verifyRuntimePayload(resources, manifest);
  const notices = await verifyRuntimeNotices(path.join(resources, 'app'), path.join(resources, 'host'), manifest);
  const deployment = await verifyBundleDeployment(app, original, target, info.LSMinimumSystemVersion);
  await mkdir(output); // Exclusive ownership: do not remove or overwrite an existing output.
  async function tool(name, file, args) {
    try {
      const result = await execute(file, args, { timeout: 180000, maxBuffer: 1024 * 1024 });
      await writeFile(path.join(output, `${name}.log`), result.stdout + result.stderr, { flag: 'wx' });
    } catch (error) {
      await writeFile(path.join(output, `${name}.log`), `${error.stdout || ''}${error.stderr || ''}`, { flag: 'wx' });
      throw Error(`Development image ${name} failed; generated output is retained`);
    }
  }
  const stage = path.join(output, 'image-root'), copy = path.join(stage, 'dskcpy Host.app');
  await mkdir(stage);
  await tool('copy', '/usr/bin/ditto', [app, copy]);
  if (!isDeepStrictEqual(original, await inventoryMacBundle(copy))) throw Error('Copied application differs from source');
  await symlink('/Applications', path.join(stage, 'Applications'), 'dir');
  await writeFile(path.join(stage, 'Read me first.txt'),
    'dskcpy Host — development preview\n\n'
    + 'This preview is for a controlled test. It is not a public release.\n'
    + 'Keep your current installation while it is sharing.\n\n'
    + 'When the test installation is approved:\n'
    + '1. Drag dskcpy Host to Applications.\n'
    + '2. Open dskcpy Host from Applications.\n'
    + '3. Follow the screen and control permission steps.\n'
    + '4. Choose USB cable or Private network, then Start sharing.\n\n'
    + 'For USB, unlock Android and approve USB debugging.\n'
    + 'For remote access, both devices need the existing private connection.\n'
    + 'Open the invitation in the receiving device’s browser.\n\n'
    + `${target.architecture === 'arm64' ? 'Apple silicon' : 'Intel'} development preview. Signing, installation, upgrades and minimum-OS testing remain open.\n`, { flag: 'wx' });
  const imageName = `dskcpy-Host-development-${target.architecture}.dmg`;
  const raw = path.join(output, 'development-hfs.dmg'), image = path.join(output, imageName);
  // Folder → HFS+ → compressed UDIF. No attach/mount/Finder scripting, app
  // launch, native --help, ADB, signing, trust or OS permission operation.
  await tool('makehybrid', '/usr/bin/hdiutil', ['makehybrid', '-hfs', '-hfs-volume-name', 'dskcpy Host Development', '-hfs-openfolder', stage, '-o', raw, stage]);
  await tool('compress', '/usr/bin/hdiutil', ['convert', raw, '-format', 'UDZO', '-o', image]);
  await tool('verify-image', '/usr/bin/hdiutil', ['verify', image]);
  if (!isDeepStrictEqual(original, await inventoryMacBundle(app)) || !isDeepStrictEqual(original, await inventoryMacBundle(copy)))
    throw Error('Application changed during image preparation');
  await writeFile(path.join(output, 'application-inventory.json'), JSON.stringify(original, null, 2) + '\n', { flag: 'wx' });
  const receipt = { schemaVersion: 1, product: 'dskcpy-mac-development-image', sourceCommit: manifest.sourceCommit,
    imageBuilderSha256: await hash(fileURLToPath(import.meta.url)),
    architecture: target.architecture, hostManifestSha256: await hash(manifestFile), image: imageName,
    imageBytes: (await lstat(image)).size, imageSha256: await hash(image), applicationEntries: original.length,
    applicationInventorySha256: await hash(path.join(output, 'application-inventory.json')), ...payload, ...notices,
    deployment,
    applicationCopyMatches: true, imageChecksumVerified: true, mounted: false, appLaunched: false,
    signingPerformed: false, installed: false, published: false, releaseReady: false,
    physicalFinderFlowVerified: false, permissionPreservingUpgradeProven: false,
    limits: ['Development image only; not a signed/notarized public release',
      'Image checksum and source/copy inventory verified; mounted contents and Finder layout unverified',
      'Installation, minimum OS, hardware, permission retention and data-preserving upgrades remain open'] };
  await writeFile(path.join(output, 'installer-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--development') {
    console.error('Usage: node desktop/package-mac-image.mjs --development PATH_TO_DSKCPY_APP NEW_OUTPUT_DIRECTORY'); process.exitCode = 1;
  } else prepareMacDevelopmentImage({ development: true, app: args[1], output: args[2] })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(`Development image preparation failed. ${error.message}`); process.exitCode = 1; });
}
