// Two disposable HTTPS origins, actual browser pairing cookies, synthetic capture.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { createTrustedDevices } from '../../gui/server/trusted-devices.mjs';

const engine = process.argv[2] || 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine));
const dir = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-paired-computers-'));
const profile = { maxSize: 1600, maxFps: 30, bitRateMbps: 8 };
const policy = { keyboard: true, rememberProfile: profile };
const hosts = [];
let context;
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(label);
}
async function proxyHost(tls, hostname, filename) {
  let broker, captures = 0, offline = false;
  const natives = new Set(), sockets = new Set();
  const requestOptions = req => ({ hostname: '127.0.0.1', port: broker.port, path: req.url, method: req.method, headers: req.headers });
  const proxy = https.createServer(tls, (req, res) => {
    if (offline) { req.socket.destroy(); return; }
    const upstream = http.request(requestOptions(req), response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502).end(); }); req.pipe(upstream);
  });
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('upgrade', (req, socket, head) => {
    if (offline) { socket.destroy(); return; }
    const upstream = http.request(requestOptions(req));
    upstream.on('upgrade', (response, remote, remoteHead) => {
      const headers = response.rawHeaders.reduce((result, value, index) => result + value + (index % 2 ? '\r\n' : ': '), '');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n`);
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
      socket.pipe(remote); remote.pipe(socket);
    });
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `https://${hostname}:${proxy.address().port}`;
  const host = {
    origin, get broker() { return broker; }, get captures() { return captures; },
    setOffline(value) { offline = value; if (value) for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const socket of [...sockets, ...natives]) socket.destroy();
      await broker?.shutdown();
      if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
    },
  };
  hosts.push(host);
  const store = createTrustedDevices({ filename }); await store.ready;
  broker = createBrowserReceiver({ origin, configuredPort: 0, trustedDevices: store, onConnect: async bridge => {
    captures++;
    const native = net.connect(bridge.port, '127.0.0.1');
    natives.add(native); native.on('error', () => {}); native.on('data', () => {});
    native.once('close', () => natives.delete(native));
    await once(native, 'connect'); native.write(Buffer.from('535244310000000100000280000001e0', 'hex'));
  }, onTrustedConnect: device => broker.invite('internet', { ...policy, rememberProfile: device.profile }, device) });
  await broker.prepare(); return host;
}
const button = (page, name) => page.getByRole('button', { name, exact: true });

async function addComputer(directory, host, waitName) {
  const invite = await host.broker.invite('internet', policy);
  await directory.getByLabel('Computer address or invitation link').fill(`${host.origin}/#connect=${invite.key}`);
  const opened = directory.waitForEvent('popup'); await button(directory, 'Add computer').click();
  const receiver = await opened;
  await until(() => host.captures === 1, 'First invitation should start the simulated capture');
  await button(receiver, 'Options').click();
  await receiver.getByText('Remember this browser', { exact: true }).click();
  await receiver.getByLabel('Device name').fill(waitName);
  await button(receiver, 'Request pairing').click();
  await until(() => host.broker.trustedStatus().pending.length === 1, 'Pairing should wait for owner approval');
  await host.broker.trustAction('approve', host.broker.trustedStatus().pending[0].id);
  await receiver.getByRole('status').filter({ hasText: 'Paired. Return' }).waitFor();
  await button(receiver, 'Save to paired computers').filter({ visible: true }).click();
  await directory.getByRole('status').filter({ hasText: 'added.' }).waitFor();
  host.broker.cancel(); await receiver.close();
}
async function select(directory, name) {
  const opened = directory.waitForEvent('popup');
  await button(directory, `Request to connect for ${name}`).click();
  const receiver = await opened;
  await directory.getByRole('status').filter({ hasText: 'Waiting for host approval' }).waitFor();
  return receiver;
}

try {
  const certFile = path.join(dir, 'cert.pem'), keyFile = path.join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore', timeout: 15000 });
  const tls = { cert: await readFile(certFile), key: await readFile(keyFile) };
  const fileA = path.join(dir, 'first.json'), fileB = path.join(dir, 'second.json');
  const a = await proxyHost(tls, 'localhost', fileA), b = await proxyHost(tls, '127.0.0.1', fileB);
  // Chromium's service-worker fetches use browser trust. Accept only the
  // disposable fixture's key in this instance, including worker fetches.
  const spki = createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const browserOptions = {
    ignoreHTTPSErrors: engine === 'webkit', headless: true,
    ...(engine === 'chromium' && { channel: 'chromium', args: ['--disable-gpu', `--ignore-certificate-errors-spki-list=${spki}`] }),
  };
  const errors = [];
  async function openDirectory() {
    context = await ({ chromium, webkit })[engine].launchPersistentContext(path.join(dir, 'receiver-profile'), browserOptions);
    // Header-only WebCodecs runs the join and cookie paths without capture.
    await context.addInitScript(() => { delete window.RTCPeerConnection; });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.goto(`${a.origin}/computers/`); return page;
  }
  let directory = await openDirectory();
  await addComputer(directory, a, 'First test browser');
  await addComputer(directory, b, 'Second test browser');
  const nameA = 'Studio Mac', nameB = 'Other computer';
  for (const [host, name] of [[a, nameA], [b, nameB]]) {
    await button(directory, `Rename for ${new URL(host.origin).hostname}`).click();
    await directory.getByLabel('Computer name').fill(name);
    await directory.keyboard.press('Enter');
    await directory.getByRole('heading', { name, exact: true }).waitFor();
  }
  await context.close(); directory = await openDirectory();
  for (const name of [nameA, nameB]) await directory.getByRole('heading', { name, exact: true }).waitFor();
  await directory.setViewportSize({ width: 320, height: 640 });
  assert.equal(await directory.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await directory.getByRole('list', { name: 'Saved computers' }).locator('li').count(), 2);

  const savedEntries = await directory.evaluate(() => {
    const key = 'dskcpy.paired-computers.v1', original = localStorage.getItem(key);
    const entries = JSON.parse(original); entries[0].binding = '0'.repeat(64);
    localStorage.setItem(key, JSON.stringify(entries)); return original;
  });
  await directory.reload();
  const unlinked = directory.waitForEvent('popup');
  await button(directory, `Request to connect for ${nameA}`).click();
  await directory.getByRole('status').filter({ hasText: 'Pairing required' }).waitFor();
  assert.equal(a.broker.trustedStatus().streamRequest, null);
  await (await unlinked).close();
  await directory.evaluate(data => localStorage.setItem('dskcpy.paired-computers.v1', data), savedEntries);
  await directory.reload();

  let receiver = await select(directory, nameA);
  assert.equal(a.captures, 1); assert.equal(b.captures, 1);
  assert.deepEqual(a.broker.trustedStatus().streamRequest.permissions, ['view', 'audio', 'control']);
  await button(directory, 'Cancel request').click();
  await directory.getByRole('status').filter({ hasText: 'Connection request cancelled' }).waitFor();
  assert.equal(a.broker.trustedStatus().streamRequest, null);
  await receiver.close();

  receiver = await select(directory, nameA);
  await a.broker.trustAction('deny-stream', a.broker.trustedStatus().streamRequest.id);
  await directory.getByRole('status').filter({ hasText: 'The computer denied the request' }).waitFor();
  assert.equal(a.captures, 1); await receiver.close();

  if (engine === 'chromium') {
    await directory.evaluate(() => navigator.serviceWorker.register('/computers/computers-sw.mjs', { scope: '/computers/' }));
    await directory.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    a.setOffline(true);
    await directory.reload();
    for (const name of [nameA, nameB]) await directory.getByRole('heading', { name, exact: true }).waitFor();
    await directory.getByRole('listitem').filter({ hasText: nameA }).getByText('Unreachable', { exact: true }).waitFor();
  }
  receiver = await select(directory, nameB);
  assert.equal(a.broker.trustedStatus().streamRequest, null);
  assert.equal(b.captures, 1);
  await b.broker.trustAction('allow-stream', b.broker.trustedStatus().streamRequest.id);
  await until(() => b.captures === 2, 'Only the selected host should start after approval');
  await directory.getByRole('status').filter({ hasText: 'Approved. Continue in the receiver tab' }).waitFor();
  await receiver.waitForURL(`${b.origin}/`);
  await receiver.reload(); await receiver.locator('#stream-panel').waitFor();
  assert.equal(b.captures, 2, 'A reload resumes the same approval and capture');
  assert.equal(a.captures, 1); b.broker.cancel(); await receiver.close();
  if (engine === 'chromium') {
    a.setOffline(false);
    await button(directory, 'Check reachability').click();
    await directory.getByRole('listitem').filter({ hasText: nameA }).getByText('Reachable', { exact: true }).waitFor();
  }

  await button(directory, `Change address for ${nameB}`).click();
  await directory.getByLabel('New HTTPS address').fill(a.origin); await directory.keyboard.press('Enter');
  await directory.getByRole('status').filter({ hasText: 'This address belongs to a different computer.' }).waitFor();
  await directory.keyboard.press('Escape');
  await b.close();
  const moved = await proxyHost(tls, '127.0.0.1', fileB);
  await button(directory, `Change address for ${nameB}`).click();
  await directory.getByLabel('New HTTPS address').fill(moved.origin); await directory.keyboard.press('Enter');
  await button(directory, `Pair again for ${nameB}`).waitFor();
  assert.equal(moved.captures, 0); assert.equal(moved.broker.trustedStatus().streamRequest, null);

  directory.once('dialog', prompt => prompt.accept());
  await button(directory, `Forget for ${nameA}`).click();
  await directory.getByRole('status').filter({ hasText: 'Computer forgotten' }).waitFor();
  assert.equal(a.broker.trustedStatus().devices.length, 0);
  assert.equal(moved.broker.trustedStatus().devices.length, 1);
  assert.deepEqual(errors, []);
  console.log(`${engine}: two-host list, rename, cancellation, denial, approved request, signed address change and isolated forget passed.`);
} finally {
  await context?.close();
  for (const host of hosts) await host.close();
  await rm(dir, { recursive: true, force: true });
}
