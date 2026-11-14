// Actual dashboard rendering with synthetic status/fetch/EventSource only.
// No controller, ADB, phone, permission, capture or existing stream is accessed.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const root = path.resolve('gui/dist'), output = path.resolve('desktop/out/startup-history-ui');
await mkdir(output, { recursive: true });
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) throw Error('Invalid path');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
const at = '2026-11-13T17:00:00.000Z';
const events = ['host-check', 'install-start', 'install-ready', 'launch-start', 'launch-ready', 'socket-wait'].map(phase => ({ phase, at }));
const attempt = (n, status = 'failed') => ({ attempt: n, status, phase: 'socket-wait', failure: 'socket-failed', startedAt: at, endedAt: at, events });
const state = { running: false, stopping: false, reconnecting: false, reconnectAttempt: 0, reconnectLimit: 3, nextRetryAt: null,
  config: null, readiness: { checks: [{ id: 'binary', ready: true, label: 'Program', message: 'Ready' }], checkedAt: at,
    transports: Object.fromEntries(['usb', 'wifi', 'ip', 'internet', 'browser'].map(mode => [mode, { ready: true, required: [], message: 'Ready' }])) },
  pid: null, encoder: null, latencyMs: null, command: null, startedAt: at, lastExitCode: 2, error: 'Synthetic connection ended.',
  hostPlatform: 'macOS', reverseDisplaySupported: true, binaryAvailable: true,
  logs: Array.from({ length: 160 }, (_, n) => ({ source: 'stderr', at, message: `DEBUG: retry ${n}` })),
  nativeStartup: { current: attempt(2), previous: [attempt(1)] } };
const results = [];
try {
  for (const variant of [{ width: 1080, height: 800, rtl: false, zoom: false }, { width: 320, height: 900, rtl: false, zoom: false },
    { width: 320, height: 900, rtl: true, zoom: false }, { width: 640, height: 900, rtl: false, zoom: true }]) {
    const page = await browser.newPage({ viewport: { width: variant.width, height: variant.height }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(7000);
    await page.addInitScript(initial => {
      window.startupFixture = initial;
      window.EventSource = class {
        constructor() { window.startupFixtureSource = this; queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(window.startupFixture) })); }
        close() {}
      };
    }, state);
    await page.route('**/api/**', async route => {
      assert.equal(route.request().method(), 'GET', 'Fixture must never start/stop or mutate a real service');
      const target = new URL(route.request().url()).pathname;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(target === '/api/status' ? state : target === '/api/devices' ? { devices: [], error: null } : { ready: false, peers: [] }) });
    });
    await page.goto(origin + '/#activity');
    await page.locator('html').evaluate((element, variant) => { element.dir = variant.rtl ? 'rtl' : 'ltr'; if (variant.zoom) element.style.zoom = '2'; }, variant);
    const panel = page.getByRole('region', { name: 'Phone connection steps', exact: true }); await panel.waitFor();
    assert.equal(await panel.locator('.startup-result').innerText(), 'Phone connection did not finish');
    assert.equal(await panel.getByText('Phone accepted the launch request', { exact: true }).first().isVisible(), true);
    assert.equal(await page.locator('.log-view').innerText().then(text => text.includes('launch acknowledged')), false);
    const summary = panel.locator('summary'); let reached = false;
    // Native Tab path through the rendered dashboard, without clicking controls.
    for (let n = 0; n < 50; n++) { await page.keyboard.press('Tab'); if (await summary.evaluate(element => element === document.activeElement)) { reached = true; break; } }
    assert.ok(reached, 'Earlier attempts must be reachable by keyboard');
    assert.notEqual(await summary.evaluate(element => getComputedStyle(element).outlineStyle), 'none');
    const visibleFocus = await summary.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const covered = ['.topbar', '.sidebar'].some(selector => {
        const bar = document.querySelector(selector).getBoundingClientRect();
        return bar.left <= rect.left && bar.right >= rect.right && bar.top <= rect.top && bar.bottom >= rect.bottom;
      });
      return rect.bottom > 0 && rect.top < innerHeight && !covered;
    });
    assert.equal(visibleFocus, true, 'Sticky chrome must not fully hide the focused disclosure');
    await page.keyboard.press('Space'); assert.equal(await panel.locator('details').getAttribute('open'), '');
    assert.equal(await panel.getByRole('list', { name: 'Earlier phone connection attempts', exact: true }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const contrast = await panel.evaluate(element => {
      const rgb = text => text.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => { const n = x / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; });
      const luminance = color => { const [r, g, b] = rgb(color); return .2126 * r + .7152 * g + .0722 * b; };
      const bg = luminance(getComputedStyle(element).backgroundColor);
      return ['h3', '.startup-guidance', 'time', 'a'].map(selector => { const fg = luminance(getComputedStyle(element.querySelector(selector)).color); return (Math.max(bg, fg) + .05) / (Math.min(bg, fg) + .05); });
    });
    assert.ok(contrast.every(value => value >= 4.5));
    await page.screenshot({ path: path.join(output, `steps-${variant.width}-${variant.rtl}-${variant.zoom}.png`), fullPage: true });
    await page.screenshot({ path: path.join(output, `viewport-${variant.width}-${variant.rtl}-${variant.zoom}.png`) });
    await panel.locator('.startup-steps li span').first().evaluate(element => { element.textContent = 'ConnectionPreparationWithLongTranslatedWords '.repeat(3); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    for (const status of ['starting', 'connected', 'stopped', 'unreported']) {
      await page.evaluate(({ state, status }) => {
        const next = structuredClone(state); next.nativeStartup.current.status = status;
        if (status === 'connected') { next.nativeStartup.current.phase = 'transport-ready'; next.nativeStartup.current.failure = null; }
        window.startupFixtureSource.onmessage({ data: JSON.stringify(next) });
      }, { state, status });
      assert.equal(await panel.locator('.startup-result').innerText(), ({ starting: 'Phone connection in progress', connected: 'Phone connection established', stopped: 'Phone connection stopped', unreported: 'Phone connection details unavailable' })[status]);
    }
    await page.evaluate(state => { const next = structuredClone(state); next.nativeStartup = null; window.startupFixtureSource.onmessage({ data: JSON.stringify(next) }); }, state);
    assert.equal(await panel.count(), 0); assert.deepEqual(errors, []);
    results.push({ ...variant, keyboardDisclosure: true, earlyStepsRetained: true, statusStates: true, contrast, horizontalOverflow: false, syntheticOnly: true });
    await page.close();
  }
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ results, actualPhoneOrCapture: false, browserZoomPhysical: false }, null, 2) + '\n');
  console.log('4 synthetic dashboard startup-history flows pass.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
