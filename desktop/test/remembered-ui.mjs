// Synthetic owner UI only: no live host, permission, route, or real enrollment.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('gui/dist-desktop');
const output = path.resolve('desktop/out/remembered-ui'); await mkdir(output, { recursive: true });
const server = http.createServer(async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  try {
    const filename = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!filename.startsWith(root + path.sep)) throw new Error();
    const bytes = await readFile(filename);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(filename)] || 'application/octet-stream'); res.end(bytes);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
const results = [];
try {
  for (const width of [320, 620]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } }); const errors = [];
    page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(6000);
    await page.addInitScript(() => {
      const pending = { id: 'a'.repeat(32), name: 'Test phone', expiresAt: Date.now() + 300000 };
      let devices = { available: true, paused: false, pending: [pending], devices: [] };
      window.deviceActions = [];
      window.dskcpyHost = { snapshot: async () => ({ phase: 'sharing', features: { keyboard: true }, permissions: { screen: true, control: true },
        route: { connected: true, ready: true }, canStop: true, error: null, invitation: null }), onChange: () => () => {},
        trustedList: async () => devices,
        trustedAction: async (action, id) => {
          window.deviceActions.push({ action, id });
          if (action === 'approve') devices = { ...devices, pending: [], devices: [{ ...pending, expiresAt: Date.now() + 7776000000 }] };
          if (action === 'pause') devices = { ...devices, paused: true };
          if (action === 'resume') devices = { ...devices, paused: false };
          if (action === 'revoke') devices = { ...devices, devices: [] };
          return devices;
        } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/desktop/index.html`);
    await page.getByRole('button', { name: 'Allow remembered access', exact: true }).waitFor();
    assert.match(await page.locator('.remembered-device-request').innerText(), /control the entire desktop for 90 days/);
    assert.deepEqual(await page.evaluate(() => window.deviceActions), []);
    await page.screenshot({ path: path.join(output, `approval-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Allow remembered access', exact: true }).click();
    await page.getByRole('button', { name: 'Pause remembered access', exact: true }).click();
    await page.getByRole('button', { name: 'Enable remembered access', exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.getByRole('button', { name: 'Revoke Test phone', exact: true }).click();
    assert.match(await page.locator('.remembered-devices').innerText(), /No remembered devices/);
    assert.deepEqual((await page.evaluate(() => window.deviceActions)).map(e => e.action), ['approve', 'pause', 'resume', 'revoke']);
    assert.deepEqual(errors, []); results.push({ width, explicitApproval: true, pauseResumeRevoke: true, horizontalOverflow: false }); await page.close();
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ synthetic: true, liveHostAccessed: false, results }, null, 2));
  console.log(`${results.length} remembered-device owner UI scenarios pass.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
