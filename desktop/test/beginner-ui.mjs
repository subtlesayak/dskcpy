// Headless, synthetic app state only. No service, screen capture, permission,
// private route, invitation or office desktop is accessed by this test.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const output = path.resolve('desktop/out/ui-verification'); await mkdir(output, { recursive: true });
const root = path.resolve('gui/dist-desktop');
const server = http.createServer(async (request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
  try {
    const file = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) throw Error('Invalid fixture path');
    const bytes = await readFile(file);
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
const results = [];
try {
  for (const viewport of [{ width: 620, height: 740 }, { width: 320, height: 700 }, { width: 310, height: 370 }]) {
    for (const direction of ['ltr', 'rtl']) {
      const page = await browser.newPage({ viewport }); const errors = [];
      page.setDefaultTimeout(5000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.addInitScript(() => {
        let state = { phase: 'ready', features: { keyboard: true }, permissions: { screen: true, control: true },
          route: { connected: true, ready: true, conflict: false }, error: null, invitation: null, canStop: false };
        let change = () => {};
        window.dskcpyHost = {
          snapshot: async () => state, onChange: callback => { change = callback; return () => {}; },
          start: async () => { state = { ...state, phase: 'inviting', canStop: true,
            invitation: { joinUrl: 'https://example.invalid/join/synthetic#connect=synthetic-test-only', expiresAt: Date.now() + 300000 } }; change(state); return state; },
          stop: async () => { state = { ...state, phase: 'ready', canStop: false, invitation: null }; change(state); return state; },
          copyInvitation: async () => true, refresh: async () => state,
        };
      });
      await page.goto(origin + '/desktop/index.html');
      await page.locator('html').evaluate((html, dir) => html.dir = dir, direction);
      await page.getByRole('button', { name: 'Start sharing', exact: true }).waitFor();
      // Native keyboard path, with a named focused primary action.
      await page.keyboard.press('Tab');
      assert.equal(await page.locator(':focus').innerText(), 'Start sharing');
      await page.keyboard.press('Enter');
      await page.getByRole('img', { name: /Scan with/ }).waitFor();
      await page.getByRole('button', { name: 'Copy private link', exact: true }).click();
      assert.match(await page.getByRole('status').innerText(), /copied/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      const unnamed = await page.getByRole('button').evaluateAll(buttons => buttons.filter(button => !(button.textContent?.trim() || button.getAttribute('aria-label'))).length);
      assert.equal(unnamed, 0); assert.deepEqual(errors, []);
      await page.screenshot({ path: path.join(output, `invitation-${viewport.width}-${direction}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
      await page.getByRole('button', { name: 'Start sharing', exact: true }).waitFor();
      results.push({ viewport, direction, keyboardStart: true, copy: true, cancel: true, horizontalOverflow: false, pageErrors: 0 });
      await page.close();
    }
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ synthetic: true, realPermissions: false, realMedia: false, results }, null, 2));
  console.log(`${results.length} headless beginner-flow viewport/direction cases pass.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
