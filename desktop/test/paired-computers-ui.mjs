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
  let broker, captures = 0, offline = false, holdBootstrap = false, alternateProof;
  const natives = new Set(), sockets = new Set();
  const requestOptions = req => ({ hostname: '127.0.0.1', port: broker.port, path: req.url, method: req.method, headers: req.headers });
  const proxy = https.createServer(tls, (req, res) => {
    if (offline) { req.socket.destroy(); return; }
    const challenge = /^\/pairing-identity\?challenge=([a-f0-9]{64})$/.exec(req.url)?.[1];
    if (alternateProof && challenge && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(alternateProof(origin, challenge)));
      return;
    }
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
      socket.pipe(remote);
      remote.on('data', chunk => { if (!holdBootstrap) socket.write(chunk); });
    });
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); });
    upstream.on('error', () => socket.destroy()); upstream.end();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `https://${hostname}:${proxy.address().port}`;
  const host = {
    origin, get broker() { return broker; }, get captures() { return captures; },
    replaceIdentityProof(prove) { alternateProof = prove; },
    proveIdentity(origin, challenge) { return store.proveIdentity(origin, challenge); },
    holdBootstrap(value) { holdBootstrap = value; },
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

async function checkInstallable(directory) {
  const { manifest, manifestType, icons } = await directory.evaluate(async () => {
    const manifestURL = document.querySelector('link[rel="manifest"]').href;
    const response = await fetch(manifestURL);
    const manifest = await response.json();
    const icons = await Promise.all(manifest.icons.map(async item => {
      const image = new Image();
      image.src = item.src;
      await image.decode();
      return `${image.naturalWidth}x${image.naturalHeight}`;
    }));
    return { manifest, icons, manifestType: response.headers.get('content-type') };
  });
  assert.match(manifestType, /^application\/manifest\+json/);
  assert.equal(manifest.id, '/computers/');
  assert.equal(manifest.start_url, '/computers/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(icons, ['192x192', '512x512']);
  assert.ok(manifest.icons.every(icon => icon.purpose.includes('maskable')));
  await directory.getByRole('link', { name: 'Open this computer’s receiver' }).waitFor();

  if (engine === 'chromium') {
    await directory.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const session = await context.newCDPSession(directory);
    try {
      const { installabilityErrors } = await session.send('Page.getInstallabilityErrors');
      assert.deepEqual(installabilityErrors, []);
    } finally { await session.detach(); }
  }

  const dispatched = await directory.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    event.prompt = async () => { window.fixturePromptOpened = true; };
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(dispatched, true);
  await button(directory, 'Install dskcpy').click();
  await directory.locator('#install-help').waitFor();
  assert.equal(await directory.evaluate(() => window.fixturePromptOpened), true);
  await directory.locator('#install-help summary').click();
  await directory.getByText('Share → Add to Home Screen', { exact: true }).waitFor();
  await directory.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await directory.locator('#install-help').waitFor({ state: 'hidden' });
}

async function pairAndSave(directory, receiver, host, name) {
  await button(receiver, 'Options').click();
  await receiver.getByText('Remember this browser', { exact: true }).click();
  await receiver.getByLabel('Device name').fill(name);
  await button(receiver, 'Request pairing').click();
  await until(() => host.broker.trustedStatus().pending.length === 1, 'Pairing should wait for owner approval');
  await host.broker.trustAction('approve', host.broker.trustedStatus().pending[0].id);
  await receiver.getByRole('status').filter({ hasText: 'Paired. Return' }).waitFor();
  await button(receiver, 'Save to paired computers').filter({ visible: true }).click();
  await directory.getByRole('status').filter({ hasText: 'added.' }).waitFor();
  host.broker.cancel(); await receiver.close();
}
async function addComputer(directory, host, name) {
  const priorCaptures = host.captures;
  const invite = await host.broker.invite('internet', policy);
  await directory.getByLabel('Computer address or invitation link').fill(`${host.origin}/#connect=${invite.key}`);
  const opened = directory.waitForEvent('popup'); await button(directory, 'Add computer').click();
  const receiver = await opened;
  await until(() => host.captures === priorCaptures + 1, 'Invitation should start one simulated capture');
  await pairAndSave(directory, receiver, host, name);
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
  await checkInstallable(directory);
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

  // A receiver reload must retain the in-flight directory intent, including
  // cancellation. It must not start capture or require a new host request.
  receiver = await select(directory, nameA);
  const reloadingRequest = a.broker.trustedStatus().streamRequest.id;
  await receiver.reload();
  await receiver.getByRole('button', { name: 'Request to connect', exact: true }).waitFor();
  await button(directory, 'Cancel request').click();
  await directory.getByRole('status').filter({ hasText: 'Connection request cancelled' }).waitFor();
  assert.equal(a.broker.trustedStatus().streamRequest, null);
  assert.equal(a.captures, 1, 'Reload and cancellation cannot start a new capture');
  await assert.rejects(a.broker.trustAction('allow-stream', reloadingRequest), /expired/);
  await receiver.close();

  receiver = await select(directory, nameA);
  const abandonedRequest = a.broker.trustedStatus().streamRequest.id;
  await receiver.goto('about:blank');
  await directory.getByRole('status').filter({ hasText: 'The receiver stopped responding' }).waitFor();
  assert.equal(await button(directory, `Request to connect for ${nameA}`).isEnabled(), true);
  assert.equal(a.captures, 1, 'A missing receiver response cannot authorize capture');
  await a.broker.trustAction('deny-stream', abandonedRequest);
  await receiver.close();

  receiver = await select(directory, nameA);
  await a.broker.trustAction('deny-stream', a.broker.trustedStatus().streamRequest.id);
  await directory.getByRole('status').filter({ hasText: 'The computer denied the request' }).waitFor();
  assert.equal(a.captures, 1); await receiver.close();

  if (engine === 'chromium') {
    await directory.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const paths = await directory.evaluate(async () => {
      await Promise.all([fetch('/join'), fetch('/stream/session')]);
      const cache = await caches.open('dskcpy-paired-computers-v2');
      return (await cache.keys()).map(request => new URL(request.url).pathname).sort();
    });
    assert.deepEqual(paths, ['/computers/', '/computers/computers-common.mjs', '/computers/computers.mjs',
      '/computers/icon-192.png', '/computers/icon-512.png', '/computers/manifest.webmanifest', '/receiver.css']);
    a.setOffline(true);
    await directory.reload();
    for (const name of [nameA, nameB]) await directory.getByRole('heading', { name, exact: true }).waitFor();
    await directory.getByRole('listitem').filter({ hasText: nameA }).getByText('Unreachable', { exact: true }).waitFor();
    const offlineReceiver = await directory.evaluate(async () => {
      const results = await Promise.allSettled([fetch('/join'), fetch('/stream/session')]);
      return results.map(result => result.status);
    });
    assert.deepEqual(offlineReceiver, ['rejected', 'rejected']);
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

  const rePair = button(directory, `Pair again for ${nameB}`);
  let proofChecks = 0;
  moved.replaceIdentityProof((address, challenge) => {
    proofChecks++;
    return a.proveIdentity(address, challenge);
  });
  await rePair.click();
  await directory.getByRole('status').filter({ hasText: 'Computer identity changed' }).waitFor();
  assert.equal(proofChecks, 1);
  assert.equal(moved.captures, 0);
  moved.replaceIdentityProof(null);

  const movingInvite = await moved.broker.invite('internet', policy);
  const movedPopup = directory.waitForEvent('popup');
  await rePair.click();
  const movingReceiver = await movedPopup;
  await movingReceiver.waitForURL(`${moved.origin}/`);
  assert.equal(moved.captures, 0, 'The old pairing cannot carry capture access to the new address');
  await movingReceiver.getByLabel('Connection code').fill(movingInvite.key);
  await button(movingReceiver, 'Connect').click();
  await until(() => moved.captures === 1, 'The fresh invitation should authorize the first moved-host capture');
  await pairAndSave(directory, movingReceiver, moved, 'Browser at the new address');
  assert.equal(await directory.getByRole('list', { name: 'Saved computers' }).locator('li').count(), 1);
  await directory.getByRole('heading', { name: nameB, exact: true }).waitFor();
  await directory.reload();
  receiver = await select(directory, nameB);
  assert.equal(moved.captures, 1, 'The repaired listing still requires host approval');
  await moved.broker.trustAction('allow-stream', moved.broker.trustedStatus().streamRequest.id);
  await until(() => moved.captures === 2, 'The moved host should start a new capture after approval');
  await directory.getByRole('status').filter({ hasText: 'Approved. Continue in the receiver tab' }).waitFor();
  moved.broker.cancel(); await receiver.close();
  // Drop the initial server acknowledgement only after the host has approved
  // and the broker has created its capture. Reload must recover that exact
  // approved session, rather than retain the new-tab guard forever.
  const priorBootstrapCaptures = a.captures;
  await addComputer(directory, a, 'Bootstrap fixture browser');
  const bootstrapName = await directory.locator('#paired-computers li').last().getByRole('heading').innerText();
  receiver = await select(directory, bootstrapName);
  a.holdBootstrap(true);
  await a.broker.trustAction('allow-stream', a.broker.trustedStatus().streamRequest.id);
  await until(() => a.captures === priorBootstrapCaptures + 2, 'Approved capture should start before the dropped acknowledgement');
  a.holdBootstrap(false);
  await receiver.reload();
  await receiver.locator('#stream-panel').waitFor();
  assert.equal(a.captures, priorBootstrapCaptures + 2, 'A lost initial acknowledgement must resume the same capture');
  assert.equal(a.broker.trustedStatus().streamRequest, null);
  a.broker.cancel(); await receiver.close();

  // Model the installed display mode with no popup API. The launch still uses
  // the real profile's pairing, host approval and HTTPS/WebSocket receiver.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    window.open = () => { throw Error('Opening a paired host should stay in the app window'); };
  });
  const installed = await context.newPage();
  const capturesBeforeApp = a.captures;
  const receiverURL = `${a.origin}/#paired-app`;
  await installed.goto(receiverURL);
  await button(installed, 'Request to connect').waitFor();
  assert.equal(a.broker.trustedStatus().streamRequest, null, 'The launch fragment alone cannot request access');
  await installed.getByRole('link', { name: 'Open paired computers' }).click();
  await button(installed, `Request to connect for ${bootstrapName}`).click();
  await installed.waitForURL(receiverURL);
  await installed.getByRole('status').filter({ hasText: 'Waiting for host approval' }).waitFor();
  assert.equal(a.captures, capturesBeforeApp);
  await button(installed, 'Cancel request').click();
  await installed.getByRole('status').filter({ hasText: 'Connection request cancelled.' }).waitFor();
  assert.equal(a.broker.trustedStatus().streamRequest, null);

  await installed.getByRole('link', { name: 'Open paired computers' }).click();
  await button(installed, `Request to connect for ${bootstrapName}`).click();
  await installed.getByRole('status').filter({ hasText: 'Waiting for host approval' }).waitFor();
  assert.equal(a.captures, capturesBeforeApp);
  await a.broker.trustAction('allow-stream', a.broker.trustedStatus().streamRequest.id);
  await installed.locator('#stream-panel').waitFor();
  await installed.waitForURL(`${a.origin}/`);
  await installed.reload(); await installed.locator('#stream-panel').waitFor();
  assert.equal(a.captures, capturesBeforeApp + 1);

  await installed.goto(`${a.origin}/computers/`);
  await button(installed, `Request to connect for ${bootstrapName}`).click();
  await installed.waitForURL(receiverURL);
  await installed.getByText('Computer is busy. Check again when it is free.', { exact: true }).waitFor();
  assert.equal(await installed.locator('#stream-panel').isVisible(), false);
  assert.equal(a.captures, capturesBeforeApp + 1, 'A new app request cannot attach to a held stream');
  a.broker.cancel(); await installed.close();

  // An installed app may start with a fresh cookie jar and no saved list.
  await context.clearCookies();
  const freshApp = await context.newPage();
  await freshApp.goto(`${a.origin}/computers/`);
  await freshApp.evaluate(() => localStorage.clear());
  await freshApp.reload();
  const freshStart = a.captures;
  const firstInvite = await a.broker.invite('internet', policy);
  await freshApp.getByLabel('Computer address or invitation link').fill(`${a.origin}/#connect=${firstInvite.key}`);
  await button(freshApp, 'Add computer').click();
  await freshApp.locator('#stream-panel').waitFor();
  await button(freshApp, 'Options').click();
  await freshApp.getByText('Remember this browser', { exact: true }).click();
  const save = button(freshApp, 'Save to paired computers').filter({ visible: true });
  await save.click();
  await freshApp.getByRole('status').filter({ hasText: 'Request pairing and wait for the host to approve it first.' }).waitFor();
  await freshApp.getByLabel('Device name').fill('Fresh installed app');
  await button(freshApp, 'Request pairing').click();
  await until(() => a.broker.trustedStatus().pending.length === 1, 'New app must ask the host to pair');
  await a.broker.trustAction('approve', a.broker.trustedStatus().pending[0].id);
  await freshApp.getByRole('status').filter({ hasText: 'Paired. Return' }).waitFor();
  await save.click();
  await freshApp.getByRole('status').filter({ hasText: 'Saved to paired computers in this app.' }).waitFor();
  assert.equal(a.captures, freshStart + 1);
  assert.equal(await freshApp.locator('#stream-panel').isVisible(), true, 'Saving must not end the authorized stream');
  a.broker.cancel();
  await freshApp.goBack();
  await button(freshApp, 'Request to connect for localhost').click();
  await freshApp.getByRole('status').filter({ hasText: 'Waiting for host approval' }).waitFor();
  assert.equal(a.captures, freshStart + 1, 'Saving a pairing must not authorize a later stream');
  await a.broker.trustAction('allow-stream', a.broker.trustedStatus().streamRequest.id);
  await freshApp.locator('#stream-panel').waitFor();
  assert.equal(a.captures, freshStart + 2);
  a.broker.cancel(); await freshApp.close();

  assert.deepEqual(errors, []);
  console.log(`${engine}: PWA assets and install controls, two-host list, pending reload/cancel, bounded handoff, denial, approved request, signed address change, isolated forget and lost-auth-reply same-capture resume passed.`);
} finally {
  await context?.close();
  for (const host of hosts) await host.close();
  await rm(dir, { recursive: true, force: true });
}
