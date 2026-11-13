import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { inventory, hashFile } from '../tools/build-identity.mjs';

const codeRoots = ['app/desktop', 'app/gui'];
const prunedBuildMetadata = new Set(['app/gui/package-lock.json']);
const nativeRoot = 'host/bin';
const metadata = ['app/package.json'];
const selected = name => !prunedBuildMetadata.has(name) && (metadata.includes(name) || [...codeRoots, nativeRoot].some(root => name.startsWith(root + '/')));

// electron-builder intentionally prunes lockfiles, declarations and tests in
// third-party packages and rewrites some of their metadata. Compare the whole
// first-party/native payload to stage, not an arbitrary subset of entry points.
export async function verifyRuntimePayload(resources, manifest) {
  if (!Array.isArray(manifest?.files) || !manifest.files.length || manifest.files.length > 100000) throw Error('Invalid payload inventory');
  const expected = new Map(), names = new Set();
  for (const entry of manifest.files) {
    const name = entry?.path;
    if (typeof name !== 'string' || !/^(app|host)\//.test(name) || /[\\\x00-\x1f\x7f]/.test(name)
        || path.posix.normalize(name) !== name || name.split('/').includes('..') || name.endsWith('/')
        || names.has(name) || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw Error('Invalid payload inventory');
    names.add(name); if (selected(name)) expected.set(name, entry);
  }
  const actual = [];
  for (const root of [...codeRoots, nativeRoot]) {
    let prefix = '';
    for (const part of root.split('/')) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const info = await lstat(path.join(resources, prefix));
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Payload directory must not be a link');
    }
    actual.push(...(await inventory(resources, root)).filter(entry => !prunedBuildMetadata.has(entry.path)));
  }
  for (const name of metadata) {
    const info = await lstat(path.join(resources, name));
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Payload metadata must be a regular file');
    actual.push({path:name,bytes:info.size,sha256:await hashFile(path.join(resources,name))});
  }
  if (actual.length !== expected.size) throw Error('Packaged payload file set differs from stage');
  for (const entry of actual) {
    const match = expected.get(entry.path);
    if (!match || match.sha256 !== entry.sha256 || match.bytes !== entry.bytes) throw Error('Packaged payload differs from stage');
  }
  return { firstPartyFilesVerified:actual.filter(entry=>entry.path.startsWith('app/')).length,
    nativeRuntimeFilesVerified:actual.filter(entry=>entry.path.startsWith(nativeRoot+'/')).length };
}
