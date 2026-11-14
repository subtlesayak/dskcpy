import { readFile } from 'node:fs/promises';
import { readWindowsPeImports } from '../gui/server/windows-runtime.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Run before meson test. The fixture needs only Unicode conversion in kernel32
// and the C runtime; clipboard, UI/capture and external runtime DLLs are forbidden.
export function checkClipboardFixtureImage(image) {
  if (!image || image.machine !== 0x8664 || image.kind !== 'pe32+' ||
      !Array.isArray(image.imports) || !Array.isArray(image.delayImports))
    throw Error('Expected a bounded x64 clipboard fixture image');
  const imports = [...image.imports, ...image.delayImports].map(name => name.toLowerCase());
  if (!imports.includes('kernel32.dll') || imports.some(name =>
    !['kernel32.dll', 'msvcrt.dll', 'ucrtbase.dll'].includes(name) && !/^api-ms-win-crt-[a-z0-9-]+\.dll$/.test(name)))
    throw Error('Clipboard fixture must import only Unicode and C runtime DLLs');
  return { machine: 'x64', imports: [...new Set(imports)].sort(), osClipboardDllImported: false, captureDllImported: false };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const file = process.argv[2];
    if (!file) throw Error('Missing fixture');
    const result = checkClipboardFixtureImage(readWindowsPeImports(await readFile(file)));
    console.log(JSON.stringify(result));
  } catch {
    console.error('Clipboard fixture import check failed; do not execute this fixture.');
    process.exitCode = 1;
  }
}
