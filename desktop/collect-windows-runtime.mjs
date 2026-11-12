import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, lstat, readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const validDll = name => /^[a-z0-9_.+-]+\.dll$/i.test(name);
const systemNames = new Set(('advapi32 authz avrt bcrypt cfgmgr32 comctl32 comdlg32 crypt32 cryptbase d3d11 dcomp dhcpcsvc dinput8 dnsapi dwmapi dxgi gdi32 imm32 iphlpapi kernel32 kernelbase mf mfplat mfreadwrite mfuuid mpr msacm32 msimg32 msvcrt msvcp_win normaliz ntdll ole32 oleaut32 opengl32 powrprof propsys psapi rpcrt4 secur32 setupapi shell32 shlwapi user32 ucrtbase version winhttp wininet winmm winspool wintrust windows.storage ws2_32 wtsapi32').split(' ').map(name => name + '.dll'));

// GNU objdump comes from the build toolchain only. The installed host never
// needs objdump, MSYS or a compiler. Reject foreign images and unsafe names.
export function parseWindowsDependencies(output) {
  if (!/\bfile format pei-x86-64\b/.test(output)) throw Error('Expected an x64 PE executable or DLL');
  const names = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('DLL Name:')) continue;
    const match = /^\s*DLL Name:\s+(\S+)\s*$/.exec(line);
    if (!match || !validDll(match[1])) throw Error('Invalid DLL import name');
    names.push(match[1].toLowerCase());
  }
  return [...new Set(names)].sort();
}

export function isolatedWindowsEnvironment(input, bin) {
  if (!input.SystemRoot) throw Error('Windows system root is unavailable');
  const env = Object.fromEntries(Object.entries(input).filter(([name]) => name.toLowerCase() !== 'path'));
  env.PATH = [bin, path.win32.join(input.SystemRoot, 'System32'), input.SystemRoot].join(';');
  return env;
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

export async function collectWindowsRuntime(native, runtimeDirectory, output, { objdump = path.join(runtimeDirectory, 'objdump.exe') } = {}) {
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
      if (Date.now() > deadline || !(await lstat(file)).isFile()) throw Error('Runtime inspection did not finish');
      try {
        const { stdout } = await execute(objdump, ['-f', '-p', file], { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
        return parseWindowsDependencies(stdout);
      } catch { throw Error('Cannot inspect x64 runtime file: ' + path.basename(file)); }
    },
    resolve: async name => {
      const candidates = index.get(name) || [];
      const hashes = new Set(await Promise.all(candidates.map(digest)));
      if (hashes.size > 1) throw Error('Conflicting runtime dependency: ' + name);
      return candidates[0];
    },
    system: async name => {
      if (/^(?:api|ext)-ms-win-[a-z0-9_.-]+\.dll$/i.test(name)) return true;
      if (!systemNames.has(name)) return false;
      try { return (await lstat(path.join(process.env.SystemRoot, 'System32', name))).isFile(); } catch { return false; }
    },
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
