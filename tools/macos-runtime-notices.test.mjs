import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { inventory } from './build-identity.mjs';
import { WERIFT_NOTICE, stageRuntimeNotices, verifyRuntimeNotices } from '../desktop/runtime-notices.mjs';
import { verifyPackagedRuntimeNotices } from '../release/package_macos_host.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const tree = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-terminal-notices-'));
  t.after(() => rm(tree, { recursive: true, force: true }));
  const gui = path.join(tree, 'gui'), pkg = path.join(gui, 'node_modules/werift');
  await mkdir(pkg, { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'werift', version: '0.27.0', license: 'MIT' }));
  const thirdParty = path.join(pkg, 'THIRD_PARTY_LICENSES_LIBWEBRTC.txt');
  await writeFile(thirdParty, 'Existing separate libwebrtc notice');
  const notice = path.join(tree, 'licenses', WERIFT_NOTICE.file);
  const save = async runtimeNotices => {
    const manifest = { product: 'dskcpy-macos-host', runtimeNotices,
      files: (await inventory(tree)).filter(entry => entry.path !== 'build-manifest.json') };
    await writeFile(path.join(tree, 'build-manifest.json'), JSON.stringify(manifest));
    return manifest;
  };
  return { tree, gui, pkg, thirdParty, notice, save };
}

test('Terminal package rejects the old omitted primary notice, then checks its own root inventory layout', async t => {
  const f = await fixture(t);
  await f.save(undefined);
  await assert.rejects(verifyPackagedRuntimeNotices(f.tree), /notice record/);
  const notices = await stageRuntimeNotices(f.gui, f.tree), manifest = await f.save(notices);
  assert.deepEqual(await verifyPackagedRuntimeNotices(f.tree), {
    supplementalRuntimeNoticesVerified: 1, completeNoticesReviewed: false,
  });
  assert.equal(await readFile(f.thirdParty, 'utf8'), 'Existing separate libwebrtc notice');
  assert.match(await readFile(f.notice, 'utf8'), /^MIT License/);
  // The desktop inventory layout cannot accidentally qualify a Terminal tree.
  await assert.rejects(verifyRuntimeNotices(f.gui, f.tree, manifest), /changed runtime notice/);
  for (const inventoryPrefix of ['../', '/absolute/', 'gui/'])
    await assert.rejects(verifyRuntimeNotices(f.gui, f.tree, manifest, { inventoryPrefix }), /Unsupported runtime notice layout/);
});

test('Terminal notice check rejects modified bytes even with a refreshed untrusted manifest hash', async t => {
  const f = await fixture(t), notices = await stageRuntimeNotices(f.gui, f.tree);
  await f.save(notices);
  await writeFile(f.notice, 'Changed text');
  await f.save(notices);
  await assert.rejects(verifyPackagedRuntimeNotices(f.tree), /changed runtime notice/);
  await rm(f.notice);
  await assert.rejects(verifyPackagedRuntimeNotices(f.tree), { code: 'ENOENT' });
});

test('Terminal notice check requires reviewed package identity and the pinned record', async t => {
  const f = await fixture(t), notices = await stageRuntimeNotices(f.gui, f.tree);
  await f.save(notices);
  await writeFile(path.join(f.pkg, 'package.json'), JSON.stringify({ name: 'werift', version: '0.28.0', license: 'MIT' }));
  await assert.rejects(verifyPackagedRuntimeNotices(f.tree), /Review the runtime notice/);
  await writeFile(path.join(f.pkg, 'package.json'), JSON.stringify({ name: 'werift', version: '0.27.0', license: 'MIT' }));
  await f.save([{ ...notices[0], sha256: '0'.repeat(64) }]);
  await assert.rejects(verifyPackagedRuntimeNotices(f.tree), /notice record/);
});

test('Terminal notice check rejects linked notice bytes', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t), notices = await stageRuntimeNotices(f.gui, f.tree);
  await f.save(notices);
  const bytes = await readFile(f.notice), target = path.join(f.tree, 'another-notice');
  await rm(f.notice); await writeFile(target, bytes); await symlink(target, f.notice);
  await assert.rejects(verifyPackagedRuntimeNotices(f.tree), /changed runtime notice/);
});

test('notice-only CLI checks a package without native programs and rejects another product', async t => {
  const f = await fixture(t), notices = await stageRuntimeNotices(f.gui, f.tree);
  const manifest = await f.save(notices);
  const cli = fileURLToPath(new URL('../release/package_macos_host.mjs', import.meta.url));
  const { stdout } = await execute(process.execPath, [cli, '--check-notices', f.tree], { timeout: 10000 });
  assert.deepEqual(JSON.parse(stdout), { supplementalRuntimeNoticesVerified: 1, completeNoticesReviewed: false });
  await writeFile(path.join(f.tree, 'build-manifest.json'), JSON.stringify({ ...manifest, product: 'other' }));
  await assert.rejects(execute(process.execPath, [cli, '--check-notices', f.tree], { timeout: 10000 }),
    error => error.code === 1 && /runtime notice check failed/.test(error.stderr));
});
