import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Read only the PE import names, never load/execute the image. Malformed or
// unusually large images fall back to an explicit/default runtime choice.
// Layout reference: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
export function detectWindowsCrt(bytes) {
  const contains = (offset, size) => Number.isInteger(offset) && offset >= 0 && offset + size <= bytes.length;
  if (!contains(0, 64) || bytes.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = bytes.readUInt32LE(60);
  if (!contains(pe, 24) || bytes.readUInt32LE(pe) !== 0x4550) return null;
  const count = bytes.readUInt16LE(pe + 6), optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24, sections = optional + optionalSize;
  if (!count || count > 96 || !contains(optional, optionalSize) || !contains(sections, count * 40)) return null;
  const magic = bytes.readUInt16LE(optional);
  const directory = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
  if (!directory || optionalSize < directory + 16 || bytes.readUInt32LE(optional + directory - 4) < 2) return null;
  const imports = bytes.readUInt32LE(optional + directory + 8);
  const importSize = bytes.readUInt32LE(optional + directory + 12);
  if (!imports || importSize < 20) return null;
  const rvaOffset = (rva, size) => {
    for (let i = 0; i < count; ++i) {
      const section = sections + i * 40;
      const base = bytes.readUInt32LE(section + 12), length = bytes.readUInt32LE(section + 16);
      const raw = bytes.readUInt32LE(section + 20);
      if (rva >= base && rva - base + size <= length && contains(raw + rva - base, size)) return raw + rva - base;
    }
    return null;
  };
  let ucrt = false, msvcrt = false;
  for (let i = 0; i < Math.min(256, Math.floor(importSize / 20)); ++i) {
    const descriptor = rvaOffset(imports + i * 20, 20);
    if (descriptor === null) return null;
    if (bytes.subarray(descriptor, descriptor + 20).every((byte) => byte === 0)) {
      return ucrt === msvcrt ? null : ucrt ? 'ucrt64' : 'mingw64';
    }
    const nameRva = bytes.readUInt32LE(descriptor + 12);
    let name = '', terminated = false;
    for (let j = 0; j < 256; ++j) {
      const offset = rvaOffset(nameRva + j, 1);
      if (offset === null) return null;
      const byte = bytes[offset];
      if (!byte) { terminated = true; break; }
      if (byte < 32 || byte > 126) return null;
      name += String.fromCharCode(byte).toLowerCase();
    }
    if (!terminated) return null;
    if (name === 'ucrtbase.dll' || name.startsWith('api-ms-win-crt-')) ucrt = true;
    if (name === 'msvcrt.dll') msvcrt = true;
  }
  return null;
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
