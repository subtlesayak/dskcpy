import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { authenticatePhone, isOverlayIp, openInternetBridge, parseSessionKey, requirePeer, sessionProof, summarizeTailnet } from './internet.mjs';
import { buildScrcpyArgs, sanitizeStreamConfig } from './core.mjs';

const keyText = '00112233445566778899aabbccddeeff'; // Public fixture, never a real session.
const key = Buffer.from(keyText, 'hex');
const address = '100.100.100.100';
const ready = { ready: true, message: '', peers: [{ address, online: true }] };

test('Internet accepts only canonical overlay addresses, never carrier/LAN/public endpoints or shell text', () => {
  for (const value of ['100.64.0.1', '100.127.255.255']) assert.equal(isOverlayIp(value), true);
  for (const value of ['192.168.1.1', '8.8.8.8', '100.63.0.1', '100.128.0.1', '100.100.256.1', '100.064.1.1', `${address}:5555`, '-e', null]) assert.equal(isOverlayIp(value), false);
  assert.throws(() => requirePeer({ ...ready, ready: false }, address));
  assert.throws(() => requirePeer({ ...ready, peers: [] }, address));
  assert.throws(() => requirePeer({ ...ready, peers: [{ address, online: false }] }, address));
  requirePeer(ready, address);
});

test('VPN state exposes only minimal Android peer information; unknown is not mislabeled direct or relayed', () => {
  const status = summarizeTailnet({ BackendState: 'Running', Self: { Online: true, TailscaleIPs: ['100.64.0.1'] },
    User: { private: 'DO_NOT_EXPOSE' }, Peer: {
      a: { OS: 'android', HostName: 'Test phone', Online: true, TailscaleIPs: [address], PublicKey: 'DO_NOT_EXPOSE', Relay: 'region' },
      b: { OS: 'windows', TailscaleIPs: ['100.64.0.3'], Online: true },
    } });
  assert.equal(status.ready, true);
  assert.deepEqual(status.peers, [{ name: 'Test phone', online: true, address, route: 'unknown', account: 'unknown' }]);
  assert.ok(!JSON.stringify(status).includes('DO_NOT_EXPOSE'));
  assert.deepEqual(summarizeTailnet({ BackendState: 'NeedsLogin' }).peers, []);
});

test('same-account, invited and shared phones remain eligible without exposing account identity', () => {
  const raw = { BackendState: 'Running', Self: { Online: true, UserID: 101, TailscaleIPs: ['100.64.0.1'] },
    User: { 101: { LoginName: 'DO_NOT_EXPOSE' }, 202: { LoginName: 'DO_NOT_EXPOSE' } }, Peer: {
      own: { OS: 'android', HostName: 'Own phone', Online: true, UserID: 101, TailscaleIPs: [address] },
      invited: { OS: 'android', HostName: 'Invited phone', Online: true, UserID: 202, TailscaleIPs: ['100.64.0.3'] },
      shared: { OS: 'android', HostName: 'Shared phone', Online: true, UserID: 303, AltSharerUserID: 404,
        TailscaleIPs: ['100.64.0.4'], DNSName: 'DO_NOT_EXPOSE', PublicKey: 'DO_NOT_EXPOSE' },
    } };
  const status = summarizeTailnet(raw);
  assert.deepEqual(status.peers.map((peer) => peer.account), ['same', 'different', 'different']);
  for (const peer of status.peers) requirePeer(status, peer.address);
  const serialized = JSON.stringify(status);
  for (const secret of ['DO_NOT_EXPOSE', 'UserID', 'AltSharerUserID', 'LoginName', 'DNSName', 'PublicKey']) {
    assert.ok(!serialized.includes(secret));
  }
  // Loss of visibility is sufficient to block a new connection, regardless of owner.
  delete raw.Peer.shared;
  assert.throws(() => requirePeer(summarizeTailnet(raw), '100.64.0.4'), /invitation|invite/);
  raw.Peer.invited.Online = false;
  assert.throws(() => requirePeer(summarizeTailnet(raw), '100.64.0.3'));
});

