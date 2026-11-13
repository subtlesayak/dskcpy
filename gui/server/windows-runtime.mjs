import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Read only the PE import names, never load/execute the image. Malformed or
// unusually large images fall back to an explicit/default runtime choice.
// Layout reference: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
export function readWindowsPeImports(bytes, { includeDelay = true } = {}) {
  const contains = (offset, size) => Number.isInteger(offset) && offset >= 0 && offset + size <= bytes.length;
  if (!contains(0, 64) || bytes.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = bytes.readUInt32LE(60);
  if (!contains(pe, 24) || bytes.readUInt32LE(pe) !== 0x4550) return null;
  const count = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24, sections = optional + optionalSize;
  if (!count || count > 96 || !contains(optional, optionalSize) || !contains(sections, count * 40)) return null;
  const magic = bytes.readUInt16LE(optional), directory = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
  if (!directory || optionalSize < directory + 16) return null;
  const directories = bytes.readUInt32LE(optional + directory - 4);
  if (directories < 2) return null;
  const rvaOffset = (rva, size) => {
    for (let i = 0; i < count; ++i) {
      const section = sections + i * 40;
      const base = bytes.readUInt32LE(section + 12), length = bytes.readUInt32LE(section + 16);
      const raw = bytes.readUInt32LE(section + 20);
      if (rva >= base && rva - base + size <= length && contains(raw + rva - base, size)) return raw + rva - base;
    }
    return null;
  };
  const readName = rva => {
    let name = '';
    for (let j = 0; j < 256; ++j) {
      const offset = rvaOffset(rva + j, 1);
      if (offset === null) return null;
      const byte = bytes[offset];
      if (!byte) return name;
      if (byte < 32 || byte > 126) return null;
      name += String.fromCharCode(byte).toLowerCase();
    }
    return null;
  };
  function table(index, width, nameOffset, delayed = false) {
    if (directories <= index) return [];
    if (optionalSize < directory + (index + 1) * 8) return null;
    const rva = bytes.readUInt32LE(optional + directory + index * 8);
    const size = bytes.readUInt32LE(optional + directory + index * 8 + 4);
    if (!rva && !size) return [];
    if (!rva || size < width) return null;
    const names = [];
    for (let i = 0; i < Math.min(256, Math.floor(size / width)); ++i) {
      const descriptor = rvaOffset(rva + i * width, width);
      if (descriptor === null) return null;
      if (bytes.subarray(descriptor, descriptor + width).every(byte => byte === 0)) return names;
      let nameRva = bytes.readUInt32LE(descriptor + nameOffset);
      if (delayed) {
        const attributes = bytes.readUInt32LE(descriptor);
        if (attributes & ~1) return null;
        if (!(attributes & 1)) {
          const imageBase = magic === 0x20b ? bytes.readBigUInt64LE(optional + 24) : BigInt(bytes.readUInt32LE(optional + 28));
          const converted = BigInt(nameRva) - imageBase;
          if (converted < 0n || converted > 0xffffffffn) return null;
          nameRva = Number(converted);
        }
      }
      const name = readName(nameRva);
      if (name === null) return null;
      names.push(name);
    }
    return null;
  }
  const imports = table(1, 20, 12), delayImports = includeDelay ? table(13, 32, 4, true) : [];
  if (!imports || !delayImports) return null;
  return { machine: bytes.readUInt16LE(pe + 4), kind: magic === 0x20b ? 'pe32+' : 'pe32', imports, delayImports };
}

export function detectWindowsCrt(bytes) {
  const image = readWindowsPeImports(bytes, { includeDelay: false });
  if (!image) return null;
  const ucrt = image.imports.some(name => name === 'ucrtbase.dll' || name.startsWith('api-ms-win-crt-'));
  const msvcrt = image.imports.includes('msvcrt.dll');
  return ucrt === msvcrt ? null : ucrt ? 'ucrt64' : 'mingw64';
}

function binaryFamily(binary) {
  try {
    if (!binary || statSync(binary).size > 32 * 1024 * 1024) return null;
    return detectWindowsCrt(readFileSync(binary));
  } catch { return null; }
}
function isDirectory(file) { try { return statSync(file).isDirectory(); } catch { return false; } }

export function windowsRuntimeEnvironment(input, binary, { family = binaryFamily(binary), exists = isDirectory } = {}) {
  const env = { ...input };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const entries = (env[pathKey] || '').split(';').filter(Boolean);
  const knownBin = (entry) => /[\\/](?:ucrt64|mingw64|mingw32|clang64|clang32|clangarm64)[\\/]bin[\\/]?$/i.test(entry.replace(/^"|"$/g, ''));
  let runtime = env.SCRCPY_RUNTIME_DIR || (env.MINGW_PREFIX ? path.win32.join(env.MINGW_PREFIX, 'bin') : null);
  if (!runtime) {
    const roots = [...new Set(entries.filter(knownBin).map((entry) => path.win32.resolve(entry.replace(/^"|"$/g, ''), '../..'))),
      path.win32.join(env.SystemDrive || 'C:', 'msys64')];
    const families = family ? [family] : ['ucrt64', 'mingw64'];
    runtime = families.flatMap((name) => roots.map((root) => path.win32.join(root, name, 'bin'))).find(exists)
      || path.win32.join(roots.at(-1), family || 'ucrt64', 'bin');
  }
  // Avoid selecting a UCRT executable with legacy MSVCRT DLLs (or vice versa).
  // All changes stay in this child environment; global PATH remains untouched.
  env[pathKey] = [runtime, ...entries.filter((entry) => !knownBin(entry))].join(';');
  return { env, runtime, family };
}
