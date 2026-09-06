import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';

export const INTERNET_PORT = 27182;

export function isOverlayIp(address) {
  if (typeof address !== 'string' || !/^100\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(address)) return false;
  const parts = address.split('.').map(Number);
  return parts[1] >= 64 && parts[1] <= 127 && parts.every((part) => part <= 255);
}

export function summarizeTailnet(raw) {
  // Return only connection information, never account names, public endpoints,
  // machine paths, keys, or the full daemon response.
  const ready = raw?.BackendState === 'Running'
    && raw?.Self?.Online === true && raw.Self.TailscaleIPs?.some(isOverlayIp);
  return {
    ready: Boolean(ready),
    message: ready ? 'Private network connected. Same-account and invited phones are supported.'
      : 'Connect Tailscale on this computer. Phones can use the same account, an invited account, or device sharing.',
    peers: ready ? Object.values(raw.Peer ?? {}).flatMap((peer) => {
      const address = peer.TailscaleIPs?.find(isOverlayIp);
      if (!address || peer.OS !== 'android') return [];
      // Informational only: Tailscale peer visibility/policy and our session proof
      // authorize the connection, never matching owners. Do not expose user IDs.
      const ownersKnown = Number.isSafeInteger(raw.Self.UserID) && raw.Self.UserID > 0
        && Number.isSafeInteger(peer.UserID) && peer.UserID > 0;
      const account = ownersKnown ? (raw.Self.UserID === peer.UserID ? 'same' : 'different') : 'unknown';
      return [{ address, online: peer.Online === true,
        name: typeof peer.HostName === 'string' ? peer.HostName.slice(0, 80) : 'Android',
        route: peer.CurAddr ? 'direct' : 'unknown', account }];
    }) : [],
  };
}

export function requirePeer(status, address) {
  if (!isOverlayIp(address)) throw new Error('Enter the phone’s private Tailscale IPv4 address (100.x.x.x), without a port.');
  if (!status.ready) throw new Error(status.message);
  if (!status.peers.some((peer) => peer.address === address && peer.online)) {
    throw new Error('This phone is not an online Android peer visible to this computer. Connect Tailscale on both devices; for different accounts, accept a network or phone-sharing invite first, then refresh and select the phone shown here.');
  }
}

export function parseSessionKey(value) {
  if (typeof value === 'string' && value.length <= 160) {
    const canonical = value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (/^[a-z]{3,8}(( [a-z]{3,8}){2}|( [a-z]{3,8}){11})$/.test(canonical)) {
      return createHash('sha256').update(`DisplayBridge/1/secret\0${canonical}`).digest();
    }
    if (/^[23456789A-HJ-NP-Z]{26}$/i.test(value.trim())) {
      return createHash('sha256').update(`DisplayBridge/1/secret\0${value.trim().toUpperCase()}`).digest();
    }
    // Compatibility with the first Internet APK; new APKs generate words or base32.
    if (/^[a-fA-F0-9]{32}$/.test(value.trim())) return Buffer.from(value.trim(), 'hex');
  }
  throw new Error('Enter the phone’s 3- or 12-word passphrase, or its 26-character alphanumeric key.');
}

export function sessionProof(key, role, hostNonce, phoneNonce) {
  return createHmac('sha256', key).update(`DisplayBridge/1/${role}\0`)
    .update(hostNonce).update(phoneNonce).digest();
}

function readExact(socket, length, signal) {
  return new Promise((resolve, reject) => {
    const fail = () => { cleanup(); reject(new Error('Internet authentication failed or the phone disconnected.')); };
    const check = () => {
      const bytes = socket.read(length);
      if (bytes) { cleanup(); resolve(bytes); }
    };
    function cleanup() {
      socket.off('readable', check).off('error', fail).off('end', fail).off('close', fail);
      signal?.removeEventListener('abort', fail);
    }
    socket.on('readable', check).once('error', fail).once('end', fail).once('close', fail);
    signal?.addEventListener('abort', fail, { once: true });
    if (signal?.aborted || socket.destroyed) fail(); else check();
  });
}

export async function authenticatePhone(socket, key, signal, clientFirst = false) {
  const hostNonce = randomBytes(32);
  socket.write(hostNonce);
  const response = await readExact(socket, clientFirst ? 32 : 64, signal);
  const phoneNonce = response.subarray(0, 32);
  if (!clientFirst && !timingSafeEqual(response.subarray(32), sessionProof(key, 'phone', hostNonce, phoneNonce))) {
    throw new Error('Session key did not match. Generate a new Internet session on the phone.');
  }
  socket.write(sessionProof(key, 'desktop', hostNonce, phoneNonce));
  if (clientFirst && !timingSafeEqual(await readExact(socket, 32, signal), sessionProof(key, 'phone', hostNonce, phoneNonce))) {
    throw new Error('Phone authentication failed. Start a new session on your own trusted device.');
  }
  if ((await readExact(socket, 1, signal))[0] !== 1) throw new Error('Phone refused the Internet session.');
}

export async function openInternetBridge({ address, sessionKey, tailnet, signal }) {
  requirePeer(tailnet, address);
  const key = parseSessionKey(sessionKey);
  const remote = new net.Socket();
  remote.setNoDelay(true);
  let local;
  let listener;
  let timer;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', close);
    remote.destroy();
    local?.destroy();
    listener?.close();
    key.fill(0);
  };
  signal?.addEventListener('abort', close, { once: true });
  remote.on('error', close).on('close', close);
  timer = setTimeout(close, 10000);
  try {
    if (signal?.aborted) throw new Error('Internet connection cancelled.');
    await new Promise((resolve, reject) => {
      const failed = () => reject(new Error('Phone is unreachable. Open Internet mode in Display Bridge, check Tailscale and allow TCP 27182 in your private-network policy.'));
      remote.once('close', failed);
      remote.connect({ host: address, port: INTERNET_PORT }, () => {
        remote.off('close', failed);
        resolve();
      });
    });
    const clientFirst = sessionKey.trim().split(/\s+/).length === 3;
    await authenticatePhone(remote, key, signal, clientFirst);
    key.fill(0);
    if (closed) throw new Error('Internet connection cancelled.');
    listener = net.createServer((socket) => {
      if (local || closed) { socket.destroy(); return; }
      local = socket;
      listener.close();
      clearTimeout(timer);
      local.setNoDelay(true);
      local.on('error', close).on('close', close);
      // pipe applies backpressure in both directions; no video history queue.
      local.pipe(remote);
      remote.pipe(local);
    });
    listener.on('error', close);
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    if (closed) throw new Error('Internet connection cancelled.');
    clearTimeout(timer);
    timer = setTimeout(close, 10000); // Do not leave a listener if capture fails.
    return { port: listener.address().port, close };
  } catch (error) {
    close();
    throw error;
  }
}
