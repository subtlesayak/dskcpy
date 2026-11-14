// Synthetic renderer states only: no real device, permission API or service.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const root = path.resolve('gui/dist-desktop'), output = path.resolve('desktop/out/usb-ui');
await mkdir(output, { recursive: true });
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/favicon.ico') return response.writeHead(204).end();
    const file = path.resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) throw Error('Invalid fixture path');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[path.extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
const results = [];
try {
  for (const variant of [{ width: 620, rtl: false, zoom: 1 }, { width: 320, rtl: false, zoom: 1 }, { width: 320, rtl: true, zoom: 1 }, { width: 640, rtl: false, zoom: 2 }]) {
    const page = await browser.newPage({ viewport: { width: variant.width, height: 740 } });
    page.setDefaultTimeout(5000); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let state = { connection: 'internet', phase: 'network', permissions: { screen: true, control: true }, route: { connected: false, ready: false },
        usb: { available: true, error: false, selected: null, devices: [] }, features: { keyboard: true, clipboard: true }, clipboardAllowed: false, canStop: false, invitation: null, error: null };
      let change = () => {};
      const emit = update => { state = { ...state, ...update }; change(state); return state; };
      window.usbFixture = (phase, devices = []) => emit({ phase, usb: { ...state.usb, devices, selected: null } });
      window.dskcpyHost = {
        snapshot: async () => state, onChange: callback => { change = callback; return () => {}; },
        setConnection: async connection => emit({ connection, phase: connection === 'usb' ? 'usb-device' : 'network' }),
        selectUsbDevice: async id => emit({ phase: 'ready', usb: { ...state.usb, selected: id } }),
        setClipboardAllowed: async allowed => emit({clipboardAllowed:allowed}),
        refresh: async () => state,
        start: async () => emit({ phase: 'inviting', canStop: true, invitation: { joinUrl: 'http://127.0.0.1:27180/join/synthetic#connect=fixture-only', openedOnPhone: true, expiresAt: Date.now() + 300000 } }),
        stop: async () => emit({ clipboardAllowed:false, phase: 'ready', canStop: false, invitation: null }),
        copyInvitation: async () => true,
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/desktop/index.html`);
    await page.locator('html').evaluate((html, rtl) => html.dir = rtl ? 'rtl' : 'ltr', variant.rtl);
    if (variant.zoom !== 1) await page.locator('body').evaluate((body, zoom) => body.style.zoom = zoom, variant.zoom);
    const cable = page.getByRole('radio', { name: /USB cable/ });
    await cable.focus(); await page.keyboard.press('Space');
    await page.getByRole('heading', { name: 'Connect your Android phone', exact: true }).waitFor();
    for (const [phase, heading] of [['usb-tool', 'The USB component is unavailable'], ['usb-authorize', 'Allow this computer on your phone'], ['usb-select', 'Choose the phone to connect']]) {
      await page.evaluate(phase => window.usbFixture(phase, phase === 'usb-select' ? [
        { id: 'one', name: 'A phone with a long translated model name', state: 'ready' },
        { id: 'two', name: 'Second phone', state: 'ready' },
        { id: 'three', name: 'Third phone', state: 'unauthorized' },
      ] : []), phase);
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, `${phase} must reflow`);
      await page.screenshot({ path: path.join(output, `${phase}-${variant.width}-${variant.rtl}-${variant.zoom}.png`), fullPage: true });
    }
    const select = page.getByRole('radio', { name: /Second phone/ });
    await select.focus(); await page.keyboard.press('Space');
    await page.getByRole('heading', { name: 'Share with your USB phone', exact: true }).waitFor();
    const consent=page.getByRole('checkbox',{name:'Allow text clipboard for this invitation',exact:true});
    assert.equal(await consent.isChecked(),false);await consent.check();
    await page.screenshot({path:path.join(output,`ready-consent-${variant.width}-${variant.rtl}-${variant.zoom}.png`),fullPage:true});
    const start = page.getByRole('button', { name: 'Start sharing', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.includes('Start sharing') && !button.disabled));
    await page.keyboard.press('Tab');
    assert.equal(await start.evaluate(button => document.activeElement === button), true);
    assert.notEqual(await start.evaluate(button => getComputedStyle(button).outlineStyle), 'none');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Continue on your phone', exact: true }).waitFor();
    assert.equal(await page.getByRole('img').count(), 0, 'cable flow must not ask for a QR');
    assert.equal(await cable.isDisabled(), true, 'active invitation locks connection selection');
    await page.getByRole('button', { name: 'Copy USB link', exact: true }).click();
    assert.match(await page.getByRole('status').innerText(), /USB link copied/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await page.getByRole('button', { name: 'Cancel invitation', exact: true }).click();
    await start.waitFor(); assert.equal(await consent.isChecked(),false);
    await page.evaluate(() => window.usbFixture('error'));
    await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    assert.equal(await page.getByRole('button').evaluateAll(buttons => buttons.every(button => button.textContent.trim() || button.getAttribute('aria-label'))), true);
    results.push({ ...variant, keyboardPath: true, noQr: true, modeLockedDuringInvitation: true, copyCancelRetry: true, horizontalOverflow: false });
    await page.close();
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ synthetic: true, realUSB: false, screenReader: 'not tested', results }, null, 2));
  console.log(`${results.length} synthetic USB setup layouts and keyboard flows pass.`);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
