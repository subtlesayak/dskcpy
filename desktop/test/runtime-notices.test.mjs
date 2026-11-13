import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WERIFT_NOTICE, stageRuntimeNotices, verifyRuntimeNotices } from '../runtime-notices.mjs';
import { inventory } from '../../tools/build-identity.mjs';

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-notices-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'), host = path.join(root, 'host');
  await mkdir(path.join(app, 'node_modules/werift'), { recursive: true });
  await writeFile(path.join(app, 'node_modules/werift/package.json'), JSON.stringify({ name: 'werift', version: '0.27.0', license: 'MIT', ...overrides }));
  return { root, app, host, notice: path.join(host, 'licenses', WERIFT_NOTICE.file) };
}
test('exact dependency receives its upstream notice without replacing bundled third-party text', async t => {
  const f = await fixture(t), thirdParty = path.join(f.app, 'node_modules/werift/THIRD_PARTY_LICENSES_LIBWEBRTC.txt');
  await writeFile(thirdParty, 'existing upstream libwebrtc notice');
  const runtimeNotices = await stageRuntimeNotices(f.app, f.host);
  const manifest = { runtimeNotices, files: await inventory(f.root) };
  assert.deepEqual(await verifyRuntimeNotices(f.app, f.host, manifest), { supplementalRuntimeNoticesVerified: 1, completeNoticesReviewed: false });
  assert.equal(await readFile(thirdParty, 'utf8'), 'existing upstream libwebrtc notice');
  assert.match(await readFile(f.notice, 'utf8'), /^MIT License/);
  await assert.rejects(stageRuntimeNotices(f.app, f.host), { code: 'EEXIST' });
});
for (const override of [{ version: '0.28.0' }, { license: 'Unknown' }, { name: 'different-package' }]) {
  test(`changed dependency requires notice review: ${JSON.stringify(override)}`, async t => {
    const f = await fixture(t, override);
    await assert.rejects(stageRuntimeNotices(f.app, f.host), /Review the runtime notice/);
  });
}
test('missing, modified and forged-hash notice payloads cannot pass bundle verification', async t => {
  const f = await fixture(t), runtimeNotices = await stageRuntimeNotices(f.app, f.host);
  const manifest = { runtimeNotices, files: await inventory(f.root) };
  const original = await readFile(f.notice);
  await writeFile(f.notice, 'modified');
  await assert.rejects(verifyRuntimeNotices(f.app, f.host, manifest), /changed runtime notice/);
  const forged = { runtimeNotices, files: await inventory(f.root) };
  await assert.rejects(verifyRuntimeNotices(f.app, f.host, forged), /changed runtime notice/);
  await writeFile(f.notice, original);
  await assert.rejects(verifyRuntimeNotices(f.app, f.host, { ...manifest, runtimeNotices: [] }), /notice record/);
  await assert.rejects(verifyRuntimeNotices(f.app, f.host, { ...manifest, runtimeNotices: [{ ...WERIFT_NOTICE, sha256: '0'.repeat(64) }] }), /notice record/);
  await rm(f.notice);
  await assert.rejects(verifyRuntimeNotices(f.app, f.host, manifest), { code: 'ENOENT' });
});
test('linked notice files are rejected even when their bytes match', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), runtimeNotices = await stageRuntimeNotices(f.app, f.host);
  const manifest = { runtimeNotices, files: await inventory(f.root) }, original = await readFile(f.notice);
  await rm(f.notice); const target = path.join(f.root, 'notice-target.txt');
  await writeFile(target, original); await symlink(target, f.notice);
  await assert.rejects(verifyRuntimeNotices(f.app, f.host, manifest), /changed runtime notice/);
});
