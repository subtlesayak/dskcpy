import path from 'node:path';
import { readWindowsPeImports } from '../gui/server/windows-runtime.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, lstat, readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const validDll = name => /^[a-z0-9_.+-]+\.dll$/i.test(name);
const systemNames = new Set(('advapi32 authz avrt bcrypt bcryptprimitives cfgmgr32 comctl32 comdlg32 crypt32 cryptbase d3d11 dcomp dhcpcsvc dinput8 dnsapi dwmapi dwrite dxgi gdi32 gdiplus imm32 iphlpapi kernel32 kernelbase mf mfplat mfreadwrite mfuuid mpr msacm32 msimg32 msvcrt msvcp_win ncrypt normaliz ntdll ole32 oleaut32 opengl32 powrprof propsys psapi rpcrt4 secur32 setupapi shell32 shlwapi user32 userenv ucrtbase usp10 version winhttp wininet winmm winspool wintrust windows.storage ws2_32 wsock32 wtsapi32').split(' ').map(name => name + '.dll'));

// Inspect only bounded PE import tables. Do not execute images or produce huge
// diagnostic dumps of unrelated export/unwind tables during dependency discovery.
export function parseWindowsDependencies(bytes) {
  const image = readWindowsPeImports(bytes);
  if (!image || image.machine !== 0x8664 || image.kind !== 'pe32+') throw Error('Expected a valid x64 PE image and import tables');
  const names = [...image.imports, ...image.delayImports];
  if (names.some(name => !validDll(name))) throw Error('Invalid DLL import name');
  return [...new Set(names)].sort();
}

export function isolatedWindowsEnvironment(input, bin) {
  if (!input.SystemRoot) throw Error('Windows system root is unavailable');
  const env = Object.fromEntries(Object.entries(input).filter(([name]) => name.toLowerCase() !== 'path'));
  env.PATH = [bin, path.win32.join(input.SystemRoot, 'System32'), input.SystemRoot].join(';');
  return env;
}

// Explicit OS components are not copied into the app. A named import still
// requires the real System32 file; arbitrary DLLs are never exempted merely
// because a similarly named file is present elsewhere on a build machine.
export async function isWindowsSystemImport(name, { systemRoot = process.env.SystemRoot, stat = lstat } = {}) {
  if (typeof name !== 'string' || !validDll(name)) return false;
  const normalized = name.toLowerCase();
  if (/^(?:api|ext)-ms-win-[a-z0-9_.-]+\.dll$/.test(normalized)) return true;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) || !systemNames.has(normalized)) return false;
  try { return (await stat(path.win32.join(systemRoot, 'System32', normalized))).isFile(); }
  catch { return false; }
}

export async function planRuntimeClosure({ entry, inspect, resolve, system, limit = 256 }) {
  const queue = [entry], files = new Map(), systemImports = new Set(), missing = new Set();
  while (queue.length) {
    const item = queue.shift(), key = item.name.toLowerCase();
    if (files.has(key)) continue;
    if (files.size >= limit) throw Error('Native runtime dependency limit exceeded');
    const imports = await inspect(item.file);
    files.set(key, { ...item, imports });
    for (const name of imports) {
      if (!validDll(name)) throw Error('Invalid DLL import name');
      if (await system(name)) { systemImports.add(name); continue; }
      const file = await resolve(name);
      if (!file) { missing.add(name); continue; }
      queue.push({ name, file });
    }
  }
  if (missing.size) throw Error((missing.size === 1 ? 'Missing runtime dependency: ' : 'Missing runtime dependencies: ') + [...missing].sort().join(', '));
  return { files: [...files.values()].sort((a, b) => a.name.localeCompare(b.name)), systemImports: [...systemImports].sort() };
}

