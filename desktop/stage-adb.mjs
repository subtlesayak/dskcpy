import path from 'node:path';
import { cp, lstat, readdir, readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectMachO, macHostArchitecture } from '../release/package_macos_host.mjs';
import { planRuntimeClosure, isWindowsSystemImport, isolatedWindowsEnvironment } from './collect-windows-runtime.mjs';
import { readWindowsPeImports } from '../gui/server/windows-runtime.mjs';
import { hashFile } from '../tools/build-identity.mjs';

const execute = promisify(execFile);
const options = { timeout: 10000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' };
const validDll = name => typeof name === 'string' && /^[a-z0-9_.+-]+\.dll$/i.test(name);
export function parseWindowsAdbDependencies(bytes) {
  const image = readWindowsPeImports(bytes);
  // Google's checksum-pinned 37.0.0 Windows tools are x86 PE32, including both
  // USB DLLs. Keep native-host x64 validation unchanged and reject mixed DLLs.
  if (!image || image.machine !== 0x14c || image.kind !== 'pe32') throw Error('Expected the pinned x86 ADB image');
  const names = [...image.imports, ...image.delayImports];
  if (names.some(name => !validDll(name))) throw Error('Invalid USB import name');
  return [...new Set(names)].sort();
}
export async function isWindowsAdbSystemImport(name, { systemRoot = process.env.SystemRoot, stat = lstat } = {}) {
  if (!validDll(name) || !systemRoot || !path.win32.isAbsolute(systemRoot)) return false;
  // On the x64 Windows app target, x86 ADB loads OS DLLs through WOW64. Do not
  // copy those system DLLs or confuse the host's System32 runtime with ADB's.
  const physical = path.win32.join(systemRoot, 'SysWOW64', name.toLowerCase());
  const redirectedStat = () => stat(physical);
  if (await isWindowsSystemImport(name, { systemRoot, stat: redirectedStat })) return true;
  if (!['dbghelp.dll', 'wlanapi.dll', 'winusb.dll'].includes(name.toLowerCase())) return false;
  try { return (await stat(physical)).isFile(); } catch { return false; }
}
export async function stageAdb(directory, host, platform = process.platform) {
  if (!['darwin', 'win32'].includes(platform)) throw Error('Unsupported USB host platform');
  const name = platform === 'win32' ? 'adb.exe' : 'adb';
  const source = path.join(directory, name), notice = path.join(directory, 'NOTICE.txt');
  for (const file of [source, notice]) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || !info.size || info.size > 128 * 1024 * 1024) throw Error('USB runtime must contain regular files and notices');
  }
  let files = [{ name, file: source }], linkage;
  if (platform === 'darwin') {
    const architecture = macHostArchitecture();
    const [commands, libraries, architectures] = await Promise.all([
      execute('/usr/bin/otool', ['-arch', architecture, '-l', source], options),
      execute('/usr/bin/otool', ['-arch', architecture, '-L', source], options),
      execute('/usr/bin/lipo', ['-archs', source], options),
    ]);
    linkage = inspectMachO(commands.stdout, libraries.stdout, architectures.stdout, 13, architecture);
  } else {
    const entries = await readdir(directory, { withFileTypes: true });
    const names = new Map();
    for (const entry of entries) if (/^[a-z0-9_.+-]+\.dll$/i.test(entry.name) && entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (names.has(lower)) throw Error('Conflicting USB DLL names');
      names.set(lower, entry.name);
    }
    const inspect = async file => {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024) throw Error('Invalid USB runtime');
        return parseWindowsAdbDependencies(await readFile(file));
    };
    const resolve = async imported => names.has(imported.toLowerCase()) ? path.join(directory, names.get(imported.toLowerCase())) : null;
    const collected = new Map(), systemImports = new Set();
    // AdbWinUsbApi is loaded at runtime; it is not in adb.exe's static import
    // table. Both declared USB libraries are mandatory roots of the closure.
    for (const entry of [{ name, file: source }, ...['adbwinapi.dll', 'adbwinusbapi.dll'].map(name => ({ name, file: names.has(name) ? path.join(directory, names.get(name)) : null }))]) {
      if (!entry.file) throw Error('Missing declared USB library');
      const plan = await planRuntimeClosure({ entry, inspect, resolve, system: imported => isWindowsAdbSystemImport(imported) });
      for (const item of plan.files) collected.set(item.name.toLowerCase(), item);
      for (const imported of plan.systemImports) systemImports.add(imported);
    }
    files = [...collected.values()]; linkage = { architecture: 'x86', systemImports: [...systemImports].sort() };
  }
  // Refuse collisions with the native host's DLLs rather than overwrite them.
  for (const item of files) await cp(item.file, path.join(host, 'bin', item.name), { errorOnExist: true, force: false });
  await mkdir(path.join(host, 'licenses'), { recursive: true });
  await cp(notice, path.join(host, 'licenses/adb-NOTICE.txt'), { errorOnExist: true, force: false });
  const executable = path.join(host, 'bin', name);
  // `version` does not start an ADB server or enumerate/control real devices.
  const { stdout } = await execute(executable, ['version'], { ...options, cwd: host,
    env: platform === 'win32' ? isolatedWindowsEnvironment(process.env, path.join(host, 'bin')) : { ...process.env, PATH: '/usr/bin:/bin' } });
  if (!/^Android Debug Bridge version /m.test(stdout)) throw Error('Bundled USB runtime cannot load');
  return { sha256: await hashFile(source), files: files.map(item => item.name), linkage, versionLoads: true, deviceEnumerated: false };
}
