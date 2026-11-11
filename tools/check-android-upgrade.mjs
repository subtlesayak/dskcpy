// Read-only compatibility check. Never installs, uninstalls, signs or changes
// device settings. Android's own install -r checks remain the final authority.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { hashFile, readIdentity } from './build-identity.mjs';

const execute = promisify(execFile);
const packageName = 'com.genymobile.scrcpy';
export function parseApkIdentity(badging, certificates) {
  const line = badging.split(/\r?\n/).find((value) => value.startsWith('package: ')) || '';
  const field = (name) => new RegExp(`(?:^| )${name}='([^']*)'`).exec(line)?.[1];
  const versionCode = Number(field('versionCode'));
  const signerSha256 = [...certificates.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})\r?$/gm)]
    .map((match) => match[1].toLowerCase()).sort();
  if (field('name') !== packageName || !Number.isSafeInteger(versionCode) || versionCode < 1
      || versionCode > 2100000000 || !field('versionName') || !signerSha256.length) {
    throw new Error('APK identity or verified signing certificate is missing or invalid');
  }
  return { packageName, versionCode, versionName: field('versionName'), signerSha256 };
}

export function compareUpgrade(candidate, installed) {
  if (candidate.packageName !== packageName || installed.packageName !== packageName) throw new Error('Package identity mismatch');
  if (candidate.versionCode < installed.versionCode) throw new Error('Downgrade refused; obtain a newer matching-key companion. Do not uninstall the working app.');
  if (JSON.stringify(candidate.signerSha256) !== JSON.stringify(installed.signerSha256)) {
    throw new Error('Signing certificate differs; obtain the same-key companion. No uninstall or key rotation was attempted.');
  }
  return { compatible: true, action: candidate.versionCode === installed.versionCode ? 'same-version replacement' : 'upgrade' };
}

export async function inspectApk(apk, sdkTools, run = execute) {
  const file = path.resolve(apk);
  if (!(await stat(file)).isFile()) throw new Error('APK is not a regular file');
  const aapt = path.join(sdkTools, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2');
  const java = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const options = { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true };
  const { stdout: badging } = await run(aapt, ['dump', 'badging', file], options);
  const { stdout: certificates } = await run(java, ['-jar', path.join(sdkTools, 'lib/apksigner.jar'), 'verify', '--print-certs', file], options);
  return { ...parseApkIdentity(badging, certificates), bytes: (await stat(file)).size, sha256: await hashFile(file) };
}

export async function inspectInstalled(adb, sdkTools, { serial, run = execute, inspect = inspectApk } = {}) {
  const args = serial ? ['-s', serial] : [];
  const options = { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true };
  // Fixed package, no shell command interpolation. Do not expose paths/serials
  // in the result or copy an installed APK into a shared artifact.
  const { stdout } = await run(adb, [...args, 'shell', 'pm', 'path', packageName], options);
  const paths = stdout.trim().split(/\r?\n/).filter(Boolean);
  const base = paths.find((line) => line.endsWith('/base.apk')) || (paths.length === 1 ? paths[0] : '');
  if (!/^package:\/data\/app\/[^\s]+\.apk$/.test(base)) throw new Error('No installed base APK found; select one authorized device with ANDROID_SERIAL if needed');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-upgrade-'));
  try {
    const file = path.join(temp, 'installed.apk');
    await run(adb, [...args, 'pull', base.slice('package:'.length), file], options);
    return await inspect(file, sdkTools, run);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

export function parseArgs(args) {
  const values = {};
  for (let i = 0; i < args.length; ++i) {
    const key = args[i];
    if (['--device', '--help', '--require-current'].includes(key)) {
      if (values[key]) throw new Error('Duplicate option');
      values[key] = true;
    } else if (['--apk', '--sdk-tools', '--installed-apk', '--output', '--adb'].includes(key)
        && args[i + 1] && !args[i + 1].startsWith('--') && !values[key]) values[key] = args[++i];
    else throw new Error('Invalid upgrade-check option');
  }
  if (!values['--help'] && (!values['--apk'] || !values['--sdk-tools']
      || (values['--device'] && values['--installed-apk']))) throw new Error('Provide --apk and --sdk-tools; choose either --device or --installed-apk');
  return values;
}

export async function main(args, log = console.log) {
  const options = parseArgs(args);
  if (options['--help']) {
    log('node tools/check-android-upgrade.mjs --apk FILE --sdk-tools SDK/build-tools/VERSION [--device | --installed-apk FILE] [--require-current] [--output NEW_FILE] [--adb FILE]');
    log('Read-only: verifies APK signatures and version compatibility; never installs or uninstalls. --device privately pulls the installed base APK into a temporary directory and removes it.');
    return;
  }
  const candidate = await inspectApk(options['--apk'], options['--sdk-tools']);
  const build = await readIdentity();
  if (options['--require-current'] && (candidate.versionCode !== build.androidVersionCode || candidate.versionName !== build.version)) {
    throw new Error('APK does not match the current source build identity');
  }
  let installed;
  if (options['--device']) installed = await inspectInstalled(options['--adb'] || 'adb', options['--sdk-tools'], { serial: process.env.ANDROID_SERIAL });
  if (options['--installed-apk']) installed = await inspectApk(options['--installed-apk'], options['--sdk-tools']);
  const result = { schemaVersion: 1, build, candidate, comparison: installed ? compareUpgrade(candidate, installed) : null,
    installed: installed ? { versionCode: installed.versionCode, signerSha256: installed.signerSha256 } : null,
    limitations: 'Exact signer match only; key rotation needs separate lineage review. Compatibility is not an install/data-preservation test.' };
  if (options['--output']) await writeFile(options['--output'], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    // Child-process errors contain arguments, serials and local paths. Never
    // echo them into a potentially shared build log.
    console.error(error.cmd ? 'APK check tool failed. Check SDK/JDK/ADB availability and authorized-device selection locally.' : error.message);
    process.exitCode = 1;
  });
}
