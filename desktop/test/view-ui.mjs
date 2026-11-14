// Render the actual receiver with an owned broker and in-memory native input
// collector. No OS input, media capture, device, permission or live service.
import { chromium } from 'playwright';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { validBrowserInput } from '../../gui/server/browser-protocol.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const output = path.resolve('desktop/out/view-ui'); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
const results = [];
const until = async predicate => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('View fixture transition missing'); };
try { for (const variant of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 700, rtl: true }, { width: 640, height: 900, zoom: 2 }, { width: 390, height: 844, viewOnly: true }]) {
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
        if ([3, 7].includes(type)) inputs.push(packet);
      }
    });
    native.write(Buffer.from('535244310000000100000280000001e0', 'hex'));
  } });
  const invitation = await receiver.invite('local', { keyboard: !variant.viewOnly, viewOnly: !!variant.viewOnly });
  const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, hasTouch: true });
  const page = await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { delete window.RTCPeerConnection; });
  try {
    await page.goto(invitation.url + '#connect=' + invitation.key);
    await page.locator('#stream-panel').waitFor({ state: 'visible' });
    await until(() => page.locator('#display').evaluate(c => c.width === 640));
    if (variant.rtl) await page.locator('html').evaluate(el => el.dir = 'rtl');
    if (variant.zoom) await page.locator('html').evaluate((el, z) => el.style.zoom = z, variant.zoom);
    const canvas = page.locator('#display'), stage = page.locator('#stage');
    await canvas.evaluate(c => { const ctx = c.getContext('2d'); ctx.fillStyle = '#dce7ec'; ctx.fillRect(0, 0, c.width, c.height); ctx.fillStyle = '#101b22'; ctx.font = '24px sans-serif'; for (let y = 40; y < c.height; y += 80) for (let x = 20; x < c.width; x += 120) ctx.fillText(`${x},${y}`, x, y); });
    await page.getByRole('button', { name: 'Move view', exact: true }).click();
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    assert.equal(await page.locator('#view-scale').textContent(), 'Zoom: 150%');
    const start = inputs.length;
    assert.equal(await page.locator('#stage').getAttribute('role'), 'group');
    const cdp = await context.newCDPSession(page), fingers = new Map();
    const gesture = async (name, id, x, y) => {
      const r = await stage.boundingBox();
      if (name === 'up') fingers.delete(id);
      else fingers.set(id, { id, x: r.x + r.width * x, y: r.y + r.height * y });
      await cdp.send('Input.dispatchTouchEvent', { type: name === 'down' ? 'touchStart' : name === 'up' ? 'touchEnd' : 'touchMove', touchPoints: [...fingers.values()] });
    };
    await gesture('down', 1, .3, .5); await gesture('down', 2, .7, .5);
    await gesture('move', 2, .9, .5); await gesture('up', 2); await gesture('up', 1);
    assert.ok(parseFloat((await page.locator('#view-scale').textContent()).match(/[0-9]+/)[0]) > 150, 'actual two-finger gesture zooms');
    const beforePan = await canvas.evaluate(c => c.style.transform);
    await gesture('down', 3, .6, .5); await gesture('move', 3, .4, .45); await gesture('up', 3);
    assert.notEqual(await canvas.evaluate(c => c.style.transform), beforePan, 'one finger pans locally');
    await stage.focus(); await page.keyboard.press('+'); await page.keyboard.press('ArrowRight');
    await page.keyboard.press('0'); assert.equal(await page.locator('#view-scale').textContent(), 'Zoom: 100%');
    const focus = await stage.evaluate(e => ({ visible: e.matches(':focus-visible'), outline: getComputedStyle(e).outlineStyle }));
    assert.equal(focus.visible, true); assert.equal(focus.outline, 'solid');
    await page.keyboard.press('+'); await page.keyboard.press('+');
    await page.screenshot({ path: path.join(output, `view-${variant.width}-${!!variant.rtl}-${variant.zoom || 1}-${!!variant.viewOnly}.png`), fullPage: true });
    assert.equal(inputs.length, start, 'local navigation never sends remote pointer input');
    assert.equal(await page.evaluate(() => document.getElementById('rtc-display').style.transform === document.getElementById('display').style.transform), true, 'both media surfaces share the local transform');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // Tab-scroll every view button into reach; focus stays within the visible
    // scroller even in the narrow and CSS200% variants.
    for (const id of ['view-in', 'view-fit', 'view-up', 'view-right', 'close-view']) {
      await page.locator('#' + id).focus();
      const r = await page.locator('#' + id).boundingBox(); assert.ok(r.y >= 0 && r.y + r.height <= variant.height);
    }
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const r = await canvas.boundingBox(), surface = await stage.boundingBox();
    assert.ok(r.width > 0 && Math.abs(r.width / r.height - 640 / 480) < .01);
    const x = surface.x + surface.width * .5, y = surface.y + surface.height * .5;
    await page.mouse.click(x, y);
    if (variant.viewOnly) { await new Promise(r => setTimeout(r, 30)); assert.equal(inputs.length, start); }
    else {
      await until(() => inputs.length >= start + 2);
      assert.deepEqual(inputs.slice(-2).map(p => p[1]), [0, 1]);
      const tap = inputs.at(-1);
      assert.ok(Math.abs(tap.readUInt32BE(10) - (x - r.x) * 640 / r.width) < 2);
      assert.ok(Math.abs(tap.readUInt32BE(14) - (y - r.y) * 480 / r.height) < 2);
    }
    await page.getByRole('button', { name: 'Move view', exact: true }).click();
    await page.getByRole('button', { name: 'Fit desktop', exact: true }).click();
    if (variant.width === 844) {
      await page.getByRole('button', { name: 'Full screen', exact: true }).click();
      assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
    }
    await page.setViewportSize({ width: variant.width + 20, height: variant.height });
    assert.equal(await page.locator('#view-scale').textContent(), 'Zoom: 100%');
    assert.deepEqual(errors, []);
    results.push({ ...variant, pinch: true, pan: true, localOnly: true, zoomedInputMapping: !variant.viewOnly, keyboardAlternative: true, realNativeInput: false });
  } finally { await context.close(); native?.destroy(); await receiver.shutdown(); }
} await writeFile(path.join(output, 'result.json'), JSON.stringify({ syntheticNative: true, realPhone: false, results }, null, 2) + '\n');
console.log(`${results.length} Chromium local-view flows pass with fake native input.`);
} finally { await browser.close(); }
