export const directoryMessage = 'dskcpy-computers-v1';
export const pairedAppIntent = 'dskcpy.paired-app-intent.v1';
export const pairedComputersKey = 'dskcpy.paired-computers.v1';
export const channelToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const publicIdentity = value => channelToken(value?.fingerprint)
  && typeof value?.publicKey === 'string' && /^[A-Za-z0-9_-]{122}$/.test(value.publicKey);
export const computerName = value => typeof value === 'string' && value.length > 0 && value.length <= 60
  && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value);
export const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');

export function receiverAddress(value, invitation = false) {
  if (typeof value !== 'string' || value.length > 512) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search) return null;
    if (!invitation && (url.pathname !== '/' || url.hash)) return null;
    if (invitation && !/^\/(?:join(?:\/[a-f0-9]{32})?)?$/.test(url.pathname)) return null;
    if (url.hash && !/^#connect=[A-Za-z0-9_-]{32}$/.test(url.hash)) return null;
    return url;
  } catch { return null; }
}

export function readPairedComputers() {
  try {
    const saved = JSON.parse(localStorage.getItem(pairedComputersKey));
    return Array.isArray(saved) ? saved.slice(0, 16).filter(item => publicIdentity(item) && computerName(item.name)
      && receiverAddress(item.origin)?.origin === item.origin && (item.binding === null || channelToken(item.binding))) : [];
  } catch { return []; }
}

const unbase64url = value => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

export async function proveComputer(origin, identity, { request = fetch, challenge = nonce() } = {}) {
  if (!receiverAddress(origin) || !publicIdentity(identity)) throw Error('Invalid computer identity.');
  const response = await request(`${origin}/pairing-identity?challenge=${challenge}`, {
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return 'unavailable';
  const proof = await response.json();
  if (!publicIdentity(proof) || identity.fingerprint !== proof.fingerprint || identity.publicKey !== proof.publicKey
      || !/^[A-Za-z0-9_-]{86}$/.test(proof.signature || '')) return 'changed';
  const encoded = unbase64url(identity.publicKey);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== identity.fingerprint) return 'changed';
  const key = await crypto.subtle.importKey('spki', encoded, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const message = new TextEncoder().encode(JSON.stringify(['dskcpy-host-v1', origin, challenge]));
  return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unbase64url(proof.signature), message) ? 'reachable' : 'changed';
}
