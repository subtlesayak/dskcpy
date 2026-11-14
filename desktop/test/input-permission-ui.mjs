// Owned headless UI only: fake permission state, no capture or real OS input.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve('gui/dist-desktop');
const output = path.resolve('desktop/out/input-permission-ui'); await mkdir(output, { recursive: true });
const server = http.createServer(async (request, response) => {
  if (request.url === '/favicon.ico') { response.writeHead(204).end(); return; }
  try {
    const file = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) throw Error('Outside fixture');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
const results = [];
try {
  for (const size of [{ width: 620, zoom: 1 }, { width: 320, zoom: 1 }, { width: 620, zoom: 2 }]) {
    for (const direction of ['ltr', 'rtl']) {
      const page = await browser.newPage({ viewport: { width: size.width, height: 740 } });
      page.setDefaultTimeout(5000); const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        let state = { phase: 'sharing', nativeInputPermission: 'blocked', features: { keyboard: true },
          permissions: { screen: true, control: true }, route: { connected: true, ready: true },
          error: null, invitation: null, canStop: true };
        let change = () => {};
        window.fixtureActions = { permissions: 0, stops: 0 };
        window.fixtureStatus = value => { state = { ...state, nativeInputPermission: value }; change(state); };
        window.dskcpyHost = { snapshot: async () => state, onChange: callback => { change = callback; return () => {}; },
          refresh: async () => state,
          controlPermission: async () => { ++window.fixtureActions.permissions; },
          stop: async () => { ++window.fixtureActions.stops; state = { ...state, phase: 'ready', canStop: false, nativeInputPermission: null }; change(state); return state; },
        };
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/desktop/index.html`);
      await page.evaluate(({ direction, zoom }) => { document.documentElement.dir = direction; document.documentElement.style.zoom = String(zoom); }, { direction, zoom: size.zoom });
      const control = page.getByRole('button', { name: 'Open control permissions', exact: true });
      await control.waitFor();
      assert.match(await page.locator('.description').innerText(), /macOS is blocking mouse and keyboard/);
      assert.equal(await page.getByRole('button', { name: 'Stop sharing', exact: true }).isEnabled(), true);
      await control.click();
      assert.deepEqual(await page.evaluate(() => window.fixtureActions), { permissions: 1, stops: 0 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await page.screenshot({ path: path.join(output, `blocked-${size.width}-${size.zoom}-${direction}.png`), fullPage: true });
      await page.evaluate(() => window.fixtureStatus('ready'));
      await control.waitFor({ state: 'detached' });
      assert.match(await page.locator('.description').innerText(), /use mouse and keyboard/);
      await page.evaluate(() => window.fixtureStatus('unreported'));
      await control.waitFor();
      assert.match(await page.locator('.description').innerText(), /has not reported whether remote control is allowed/);
      await page.getByRole('button', { name: 'Stop sharing', exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.fixtureActions), { permissions: 1, stops: 1 });
      assert.deepEqual(errors, []);
      results.push({ ...size, direction, shellReadyNativeBlockedShown: true, permissionActionDoesNotStop: true,
        grantClearsWarningSameSession: true, unreportedDoesNotClaimControl: true, stopRemainsAvailable: true, realPermissions: false });
      await page.close();
    }
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ synthetic: true, realCapture: false, results }, null, 2));
  console.log(`${results.length} input-permission guidance scenarios pass.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
