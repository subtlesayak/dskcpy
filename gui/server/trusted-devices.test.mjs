import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createTrustedDevices, deviceDigest, deviceName, TRUST_LIFETIME_MS } from './trusted-devices.mjs';
import { receiverIsAway } from '../receiver/lifecycle.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-trust-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'private', 'devices.json');
}
const grant = (token, now = Date.now()) => ({ id: randomBytes(16).toString('hex'), digest: deviceDigest(token),
  origin: 'https://host.example', name: 'Test browser', profile: { maxSize: 1600, maxFps: 30, bitRateMbps: 8 } });

test('browser credentials persist only as hashes; approval survives restart and is origin bound', async t => {
  const filename = await fixture(t), token = randomBytes(32).toString('base64url'), g = grant(token);
  const store = createTrustedDevices({ filename }); await store.ready;
  assert.equal(store.find(token, g.origin), null);
  await store.approve(g);
  assert.equal(store.find(token, g.origin).id, g.id);
  assert.equal(store.find(token, 'https://other.example'), null);
  const saved = await readFile(filename, 'utf8'); assert.ok(!saved.includes(token));
  assert.ok(!JSON.stringify(store.snapshot()).includes(g.digest));
  if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777, 0o600);
  const restart = createTrustedDevices({ filename }); await restart.ready;
  assert.equal(restart.find(token, g.origin).id, g.id);
  await restart.pause(true); assert.equal(restart.find(token, g.origin), null);
  const pausedRestart = createTrustedDevices({ filename }); await pausedRestart.ready;
  assert.equal(pausedRestart.find(token, g.origin), null);
  assert.equal(pausedRestart.find(token, g.origin, true).id, g.id);
  await pausedRestart.pause(false); assert.equal(pausedRestart.find(token, g.origin).id, g.id);
  await pausedRestart.revoke(g.id); assert.equal(pausedRestart.find(token, g.origin), null);
  const revokedRestart = createTrustedDevices({ filename }); await revokedRestart.ready;
  assert.equal(revokedRestart.find(token, g.origin), null);
});

test('expired, malformed and corrupt registry data fail closed', async t => {
  const filename = await fixture(t), token = randomBytes(32).toString('base64url'); let now = 1000;
  const store = createTrustedDevices({ filename, now: () => now }); await store.ready;
  await store.approve(grant(token)); now += TRUST_LIFETIME_MS + 1;
  assert.equal(store.find(token, 'https://host.example'), null);
  await writeFile(filename, '{bad'); const broken = createTrustedDevices({ filename }); await broken.ready;
  assert.equal(broken.snapshot().available, false); assert.equal(broken.snapshot().paused, true);
  await assert.rejects(broken.pause(false), /storage/);
  for (const name of ['', 'x'.repeat(61), 'a\nb', '\u202eevil']) assert.throws(() => deviceName(name));
  assert.equal(deviceName(' My phone '), 'My phone');
});

test('storage failures never acknowledge approval and immediately block new access', async t => {
  const filename = await fixture(t);
  const store = createTrustedDevices({ filename }); await store.ready;
  // Introduce the obstruction after a clean load on every platform, so this
  // exercises the write failure rather than platform-specific open errors.
  await writeFile(path.dirname(filename), 'not a directory');
  await assert.rejects(store.approve(grant(randomBytes(32).toString('base64url'))));
  assert.equal(store.snapshot().available, false); assert.equal(store.snapshot().paused, true);
});

test('PiP visibility keeps playback live but normal background pages remain away', () => {
  const video = {};
  assert.equal(receiverIsAway({ hidden: true, video }), true);
  assert.equal(receiverIsAway({ hidden: false, video }), false);
  assert.equal(receiverIsAway({ hidden: true, video, pictureInPictureElement: video }), false);
  assert.equal(receiverIsAway({ hidden: true, video, pictureInPictureElement: {} }), true);
  assert.equal(receiverIsAway({ hidden: true, video, presentationMode: 'picture-in-picture' }), false);
});