export async function collectWindowsRuntime(native, runtimeDirectory, output) {
  if (process.platform !== 'win32') throw Error('Collect the runtime on Windows');
  if (path.basename(native).toLowerCase() !== 'scrcpy.exe') throw Error('Choose scrcpy.exe');
  const roots = [...new Set([path.dirname(path.resolve(native)), path.resolve(runtimeDirectory)])], index = new Map();
  for (const root of roots) for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!validDll(entry.name) || !entry.isFile()) continue;
    const name = entry.name.toLowerCase();
    index.set(name, [...(index.get(name) || []), path.join(root, entry.name)]);
  }
  const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
  const deadline = Date.now() + 180000;
  const plan = await planRuntimeClosure({ entry: { name: 'scrcpy.exe', file: path.resolve(native) },
    inspect: async file => {
      const info = await lstat(file);
      if (Date.now() > deadline || !info.isFile() || info.size > 256 * 1024 * 1024) throw Error('Runtime inspection did not finish');
      try { return parseWindowsDependencies(await readFile(file)); }
      catch { throw Error('Cannot inspect x64 runtime file: ' + path.basename(file)); }
    },
    resolve: async name => {
      const candidates = index.get(name) || [];
      const hashes = new Set(await Promise.all(candidates.map(digest)));
      if (hashes.size > 1) throw Error('Conflicting runtime dependency: ' + name);
      return candidates[0];
    },
    system: name => isWindowsSystemImport(name),
  });
  // Resolve every dependency before creating a new output. Never overwrite a
  // developer runtime, a running host, or another package.
  await mkdir(output);
  const manifest = { schemaVersion: 1, platform: 'win32', architecture: 'x64', executable: 'scrcpy.exe', files: [], systemImports: plan.systemImports };
  for (const item of plan.files) {
    await cp(item.file, path.join(output, item.name), { errorOnExist: true, force: false });
    manifest.files.push({ name: item.name, sha256: await digest(item.file), imports: item.imports });
  }
  let help;
  try {
    help = (await execute(path.resolve(output, 'scrcpy.exe'), ['--help'], { cwd: output, timeout: 10000,
      killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, env: isolatedWindowsEnvironment(process.env, path.resolve(output)) })).stdout;
  } catch (error) {
    const code = Number.isSafeInteger(error.code) ? String(error.code) : error.killed ? 'timeout' : 'unavailable';
    throw Error('Collected native help failed: ' + code);
  }
  if (!help.includes('--reverse-socket')) throw Error('Collected native help lacks browser hosting');
  manifest.qualification = { nativeHelp: true, externalMsysPathUsed: false, physicalCapture: false, cleanMinimumWindows: false, noticesReviewed: false };
  await writeFile(path.join(output, 'runtime-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [native, runtime, output] = process.argv.slice(2);
  if (!native || !runtime || !output) { console.error('Usage: node desktop/collect-windows-runtime.mjs NATIVE RUNTIME_DIRECTORY NEW_OUTPUT'); process.exitCode = 1; }
  else collectWindowsRuntime(path.resolve(native), path.resolve(runtime), path.resolve(output))
    .then(result => console.log('Collected ' + result.files.length + ' x64 runtime files; --help loads without external MSYS PATH.'))
    .catch(error => { console.error(/^(?:Missing runtime dependenc(?:y|ies)|Conflicting runtime dependency): [a-z0-9_.+-]+\.dll(?:, [a-z0-9_.+-]+\.dll)*$/i.test(error.message)
      ? error.message : /^(?:Cannot inspect x64 runtime file: [a-z0-9_.+-]+\.(?:dll|exe)|Collected native help failed: (?:-?[0-9]+|timeout|unavailable)|Collected native help lacks browser hosting|Native runtime dependency limit exceeded|Runtime inspection did not finish)$/.test(error.message)
        ? error.message : 'Windows runtime collection failed (' + (/^E[A-Z0-9]+$/.test(error.code || '') ? error.code : 'unknown') + '); check the toolchain and new output.'); process.exitCode = 1; });
}
