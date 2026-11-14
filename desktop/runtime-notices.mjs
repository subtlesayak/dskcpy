import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// The published 0.27.0 package includes libwebrtc's third-party notice, but
// omits werift's own MIT text. Supplement from the exact upstream release.
// This is a file-presence/integrity gate, not complete release/legal approval.
export const WERIFT_NOTICE = Object.freeze({
  package: 'werift', version: '0.27.0', license: 'MIT',
  file: 'werift-0.27.0-LICENSE.txt',
  sha256: 'b83683f3f71b5971e6c2e33a8b894a49d752fd24c11b8ae08b53ca20f594fca5',
  upstream: 'https://github.com/shinyoshiaki/werift-webrtc/blob/23292efc644f1048041433a76fbcf4b6d62bfd46/LICENSE',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function checkPackage(app) {
  const metadata = JSON.parse(await readFile(path.join(app, 'node_modules/werift/package.json'), 'utf8'));
  if (metadata.name !== WERIFT_NOTICE.package || metadata.version !== WERIFT_NOTICE.version || metadata.license !== WERIFT_NOTICE.license)
    throw Error('Review the runtime notice for the changed werift dependency');
}
export async function stageRuntimeNotices(app, host) {
  await checkPackage(app);
  const bytes = await readFile(new URL(`./notices/${WERIFT_NOTICE.file}`, import.meta.url));
  if (hash(bytes) !== WERIFT_NOTICE.sha256) throw Error('Pinned upstream runtime notice changed');
  await mkdir(path.join(host, 'licenses'), { recursive: true });
  await writeFile(path.join(host, 'licenses', WERIFT_NOTICE.file), bytes, { flag: 'wx' });
  return [{ ...WERIFT_NOTICE }];
}
export async function verifyRuntimeNotices(app, host, manifest) {
  await checkPackage(app);
  if (!Array.isArray(manifest.runtimeNotices) || manifest.runtimeNotices.length !== 1 ||
      Object.entries(WERIFT_NOTICE).some(([key, value]) => manifest.runtimeNotices[0]?.[key] !== value))
    throw Error('Missing or changed runtime notice record');
  const relative = `host/licenses/${WERIFT_NOTICE.file}`, file = path.join(host, 'licenses', WERIFT_NOTICE.file);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || hash(await readFile(file)) !== WERIFT_NOTICE.sha256 ||
      manifest.files.find(entry => entry.path === relative)?.sha256 !== WERIFT_NOTICE.sha256)
    throw Error('Missing or changed runtime notice');
  return { supplementalRuntimeNoticesVerified: 1, completeNoticesReviewed: false };
}