test('missing, zero or unsafe owner IDs are not mislabeled as the same account', () => {
  for (const userId of [undefined, null, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const raw = { BackendState: 'Running', Self: { Online: true, UserID: userId, TailscaleIPs: ['100.64.0.1'] },
      Peer: { a: { OS: 'android', Online: true, UserID: userId, TailscaleIPs: [address] } } };
    const status = summarizeTailnet(raw);
    assert.equal(status.peers[0].account, 'unknown');
    requirePeer(status, address); // The account label never replaces authorization.
  }
});

test('session keys stay out of saved config and commands; Internet cannot fall back to ADB', () => {
  const config = sanitizeStreamConfig({ connection: 'internet', address, sessionKey: keyText, serial: 'USB123' });
  assert.equal(config.sessionKey, undefined);
  assert.equal(config.serial, undefined);
  assert.throws(() => buildScrcpyArgs(config), /Authenticate/);
  const args = buildScrcpyArgs(config, 43210);
  assert.ok(args.includes('--reverse-socket=43210'));
  assert.ok(!args.some((arg) => /--connection|--select|--serial|--tcpip/.test(arg)));
  assert.ok(!args.join(' ').includes(keyText));
  for (const value of ['', '123456', keyText + '00', null]) assert.throws(() => parseSessionKey(value));
});

test('role separation and stable proof vector match the Android protocol', () => {
  const host = Buffer.alloc(32, 1);
  const phone = Buffer.alloc(32, 2);
  const proof = sessionProof(key, 'phone', host, phone);
  assert.notDeepEqual(proof, sessionProof(key, 'desktop', host, phone));
  assert.notDeepEqual(proof, sessionProof(key, 'phone', phone, host));
  // Shared with InternetSessionTest; catches accidental wire-protocol changes.
  assert.equal(proof.toString('hex'), '4aa7825897513740bd3a948ad4dd3a3b7a2c2de1e00840dc6aabe79dc6cbff63');
});

test('accepts both secret options, normalizes typing, and matches the Android derivation vector', () => {
  const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  const derived = parseSessionKey(phrase);
  assert.equal(derived.toString('hex'), '8fd7400bdd6f6977eb79a3438b077f1ea2b90dd7c67e418dcb901b143dca2333');
  assert.deepEqual(derived, parseSessionKey(`  ${phrase.toUpperCase().replaceAll(' ', '\n  ')}  `));
  const token = '23456789ABCDEFGHJKLMNPQRST';
  assert.equal(token.length, 26);
  assert.deepEqual(parseSessionKey(token), parseSessionKey(token.toLowerCase()));
  assert.deepEqual(parseSessionKey('abandon ability able'), parseSessionKey('  ABANDON  ability\nable '));
  for (const secret of [phrase + ' extra', 'one two', '1'.repeat(26), 'O'.repeat(26), 'a'.repeat(161)]) {
    assert.throws(() => parseSessionKey(secret));
  }
  for (const secret of [phrase, token]) {
    const config = sanitizeStreamConfig({ connection: 'internet', address, sessionKey: secret });
    assert.ok(!JSON.stringify(config).includes(secret));
  }
});

async function phoneFixture(t, { wrongKey = false, idle = false, refuse = false, clientFirst = false } = {}) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (idle) return;
    let phase = 0;
    let buffer = Buffer.alloc(0);
    let host;
    const phone = Buffer.alloc(32, 2);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (phase === 0 && buffer.length >= 32) {
        host = buffer.subarray(0, 32);
        buffer = buffer.subarray(32);
        phase = 1;
        const proof = sessionProof(wrongKey ? Buffer.alloc(16) : key, 'phone', host, phone);
        socket.write(phone.subarray(0, 3)); // Deliberately fragment the greeting.
        setImmediate(() => socket.write(clientFirst ? phone.subarray(3) : Buffer.concat([phone.subarray(3), proof])));
      }
      if (phase === 1 && buffer.length >= 32) {
        assert.deepEqual(buffer.subarray(0, 32), sessionProof(key, 'desktop', host, phone));
        buffer = buffer.subarray(32);
        phase = 2;
        if (clientFirst) socket.write(sessionProof(wrongKey ? Buffer.alloc(16) : key, 'phone', host, phone));
        socket.write(Buffer.from([refuse ? 0 : 1]));
      }
      if (phase === 2 && buffer.length) {
        socket.write(buffer); // Bidirectional stream fixture, not video decode.
        buffer = Buffer.alloc(0);
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

test('mutual authentication succeeds with fragmented greetings and rejects wrong keys and refusal', async (t) => {
  for (const options of [{}, { wrongKey: true }, { refuse: true }]) {
    const port = await phoneFixture(t, options);
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    await once(socket, 'connect');
    try {
      if (options.wrongKey || options.refuse) await assert.rejects(authenticatePhone(socket, key));
      else await authenticatePhone(socket, key);
    } finally { socket.destroy(); }
  }
});

test('authentication can be cancelled while the phone sends nothing', async (t) => {
  const port = await phoneFixture(t, { idle: true });
  const socket = net.createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  const controller = new AbortController();
  const pending = authenticatePhone(socket, key, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  socket.destroy();
});

test('short-phrase handshake authenticates client first and still verifies the phone', async (t) => {
  for (const wrongKey of [false, true]) {
    const port = await phoneFixture(t, { clientFirst: true, wrongKey });
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    await once(socket, 'connect');
    try {
      if (wrongKey) await assert.rejects(authenticatePhone(socket, key, undefined, true));
      else await authenticatePhone(socket, key, undefined, true);
    } finally { socket.destroy(); }
  }
});

test('authenticated bridge binds only loopback, passes both directions and closes on cancellation', async (t) => {
  const port = await phoneFixture(t);
  const original = net.Socket.prototype.connect;
  // Redirect only the fixture VPN address; production still gates real peer state.
  t.mock.method(net.Socket.prototype, 'connect', function (...args) {
    if (args[0]?.host === address) args[0] = { ...args[0], host: '127.0.0.1', port };
    return original.apply(this, args);
  });
  const controller = new AbortController();
  const tailnet = summarizeTailnet({ BackendState: 'Running', Self: { Online: true, UserID: 101, TailscaleIPs: ['100.64.0.1'] },
    Peer: { shared: { OS: 'android', Online: true, UserID: 202, AltSharerUserID: 303, TailscaleIPs: [address] } } });
  assert.equal(tailnet.peers[0].account, 'different');
  const bridge = await openInternetBridge({ address, sessionKey: keyText, tailnet, signal: controller.signal });
  t.after(bridge.close);
  const local = net.createConnection({ host: '127.0.0.1', port: bridge.port });
  local.on('error', () => {});
  await once(local, 'connect');
  const payload = Buffer.alloc(256 * 1024, 42);
  const received = [];
  let size = 0;
  const roundTrip = new Promise((resolve) => local.on('data', (data) => {
    received.push(data); size += data.length; if (size === payload.length) resolve();
  }));
  local.write(payload);
  await roundTrip;
  assert.deepEqual(Buffer.concat(received), payload);
  const closed = once(local, 'close');
  controller.abort();
  await closed;
  bridge.close(); // Idempotent cleanup.
});
