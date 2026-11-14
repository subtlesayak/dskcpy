import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { probePrivateReceiver, receiverProbeTarget, receiverProbeMessage } from '../receiver-probe.mjs';
const origin = 'https://owned.test.ts.net:8443';
const descriptor = { url: origin + '/', instance: 'a'.repeat(32) };
function fixture({ status = 200, body = JSON.stringify({ service: 'dskcpy-browser-receiver', instance: descriptor.instance }), error, hang = false, headers = { 'content-type': 'application/json' } } = {}) {
  let calls = 0, options, url, destroyed = 0;
  const request = (target, opts, callback) => {
    calls++; options = opts; url = target;
    const req = new EventEmitter(); req.destroy = () => destroyed++;
    req.end = () => queueMicrotask(() => {
      if (error) { req.emit('error', Object.assign(Error('PRIVATE NETWORK DETAILS'), { code: error })); return; }
      if (hang) return;
      const response = new EventEmitter(); response.statusCode = status; response.headers = headers; response.destroy = () => destroyed++;
      callback(response); response.emit('data', Buffer.from(body)); response.emit('end');
    });
    return req;
  };
  return { request, state: () => ({ calls, options, url, destroyed }) };
}
test('owned HTTPS health check is credential-free, TLS-verified, bounded and not redirected', async () => {
  const f = fixture(); assert.deepEqual(await probePrivateReceiver(descriptor, origin, f), { ready: true });
  const s = f.state(); assert.equal(s.url.href, origin + '/health'); assert.equal(s.calls, 1);
  assert.equal(s.options.rejectUnauthorized, true); assert.equal(s.options.minVersion, 'TLSv1.2');
  assert.equal(s.options.agent, false); assert.equal(s.options.maxHeaderSize, 4096);
  assert.ok(!JSON.stringify(s.options).match(/cookie|authorization|instance|connect=/i)); assert.ok(s.destroyed >= 1);
  const redirect = fixture({ status: 302, headers: { location: 'https://unrelated.invalid/' } });
  assert.deepEqual(await probePrivateReceiver(descriptor, origin, redirect), { ready: false, reason: 'response' }); assert.equal(redirect.state().calls, 1);
});
test('foreign origins, credentials, paths and invalid instance markers never start a request', async () => {
  for (const change of [{ url: 'http://owned.test.ts.net/' }, { url: 'https://other.test.ts.net/' }, { url: origin + '/path' },
    { url: 'https://user@owned.test.ts.net:8443/' }, { url: origin + '/?code=private' }, { url: origin + '/#private' }, { instance: 'secret' }]) {
    const f = fixture(); assert.throws(() => receiverProbeTarget({ ...descriptor, ...change }, origin));
    assert.deepEqual(await probePrivateReceiver({ ...descriptor, ...change }, origin, f), { ready: false, reason: 'response' }); assert.equal(f.state().calls, 0);
  }
});
test('unexpected, oversized, malformed, compressed and wrong-instance responses fail without leaking diagnostics', async () => {
  for (const change of [{ body: 'x'.repeat(257) }, { body: 'not json' }, { body: 'null' }, { body: '[]' },
    { body: JSON.stringify({ service: 'dskcpy-browser-receiver', instance: 'b'.repeat(32) }) },
    { body: JSON.stringify({ service: 'dskcpy-browser-receiver', instance: descriptor.instance, private: true }) },
    { headers: { 'content-type': 'text/html' } }, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }]) {
    const result = await probePrivateReceiver(descriptor, origin, fixture(change)); assert.deepEqual(result, { ready: false, reason: 'response' });
  }
  for (const [code, reason] of [['CERT_HAS_EXPIRED', 'certificate'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'certificate'], ['ENOTFOUND', 'name'], ['ECONNREFUSED', 'connect']]) {
    const result = await probePrivateReceiver(descriptor, origin, fixture({ error: code })); assert.deepEqual(result, { ready: false, reason });
    assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(!receiverProbeMessage(reason).includes(origin));
  }
});
test('wall-clock timeout and cancellation destroy the request and cannot become a late success', async () => {
  const timeout = fixture({ hang: true }); assert.deepEqual(await probePrivateReceiver(descriptor, origin, { ...timeout, timeoutMs: 5 }), { ready: false, reason: 'timeout' }); assert.ok(timeout.state().destroyed);
  const abort = new AbortController(), f = fixture({ hang: true }); const promise = probePrivateReceiver(descriptor, origin, { ...f, signal: abort.signal }); abort.abort();
  assert.deepEqual(await promise, { ready: false, reason: 'cancelled' }); assert.ok(f.state().destroyed);
  const before = fixture(); assert.deepEqual(await probePrivateReceiver(descriptor, origin, { ...before, signal: abort.signal }), { ready: false, reason: 'cancelled' }); assert.equal(before.state().calls, 0);
});

test('real loopback TLS transport rejects an untrusted certificate and accepts only fixture-scoped trust', async t => {
  const [{ default: https }, { execFileSync }, { mkdtemp, readFile, writeFile, rm }, { default: os }, { default: path }] = await Promise.all([
    import('node:https'), import('node:child_process'), import('node:fs/promises'), import('node:os'), import('node:path')]);
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { t.skip('OpenSSL is unavailable for this disposable certificate fixture'); return; }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-probe-tls-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'request.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=owned.test.ts.net\n[ext]\nsubjectAltName=DNS:owned.test.ts.net\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', path.join(dir, 'request.cnf'), '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore', timeout: 15000 });
  const cert = await readFile(path.join(dir, 'cert.pem')), key = await readFile(path.join(dir, 'key.pem')); let requests = 0;
  const server = https.createServer({ cert, key }, (req, res) => { requests++; assert.equal(req.url, '/health');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ service: 'dskcpy-browser-receiver', instance: descriptor.instance })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const address = `https://owned.test.ts.net:${server.address().port}`;
  const local = { ...descriptor, url: address + '/' };
  const lookup = (_host, options, callback) => options.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4);
  const untrusted = await probePrivateReceiver(local, address, { request: (url, options, callback) => https.request(url, { ...options, lookup }, callback) });
  assert.deepEqual(untrusted, { ready: false, reason: 'certificate' }); assert.equal(requests, 0);
  // This CA is supplied by the injected test transport only. Production never
  // changes its trust store, supplies this CA or sets rejectUnauthorized=false.
  const trusted = await probePrivateReceiver(local, address, { request: (url, options, callback) => https.request(url, { ...options, lookup, ca: cert }, callback) });
  assert.deepEqual(trusted, { ready: true }); assert.equal(requests, 1);
});
