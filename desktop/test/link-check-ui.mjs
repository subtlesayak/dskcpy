// Built desktop UI + real HostController with an injected backend/probe only.
// No Electron app, native program, route, HTTPS peer, capture or real invitation.
import { chromium } from 'playwright';
import { HostController } from '../host-controller.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const root = path.resolve('gui/dist-desktop'), output = path.resolve('desktop/out/link-check-ui'); await mkdir(output, { recursive: true });
const server = http.createServer(async (request, response) => {
  try {
    const file = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) throw Error('Invalid path');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' })[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] }), results = [];
try { for (const variant of [{ width: 620, height: 740, reason: 'certificate' }, { width: 320, height: 700, rtl: true, reason: 'name' }, { width: 640, height: 900, zoom: 2, reason: 'response' }]) {
  const page = await browser.newPage({ viewport: { width: variant.width, height: variant.height } }); page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let status = { running: false, browser: { waiting: false, connected: false } }, invites = 0, resolveProbe, signal;
  const route = { connected: true, ready: true, origin: 'https://fixture.test.ts.net:8443' };
  const backend = {
    status: async () => status,
    prepareReceiver: async () => ({ url: route.origin + '/', instance: 'c'.repeat(32) }),
    invite: async () => { invites++; status = { running: false, browser: { waiting: true, connected: false } };
      return { mode: 'internet', url: route.origin + '/', key: 'a'.repeat(32), expiresAt: Date.now() + 300000, status }; },
    stop: async () => { status = { running: false, browser: { waiting: false, connected: false } }; }, shutdown: async () => {},
  };
  const host = new HostController({ backend, checkSetup: async () => ({ permissions: { screen: true, control: true }, runtimeReady: true, route, features: { keyboard: true } }),
    probeReceiver: (_descriptor, _origin, options) => { signal = options.signal; return new Promise(resolve => resolveProbe = resolve); },
    onChange: snapshot => { void page.evaluate(state => window.fixtureChange?.(state), snapshot).catch(() => {}); } });
  try {
    await host.refresh({ setup: true });
    await page.exposeFunction('fixtureAction', action => {
      if (action === 'snapshot') return host.snapshot();
      if (action === 'start') return host.start();
      if (action === 'stop') return host.stop();
      throw Error('Unexpected fixture action');
    });
    await page.addInitScript(() => { window.dskcpyHost = {
      snapshot: () => window.fixtureAction('snapshot'), start: () => window.fixtureAction('start'), stop: () => window.fixtureAction('stop'),
      onChange: callback => { window.fixtureChange = callback; return () => delete window.fixtureChange; },
    }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/desktop/index.html`);
    await page.locator('html').evaluate((html, v) => { html.dir = v.rtl ? 'rtl' : 'ltr'; if (v.zoom) html.style.zoom = v.zoom; }, variant);
    await page.getByRole('button', { name: 'Start sharing', exact: true }).click();
    await page.getByRole('heading', { name: 'Checking your private link', exact: true }).waitFor();
    assert.equal(invites, 0); assert.equal(await page.locator('.qr').count(), 0); assert.equal(host.snapshot().invitation, null);
    assert.ok(!await page.locator('body').innerText().then(text => text.includes('c'.repeat(32))));
    // Cancel is keyboard-reachable even while Start's promise is unresolved.
    await page.keyboard.press('Shift+Tab'); assert.equal(await page.locator(':focus').innerText(), 'Cancel invitation');
    await page.keyboard.press('Enter'); await page.getByRole('button', { name: 'Start sharing', exact: true }).waitFor(); assert.equal(signal.aborted, true);
    resolveProbe({ ready: true }); assert.equal(invites, 0);
    await page.getByRole('button', { name: 'Start sharing', exact: true }).click();
    await page.getByRole('heading', { name: 'Checking your private link', exact: true }).waitFor(); resolveProbe({ ready: false, reason: variant.reason });
    await page.getByRole('button', { name: 'Try again', exact: true }).waitFor(); assert.equal(invites, 0);
    assert.match(await page.locator('.description').innerText(), /try again/);
    assert.equal(await page.getByRole('alert').innerText(), host.snapshot().error);
    assert.equal(await page.locator('.qr').count(), 0); assert.equal(host.snapshot().route.verified, false);
    assert.equal(await page.locator('.setup-list li').last().locator('.done').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `link-error-${variant.width}-${!!variant.rtl}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('heading', { name: 'Checking your private link', exact: true }).waitFor(); resolveProbe({ ready: true });
    await page.getByRole('img', { name: /Scan with/ }).waitFor(); assert.equal(invites, 1);
    await page.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
    await page.getByRole('button', { name: 'Start sharing', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Start sharing', exact: true }).click();
    await page.getByRole('heading', { name: 'Checking your private link', exact: true }).waitFor();
    status = { running: false, browser: { waiting: true, connected: false } }; resolveProbe({ ready: false, reason: 'timeout' });
    await page.getByRole('heading', { name: 'Waiting for the receiver', exact: true }).waitFor();
    assert.equal(await page.locator('.qr').count(), 0); assert.equal(await page.getByRole('button', { name: 'Copy private link', exact: true }).count(), 0); assert.equal(invites, 1);
    await page.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
    await page.getByRole('button', { name: 'Start sharing', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    results.push({ ...variant, keyboardCancel: true, noInvitationBeforeSuccess: true, failureGuidance: true, retry: true, existingPendingConnectionPreserved: true, syntheticBackendAndProbe: true });
  } finally { await host.close(); await page.close(); }
} await writeFile(path.join(output, 'result.json'), JSON.stringify({ realRouteOrCertificate: false, realGrantOrCapture: false, results }, null, 2) + '\n');
console.log(`${results.length} Chromium private-link check flows pass with fake backend/probe.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
