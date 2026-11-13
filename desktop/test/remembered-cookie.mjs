// Real Chromium cookie semantics at a fully intercepted HTTPS fixture origin.
// No certificate bypass, external connection, real host/device, or capture.
// HTTP/WS upstreams are owned loopback fixtures; this is not real TLS/media QA.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { WebSocket } from '../../gui/node_modules/ws/wrapper.mjs';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { createTrustedDevices } from '../../gui/server/trusted-devices.mjs';
const origin = 'https://receiver.example.invalid';
const profile = { maxSize: 1600, maxFps: 30, bitRateMbps: 8 };
const policy = { keyboard: true, rememberProfile: profile };
const directory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-cookie-check-'));
const filename = path.join(directory, 'devices.json'); const natives = new Set(); let captures = 0;
let receiver, browser, nodeViewer;
const launchOptions = { headless: true, channel: 'chromium', args: ['--disable-gpu'] };
async function create() {
  const trustedDevices = createTrustedDevices({ filename }); await trustedDevices.ready;
  receiver = createBrowserReceiver({ configuredPort: 0, origin, trustedDevices,
    onConnect: async bridge => {
      captures++; const native = net.connect(bridge.port, '127.0.0.1'); natives.add(native); native.on('error', () => {});
      await once(native, 'connect'); native.write(Buffer.from('535244310000000100000280000001e0', 'hex'));
    }, onTrustedConnect: device => receiver.invite('internet', { ...policy, rememberProfile: device.profile }, device) });
}
const until = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Cookie fixture state transition failed');
};
async function upstream(request) {
  const headers = await request.allHeaders();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: receiver.port, path: new URL(request.url()).pathname,
      method: request.method(), headers: { ...headers, Host: new URL(origin).host } }, response => {
      const bytes = []; response.on('data', b => bytes.push(b));
      response.on('end', () => resolve({ status: response.statusCode,
        headers: Object.fromEntries(Object.entries(response.headers).filter(([k]) => !['connection','transfer-encoding','content-length'].includes(k)) .map(([k,v]) => [k, Array.isArray(v) ? v.join('\n') : String(v)])),
        body: Buffer.concat(bytes) }));
    }); req.on('error', reject); req.end(request.postDataBuffer());
  });
}
const html = `<!doctype html><html><body>
<div id="remembered-join" hidden><button id="remembered-reconnect">Reconnect</button></div>
<form id="remember-form"><label>Name<input id="device-name" value="Fixture browser" required></label><button id="remember-submit">Ask Mac to remember</button></form>
<p id="remember-status" role="status"></p><section id="remember-device"></section>
<script type="module">
import { rememberedBrowser } from '/remembered.mjs';
const client = rememberedBrowser({ reconnect: async () => { window.fixtureTicket = await client.ticket(); } });
await client.status(); window.fixtureReady = true;
</script></body></html>`;
try {
  await create(); const invitation = await receiver.invite('internet', policy);
  nodeViewer = new WebSocket(`ws://127.0.0.1:${receiver.port}/stream`, { origin, headers: { Host: new URL(origin).host } });
  let resumeCookie; nodeViewer.on('error', () => {}); nodeViewer.on('upgrade', response => resumeCookie = response.headers['set-cookie'][0]);
  await once(nodeViewer, 'open'); nodeViewer.send(invitation.key); await until(() => captures === 1);
  let externalRequests = 0;
  const attachRoutes = context => context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { externalRequests++; await route.abort(); return; }
    if (['/', '/stream/check'].includes(url.pathname)) { await route.fulfill({ contentType: 'text/html', body: html }); return; }
    if (url.pathname === '/remembered.mjs') { await route.fulfill({ contentType: 'text/javascript', body: await readFile('gui/receiver/remembered.mjs', 'utf8') }); return; }
    if (['/stream/remember','/stream/remember/status','/stream/trusted/connect'].includes(url.pathname)) { await route.fulfill(await upstream(req)); return; }
    await route.fulfill({ status: 404, body: '' });
  });
  let context = await chromium.launchPersistentContext(path.join(directory, 'browser-profile'), launchOptions); browser = context;
  await attachRoutes(context);
  // Bootstrap the existing authenticated temporary session. The enrollment
  // credential itself must be accepted from Set-Cookie, not injected by tests.
  const [resumePair] = resumeCookie.split(';'), split = resumePair.indexOf('=');
  await context.addCookies([{ name: resumePair.slice(0,split), value: resumePair.slice(split+1),
    domain: new URL(origin).hostname, path: '/stream', secure: true, httpOnly: true, sameSite: 'Strict' }]);
  let page = await context.newPage(); await page.goto(origin); await page.waitForFunction(() => window.fixtureReady);
  await page.getByRole('button', { name: 'Ask Mac to remember' }).click();
  await page.getByRole('status').filter({ hasText: /Waiting for approval/ }).waitFor();
  const pending = receiver.trustedStatus().pending; assert.equal(pending.length, 1);
  assert.equal(captures, 1); assert.equal(receiver.trustedStatus().devices.length, 0);
  const cookie = (await context.cookies()).find(c => c.name === 'dskcpy_device_v1');
  assert.ok(cookie); assert.equal(cookie.httpOnly, true); assert.equal(cookie.secure, true); assert.equal(cookie.sameSite, 'Strict');
  assert.equal(cookie.path, '/stream'); assert.ok(cookie.expires > Date.now()/1000 + 89 * 86400);
  const matchingPath = await context.newPage(); await matchingPath.goto(origin + '/stream/check');
  assert.equal(await matchingPath.evaluate(() => document.cookie.includes('dskcpy_device_v1')), false); await matchingPath.close();
  await receiver.trustAction('approve', pending[0].id);
  await page.getByRole('status').filter({ hasText: /Saved/ }).waitFor();
  await page.close(); nodeViewer.close(4000); await until(() => !receiver.status().connected);
  await context.close(); browser = null;
  for (const native of natives) native.destroy(); await receiver.shutdown(); await create(); await receiver.standby();
  context = await chromium.launchPersistentContext(path.join(directory, 'browser-profile'), launchOptions); browser = context;
  await attachRoutes(context);
  page = await context.newPage(); await page.goto(origin); await page.waitForFunction(() => window.fixtureReady);
  assert.equal(await page.getByRole('button', { name: 'Reconnect', exact: true }).isVisible(), true);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await page.waitForFunction(() => typeof window.fixtureTicket === 'string');
  assert.match(await page.evaluate(() => window.fixtureTicket), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(captures, 1); // requesting a short ticket alone never captures
  await receiver.trustAction('revoke', pending[0].id);
  await page.reload(); await page.waitForFunction(() => window.fixtureReady);
  assert.equal(await page.getByRole('button', { name: 'Reconnect', exact: true }).isVisible(), false);
  assert.equal(externalRequests, 0);
  const output = 'desktop/out/remembered-cookie'; await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ syntheticHttpsOrigin: true, realTlsTested: false,
    browserCookieHandling: true, cookieFromEnrollmentResponse: true, secureHttpOnlySameSite: true,
    credentialUnavailableToJavaScript: true, persistedAcrossPageReopen: true, persistedAcrossBrowserRestart: true, receiverRestart: true,
    revokedBrowserCannotReconnect: true, ticketAloneCaptures: false, realDeviceEnrolled: false, screenCapture: false, externalRequests }, null, 2));
  console.log('Chromium remembered cookie, browser/host restart and revocation fixture passed. No real TLS/media qualification.');
} finally {
  nodeViewer?.terminate(); await browser?.close(); for (const native of natives) native.destroy();
  await receiver?.shutdown(); await rm(directory, { recursive: true, force: true });
}
