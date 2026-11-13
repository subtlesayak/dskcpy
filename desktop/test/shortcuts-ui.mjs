// Render the actual receiver with an owned broker and in-memory native input
// collector. No OS input, media capture, device, permission or live service.
import { chromium } from 'playwright';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { SHORTCUT_KEYS, shortcutKeyLabel } from '../../gui/receiver/shortcuts.mjs';
import { validBrowserInput } from '../../gui/server/browser-protocol.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const output = path.resolve('desktop/out/shortcuts-ui'); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
const results = [];
const until = async predicate => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Shortcuts fixture transition missing'); };
try { for (const variant of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 700, rtl: true }, { width: 640, height: 900, zoom: 2 }, { width: 390, height: 844, storageDenied: true }, { width: 390, height: 844, viewOnly: true }]) {
  let native, pending = Buffer.alloc(0); const inputs = [], errors = [];
  const receiver = createBrowserReceiver({ configuredPort: 0, onConnect: async bridge => {
    native = net.connect(bridge.port, '127.0.0.1'); native.on('error', () => {}); await once(native, 'connect');
    native.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        const type = pending[0], size = type === 3 ? 32 : type === 7 ? 21 : [4, 6].includes(type) ? 9 : type === 5 ? 2 : type === 8 ? 5 : 0;
        assert.ok(size, 'Unexpected fixture input'); if (pending.length < size) return;
        const packet = Buffer.from(pending.subarray(0, size)); pending = pending.subarray(size);
        assert.ok(validBrowserInput(packet, 640, 480, { keyboard: true }));
        if (type === 8) inputs.push(packet);
      }
    });
    native.write(Buffer.from('535244310000000100000280000001e0', 'hex'));
  } });
  const invitation = await receiver.invite('local', { keyboard: !variant.viewOnly, viewOnly: !!variant.viewOnly });
  const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, hasTouch: true });
  const page = await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { delete window.RTCPeerConnection; });
  try {
    if (variant.storageDenied) await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Disabled', 'SecurityError'); } }); });
    await page.goto(invitation.url + '#connect=' + invitation.key);
    await page.locator('#stream-panel').waitFor({ state: 'visible' });
    await until(() => page.locator('#display').evaluate(c => c.width === 640));
    if (variant.rtl) await page.locator('html').evaluate(el => el.dir = 'rtl');
    if (variant.zoom) await page.locator('html').evaluate((el, z) => el.style.zoom = z, variant.zoom);
    if (variant.viewOnly) {
      assert.equal(await page.locator('#shortcuts').isHidden(), true);
      const before = inputs.length; await page.locator('#shortcut-0').evaluate(b => b.click());
      await new Promise(r => setTimeout(r, 30)); assert.equal(inputs.length, before);
      results.push({ ...variant, shortcutUnavailable: true, realNativeInput: false }); continue;
    }
    const open = () => page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
    await open();
    assert.deepEqual(await page.locator('#shortcut-key').evaluate(e => [...e.options].map(o => o.value)), [...SHORTCUT_KEYS], 'every offered code matches the bounded host-mapped key set');
    assert.deepEqual(await page.locator('#shortcut-key').evaluate(e => [...e.options].map(o => o.textContent)), SHORTCUT_KEYS.map(shortcutKeyLabel));
    const before = inputs.length;
    await page.locator('#shortcut-customize summary').click();
    await page.locator('#shortcut-slot').selectOption('0');
    await page.locator('#shortcut-key').selectOption('KeyS');
    await page.locator('#shortcut-mod-0').check(); await page.locator('#shortcut-mod-1').check();
    await page.getByRole('button', { name: 'Apply shortcut', exact: true }).click();
    assert.equal(inputs.length, before, 'editing a shortcut sends no keys');
    await page.locator('#shortcut-status').getByText(variant.storageDenied ? /storage is unavailable/ : /Saved in this browser/).waitFor();
    if (!variant.storageDenied) {
      await page.reload(); await until(() => page.locator('#display').evaluate(c => c.width === 640));
      if (variant.rtl) await page.locator('html').evaluate(el => el.dir = 'rtl');
      if (variant.zoom) await page.locator('html').evaluate((el, z) => el.style.zoom = z, variant.zoom);
      await open();
      assert.equal(await page.locator('#shortcut-0').textContent(), 'Ctrl + Shift + S');
    } else await page.locator('#shortcut-customize summary').click();
    if (variant.rtl) assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    if (variant.zoom) assert.equal(await page.locator('html').evaluate(el => parseFloat(el.style.zoom)), variant.zoom);
    const start = inputs.length;
    await page.getByRole('button', { name: 'Send Ctrl + Shift + S', exact: true }).click();
    await until(() => inputs.length >= start + 2);
    assert.deepEqual(inputs.slice(-2).map(p => [...p]), [[8, 0, 0, 22, 3], [8, 1, 0, 22, 0]]);
    if (!(await page.locator('#shortcut-customize').evaluate(e => e.open))) await page.locator('#shortcut-customize summary').click();
    await page.locator('#shortcut-slot').selectOption('1'); await page.locator('#shortcut-key').selectOption('ArrowLeft');
    for (let i = 0; i < 4; i++) await page.locator('#shortcut-mod-' + i).check();
    await page.getByRole('button', { name: 'Apply shortcut', exact: true }).click();
    await page.locator('#shortcut-customize summary').click();
    await page.locator('#shortcut-1').focus();
    const button = await page.locator('#shortcut-1').boundingBox(); assert.ok(button.y >= 0 && button.y + button.height <= variant.height);
    await page.keyboard.press('Enter');
    await until(() => inputs.length >= start + 4);
    assert.deepEqual(inputs.slice(-2).map(p => [...p]), [[8, 0, 0, 80, 15], [8, 1, 0, 80, 0]]);
    const heading = await page.locator('#shortcut-heading').boundingBox();
    const focusedButton = await page.locator('#shortcut-1').boundingBox();
    assert.ok(focusedButton.y >= heading.y + heading.height - 1, 'focused shortcut stays below sticky heading');
    const done = await page.locator('#close-shortcuts').boundingBox(); assert.ok(done.y >= 0 && done.y + done.height <= variant.height);
    const focus = await page.locator('#shortcut-1').evaluate(e => ({ visible: e.matches(':focus-visible'), outline: getComputedStyle(e).outlineStyle }));
    assert.equal(focus.visible, true); assert.equal(focus.outline, 'solid');
    if (variant.width === 844) { await page.getByRole('button', { name: 'Full screen', exact: true }).click(); assert.equal(await page.evaluate(() => !!document.fullscreenElement), true); }
    await page.screenshot({ path: path.join(output, `shortcuts-${variant.width}-${!!variant.rtl}-${variant.zoom || 1}-${!!variant.storageDenied}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Pause video', exact: true }).click();
    assert.equal(await page.locator('#shortcut-0').isDisabled(), true);
    const paused = inputs.length; await page.locator('#shortcut-0').evaluate(b => b.click()); await new Promise(r => setTimeout(r, 30)); assert.equal(inputs.length, paused);
    await page.getByRole('button', { name: 'Resume video', exact: true }).click();
    await page.locator('#shortcut-customize summary').click(); const reset = inputs.length;
    await page.getByRole('button', { name: 'Reset shortcuts', exact: true }).click(); assert.equal(inputs.length, reset);
    await page.locator('#close-shortcuts').click();
    assert.equal(await page.locator('#shortcuts').getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
    results.push({ ...variant, balancedChord: true, savedLocally: !variant.storageDenied, noConfigureInput: true, pauseGated: true, keyboardActivation: true, realNativeInput: false });
  } finally { await context.close(); native?.destroy(); await receiver.shutdown(); }
} await writeFile(path.join(output, 'result.json'), JSON.stringify({ syntheticNative: true, realPhone: false, results }, null, 2) + '\n');
console.log(`${results.length} Chromium shortcut flows pass with fake native input.`);
} finally { await browser.close(); }
