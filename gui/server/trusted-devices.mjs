import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const TRUST_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
export const deviceDigest = token => createHash('sha256').update(token).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function deviceName(value) {
  if (typeof value !== 'string') throw new Error('Enter a device name.');
  const name = value.normalize('NFC').trim();
  if (!name || name.length > 60 || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new Error('Use a device name of 1–60 characters.');
  return name;
}
function validEntry(d) {
  return d && Object.keys(d).sort().join(',') === 'createdAt,digest,expiresAt,id,name,origin,profile' && /^[a-f0-9]{32}$/.test(d.id) && validHash(d.digest) && deviceName(d.name) === d.name
    && new URL(d.origin).origin === d.origin && d.origin.startsWith('https://')
    && Number.isSafeInteger(d.expiresAt) && Number.isSafeInteger(d.createdAt)
    && d.profile && typeof d.profile === 'object' && !Array.isArray(d.profile)
    && Object.keys(d.profile).every(k => ['maxSize', 'maxFps', 'bitRateMbps'].includes(k))
    && Object.values(d.profile).every(v => Number.isFinite(v) && v > 0 && v <= 8192);
}
// Store only hashes of 256-bit browser credentials. No reusable plaintext
// password/token, native paths, device addresses or one-use invitation is saved.
export function createTrustedDevices({ filename, now = Date.now } = {}) {
  let data = { version: 1, paused: false, devices: [] }, failed = false, serial = Promise.resolve();
  const ready = (async () => {
    if (!filename) return;
    let file;
    try {
      file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await file.stat();
      if (!info.isFile() || info.size > 65536) throw new Error();
      const loaded = JSON.parse(await file.readFile('utf8'));
      if (loaded.version !== 1 || typeof loaded.paused !== 'boolean' || !Array.isArray(loaded.devices)
          || loaded.devices.length > 20 || !loaded.devices.every(validEntry)
          || new Set(loaded.devices.map(d => d.id)).size !== loaded.devices.length
          || new Set(loaded.devices.map(d => d.digest)).size !== loaded.devices.length) throw new Error();
      data = loaded;
    } catch (error) { if (error.code !== 'ENOENT') { failed = true; data.paused = true; } }
    finally { await file?.close(); }
  })();
  async function save() {
    if (!filename) throw new Error('Remembered access is unavailable in this host.');
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temp = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
    let file;
    try {
      file = await open(temp, 'wx', 0o600);
      await file.writeFile(JSON.stringify(data) + '\n'); await file.sync(); await file.close(); file = null;
      await rename(temp, filename);
    } catch { failed = true; data.paused = true; throw new Error('Could not save remembered access. Access is paused; check host storage.'); }
    finally { await file?.close(); await rm(temp, { force: true }); }
  }
  const mutate = action => {
    const operation = serial.then(async () => { await ready; if (failed) throw new Error('Remembered access storage needs attention.'); return action(); });
    serial = operation.catch(() => {}); return operation;
  };
  function find(token, origin, includePaused = false) {
    if (failed || (!includePaused && data.paused) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const digest = Buffer.from(deviceDigest(token), 'hex');
    return data.devices.find(d => d.origin === origin && d.expiresAt > now()
      && timingSafeEqual(Buffer.from(d.digest, 'hex'), digest)) || null;
  }
  function snapshot() {
    return { available: Boolean(filename) && !failed, paused: data.paused, storageError: failed,
      devices: data.devices.filter(d => d.expiresAt > now()).map(({ digest, profile, origin, ...publicDevice }) => publicDevice) };
  }
  return { ready, snapshot, find,
    enabled: id => !failed && !data.paused && data.devices.some(d => d.id === id && d.expiresAt > now()),
    allowed: (id, digest) => !failed && !data.paused && data.devices.some(d => d.id === id && d.digest === digest && d.expiresAt > now()),
    approve: d => mutate(async () => {
      const next = { ...d, name: deviceName(d.name), createdAt: now(), expiresAt: now() + TRUST_LIFETIME_MS };
      if (!validEntry(next)) throw new Error('Invalid device enrollment.');
      data.devices = data.devices.filter(d => d.expiresAt > now());
      if (data.devices.length >= 20 || data.devices.some(item => item.id === d.id || item.digest === d.digest)) throw new Error('Device limit reached or already approved.');
      data.devices.push(next); await save(); return snapshot();
    }),
    pause: value => mutate(async () => { data.paused = value === true; await save(); return snapshot(); }),
    revoke: id => mutate(async () => { data.devices = data.devices.filter(d => d.id !== id); await save(); return snapshot(); }),
    // Synchronous fail-closed guard used before awaiting disk or capture cleanup.
    block() { data.paused = true; },
  };
}
