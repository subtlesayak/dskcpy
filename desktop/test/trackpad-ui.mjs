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
const output = path.resolve('desktop/out/trackpad-ui'); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--disable-gpu'] });
const results = [];
const until = async predicate => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Trackpad fixture transition missing'); };
try { for (const variant of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 700, rtl: true }, { width: 640, height: 900, zoom: 2 }]) {
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
  const invitation = await receiver.invite('local', { keyboard: true });
  const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, hasTouch: true });
  const page = await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => { delete window.RTCPeerConnection; });
  try {
    await page.goto(invitation.url + '#connect=' + invitation.key);
    await page.locator('#stream-panel').waitFor({ state: 'visible' });
    await until(() => page.locator('#display').evaluate(c => c.width === 640));
    if (variant.rtl) await page.locator('html').evaluate(el => el.dir = 'rtl');
    if (variant.zoom) await page.locator('html').evaluate((el, z) => el.style.zoom = z, variant.zoom);
    await page.getByRole('button', { name: 'Trackpad mode', exact: true }).click();
    const canvas = page.locator('#display');
    // Trackpad mode exposes helper controls and resizes the stage. The product
    // deliberately cancels touches when geometry changes. Test the stable-mode
    // gesture only after real layout/observer frames settle, rather than racing
    // that transition on slower CI renderers. Resize cancellation is checked below.
    await canvas.evaluate(async canvas => {
      let previous='',stable=0;
      for(let frame=0;frame<90;frame++){
        await new Promise(requestAnimationFrame);
        const r=canvas.getBoundingClientRect(),sample=[r.x,r.y,r.width,r.height].join(',');
        stable=sample===previous?stable+1:0;previous=sample;
        if(r.width>0&&r.height>0&&stable>=3)return;
      }
      throw Error('Trackpad geometry did not settle');
    });
    const cdp = await context.newCDPSession(page), fingers = new Map();
    const gesture = async (name, pointerId, x, y) => {
      const r = await canvas.boundingBox(); assert.ok(r.width > 0 && r.height > 0);
      if (name === 'pointerup') fingers.delete(pointerId);
      else fingers.set(pointerId, { id: pointerId, x: r.x + r.width * x, y: r.y + r.height * y });
      await cdp.send('Input.dispatchTouchEvent', { type: name === 'pointerdown' ? 'touchStart' : name === 'pointerup' ? 'touchEnd' : 'touchMove', touchPoints: [...fingers.values()] });
    };
    await gesture('pointerdown', 1, .1, .3); await gesture('pointermove', 1, .3, .3); await gesture('pointerup', 1, .3, .3);
    await until(() => inputs.length > 0); assert.equal(inputs[0][0], 7); assert.equal(inputs[0].readInt32BE(13), 0); assert.equal(inputs[0].readInt32BE(17), 0);
    assert.ok(Math.abs(inputs[0].readUInt32BE(1) - 447) < 2);
    await gesture('pointerdown', 2, .8, .4); await gesture('pointerup', 2, .8, .4);
    await until(() => inputs.length >= 3); assert.deepEqual(inputs.slice(-2).map(p => p[1]), [0, 1]);
    assert.equal(inputs.at(-1).readUInt32BE(10), inputs[0].readUInt32BE(1), 'tap is at the cursor, not finger contact');
    await page.getByRole('button', { name: 'Start drag', exact: true }).click();
    await gesture('pointerdown', 3, .3, .3); await gesture('pointermove', 3, .4, .3); await gesture('pointerup', 3, .4, .3);
    await until(() => inputs.at(-1)?.[1] === 2); assert.equal(await page.locator('#drag-mode').getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Release drag', exact: true }).click(); await until(() => inputs.at(-1)?.[1] === 3);
    const start = inputs.length;
    await gesture('pointerdown', 4, .3, .5); await gesture('pointerdown', 5, .6, .5); await gesture('pointermove', 5, .6, .3);
    await until(() => inputs.length > start); assert.equal(inputs.at(-1)[0], 7); assert.ok(inputs.at(-1).readInt32BE(17) > 0);
    await gesture('pointerup', 5, .6, .3); await gesture('pointermove', 4, .2, .4); await gesture('pointerup', 4, .2, .4);
    await new Promise(r => setTimeout(r, 25)); assert.equal(inputs.length, start + 1);
    await canvas.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Enter');
    await until(() => inputs.length >= start + 4); assert.deepEqual(inputs.slice(-2).map(p => p[1]), [0, 1]);
    const ring = await canvas.evaluate(c => ({ visible: c.matches(':focus-visible'), style: getComputedStyle(c).outlineStyle }));
    assert.equal(ring.visible, true); assert.equal(ring.style, 'solid');
    if (variant.width === 844) {
      await page.getByRole('button', { name: 'Full screen', exact: true }).click();
      assert.equal(await page.evaluate(() => !!document.fullscreenElement), true);
    }
    await page.screenshot({ path: path.join(output, `trackpad-${variant.width}-${!!variant.rtl}-${variant.zoom || 1}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const helper = await page.locator('#trackpad-help').boundingBox(); assert.ok(helper && helper.y >= 0 && helper.y + helper.height <= variant.height);
    const videoBounds = await canvas.boundingBox(); assert.ok(Math.abs(videoBounds.width / videoBounds.height - 640 / 480) < .01, 'video keeps its aspect ratio at page zoom');
    assert.ok(videoBounds.y >= 0 && videoBounds.y + videoBounds.height <= variant.height);
    const cursor = await page.locator('#trackpad-cursor').boundingBox();
    assert.ok(cursor && cursor.x + cursor.width / 2 >= videoBounds.x && cursor.x + cursor.width / 2 <= videoBounds.x + videoBounds.width);
    assert.ok(cursor.y + cursor.height / 2 >= videoBounds.y && cursor.y + cursor.height / 2 <= videoBounds.y + videoBounds.height);
    // A geometry change must cancel an intentional hold, not replay it in the
    // resized coordinate space. Other lifecycle cases run in receiver.test.
    await page.getByRole('button', { name: 'Start drag', exact: true }).click();
    await page.setViewportSize({ width: variant.width + 20, height: variant.height });
    await until(() => page.locator('#drag-mode').getAttribute('aria-pressed').then(x => x === 'false'));
    await until(() => inputs.at(-1)?.[1] === 3);
    assert.deepEqual(errors, []);
    results.push({ ...variant, relativePointer: true, oneTap: true, explicitDragRelease: true, twoFingerScroll: true, keyboardAlternative: true, resizeCancelsHold: true, realNativeInput: false });
  } catch(error) {
    console.error(JSON.stringify({variant,error:error.message,inputs:inputs.length,pageErrors:errors,
      state:await page.evaluate(()=>({status:document.querySelector('#status').textContent,error:document.querySelector('#error').textContent,
        trackpad:document.querySelector('#trackpad-mode').getAttribute('aria-pressed'),geometry: (()=>{const r=document.querySelector('#display').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()}))}));
    throw error;
  } finally { await context.close(); native?.destroy(); await receiver.shutdown(); }
} await writeFile(path.join(output, 'result.json'), JSON.stringify({ syntheticNative: true, realPhone: false, results }, null, 2) + '\n');
console.log(`${results.length} Chromium trackpad flows pass with fake native input.`);
} finally { await browser.close(); }
