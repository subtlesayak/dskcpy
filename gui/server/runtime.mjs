import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

function isFile(file, executable = false) {
  try {
    if (!file || !statSync(file).isFile()) return false;
    accessSync(file, executable ? constants.X_OK : constants.R_OK);
    return true;
  } catch { return false; }
}

export function resolveExecutable(name, env, cwd, platform = process.platform) {
  if (!name) return null;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const directories = /[/\\]/.test(name) || path.isAbsolute(name)
    ? [''] : (env[pathKey] || '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const base = path.resolve(cwd, directory.replace(/^"|"$/g, ''), name);
    const candidates = platform === 'win32' && !path.extname(base) ? [`${base}.exe`] : [base];
    for (const file of candidates) {
      // Shell scripts/batch files are not valid shell:false Windows executables.
      if (platform === 'win32' && path.extname(file).toLowerCase() !== '.exe') continue;
      if (isFile(file, true)) return file;
    }
  }
  return null;
}

export function resolveRuntime(repoDir, inputEnv = process.env, platform = process.platform) {
  const env = { ...inputEnv };
  const local = path.join(repoDir, 'x-reverse', 'app', platform === 'win32' ? 'scrcpy.exe' : 'scrcpy');
  const executable = resolveExecutable(env.SCRCPY_GUI_BINARY || (isFile(local) ? local : 'scrcpy'), env, repoDir, platform);
  const binaryDir = executable ? path.dirname(executable) : path.dirname(local);
  // Custom installations resolve their own assets. Never mix in x-reverse files.
  const assetDir = path.basename(binaryDir) === 'app' ? path.resolve(binaryDir, '../server') : binaryDir;
  const asset = (override, name) => path.resolve(repoDir, override || path.join(assetDir, name));
  env.SCRCPY_SERVER_PATH = asset(env.SCRCPY_SERVER_PATH, 'scrcpy-server');
  env.SCRCPY_REVERSE_DISPLAY_APK = asset(env.SCRCPY_REVERSE_DISPLAY_APK, 'reverse-display.apk');
  env.SCRCPY_ICON_DIR = env.SCRCPY_ICON_DIR || (executable === local ? path.join(repoDir, 'app/data') : binaryDir);
  const adbName = env.ADB || (env.ANDROID_HOME
    ? path.join(env.ANDROID_HOME, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb') : 'adb');
  const adb = resolveExecutable(adbName, env, repoDir, platform);
  env.ADB = adb || adbName;
  env.SCRCPY_GUI_CONTROL = 'stdin-v1';
  if (platform === 'win32') {
    const runtimeDir = env.SCRCPY_RUNTIME_DIR || (env.MINGW_PREFIX ? path.join(env.MINGW_PREFIX, 'bin') : 'C:\\msys64\\mingw64\\bin');
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = `${runtimeDir}${path.delimiter}${env[pathKey] || ''}`;
  }
  return { executable, adb, env, repoDir, platform };
}

export async function inspectReadiness(runtime, runCommand) {
  const { executable, adb, env, platform, repoDir } = runtime;
  const checks = [];
  const add = (id, label, ready, message) => checks.push({ id, label, ready, message });
  add('binary', 'Streaming program', Boolean(executable), executable ? 'Found.' : 'Build or configure the reverse-display program.');
  let loaded = false;
  let supported = false;
  let macBackend = false;
  if (executable) {
    try {
      // Loads the actual dependency chain, including transitive DLLs. Never starts capture.
      const { stdout } = await runCommand(executable, ['--help'], { env, cwd: repoDir });
      loaded = true;
      supported = stdout.includes('--reverse-display') && stdout.includes('--reverse-socket');
      macBackend = supported && stdout.includes('ScreenCaptureKit/VideoToolbox');
    } catch { /* Do not reflect environment paths from loader errors into readiness. */ }
  }
  add('runtime', 'Runtime libraries', loaded, loaded ? 'Program loads successfully.' : 'The streaming program could not load. Check its runtime libraries.');
  add('capture', platform === 'darwin' ? 'Experimental Mac capture' : 'Desktop capture',
    platform === 'win32' ? supported : platform === 'darwin' && macBackend,
    platform === 'darwin' ? macBackend
      ? 'Experimental Mac backend found. Screen & System Audio Recording and Accessibility permissions are checked when streaming starts. Opus audio forwarding is experimental.'
      : 'Build this fork on the Mac with -Dreverse_macos=true. An ordinary scrcpy build cannot host reverse display.'
    : platform === 'win32' ? supported ? 'Reverse display is supported.' : 'Use this fork’s reverse-display build.'
      : 'Desktop capture is available on Windows or an experimental macOS source build, not this platform.');
  add('server', 'Server artifact', isFile(env.SCRCPY_SERVER_PATH), 'Build or configure the matching scrcpy-server artifact.');
  add('companion', 'Android companion', isFile(env.SCRCPY_REVERSE_DISPLAY_APK), 'Build or configure the signed reverse-display.apk companion.');
  let adbReady = false;
  if (adb) {
    try {
      await runCommand(adb, ['version'], { env, cwd: repoDir });
      adbReady = true;
    } catch { /* ADB readiness is separate from Internet transport. */ }
  }
  add('adb', 'Android connection tool', adbReady, adbReady ? 'ADB loads successfully.' : 'Install or configure Android platform-tools (ADB).');
  const base = ['binary', 'runtime', 'capture'];
  const transports = Object.fromEntries(['usb', 'wifi', 'ip', 'internet', 'browser'].map((connection) => {
    // Internet mode uses no ADB/server/APK on the desktop. The phone app is installed separately.
    const required = ['internet', 'browser'].includes(connection) ? base : [...base, 'companion', 'adb'];
    const failed = checks.filter((check) => required.includes(check.id) && !check.ready);
    return [connection, { ready: failed.length === 0, message: failed[0]?.message || 'Local components are ready.', required }];
  }));
  return { checks, transports, checkedAt: new Date().toISOString() };
}
