// Actual receiver, owned broker and generated canvas. No Mac capture, OS input,
// live controller or real software keyboard. Viewport changes model a docked IME.
import { chromium, webkit } from 'playwright';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { validBrowserInput, SrdParser } from '../../gui/server/browser-protocol.mjs';
import { generateMediaFixture, mediaPacket } from './media-fixture.mjs';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
const engine = process.argv[2] || 'chromium';
if (!['chromium', 'webkit'].includes(engine)) throw Error('Unknown test browser');
const tag = process.env.DSKCPY_TEST_RUN_TAG || '';
if (tag && !/^[a-z0-9-]+$/.test(tag)) throw Error('Invalid fixture run tag');
const output = path.resolve(`desktop/out/typing-view-${engine}${tag ? '-' + tag : ''}`); await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'results.json'), JSON.stringify({ status: 'running', physicalDevice: false }));
const media = await generateMediaFixture({ width: 1600, height: 900, level: '4.0' });
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' ? { channel: 'chromium', args: ['--disable-gpu'] } : {}) });
const until = async (predicate, label = 'transition') => { for (let i = 0; i < 600; ++i) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Typing fixture: ' + label); };
const results = []; let passed = false;
const parserErrors = [], parserPush = SrdParser.prototype.push;
SrdParser.prototype.push = function (chunk) { try { return parserPush.call(this, chunk); } catch (error) { parserErrors.push(error.message); throw error; } };
try {
 for (const variant of [{ width: 844, height: 390 }, { width: 844, height: 390, rtl: true },
   { width: 390, height: 844 }, { width: 320, height: 700, rtl: true },
   { width: 844, height: 780, zoom: 2 }, { width: 640, height: 780, zoom: 2 }]) {
  let native, pending = Buffer.alloc(0), framesSent = 0; const inputs = [], errors = [];
  const receiver = createBrowserReceiver({ configuredPort: 0, onConnect: async bridge => {
   try {
   native = net.connect(bridge.port, '127.0.0.1'); native.on('error', () => {}); await once(native, 'connect');
   let paused = true, frame = 0, tick = 0; const videoPending = new Set();
   native.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length) {
     const type = pending[0]; if (type === 9 && pending.length < 3) break;
     const size = type === 3 ? 32 : type === 7 ? 21 : [4, 6].includes(type) ? 9 : type === 5 ? 2 : type === 8 ? 5 : type === 9 ? 3 + pending.readUInt16BE(1) : 0;
     assert.ok(size, 'Unexpected test packet'); if (pending.length < size) break;
     const packet = Buffer.from(pending.subarray(0, size)); pending = pending.subarray(size);
     assert.ok(validBrowserInput(packet, 1600, 900, { keyboard: true })); inputs.push(packet);
     if (type === 4) for (const pts of videoPending) if (pts <= Number(packet.readBigUInt64BE(1))) videoPending.delete(pts);
     if (type === 5) {
      if (packet[1] === 7) paused = true;
      // Resume/IDR is idempotent. Re-sending configuration here creates a
      // decoder-config → IDR-request loop unlike the actual native host.
      if (packet[1] === 8) { paused = false; frame = 0; }
      if (packet[1] === 9) frame = 0;
     }
    }
   });
   const header = Buffer.alloc(16); header.write('SRD1'); header.writeUInt32BE(1, 4); header.writeUInt32BE(1600, 8); header.writeUInt32BE(900, 12); native.write(header);
   native.write(mediaPacket(media.configuration, 0, 1));
   const timer = setInterval(() => {
    const pts = tick++ * 100000; if (paused || native.destroyed || videoPending.size >= 2) return;
    const unit = media.frames[frame++ % media.frames.length]; videoPending.add(pts); framesSent++; native.write(mediaPacket(unit.payload, pts, unit.key ? 2 : 0));
   }, 100);
   native.once('close', () => clearInterval(timer));
   } catch (error) { errors.push('Synthetic native setup: ' + error.message); throw error; }
  } });
  const invitation = await receiver.invite('local', { keyboard: true });
  const context = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, hasTouch: true });
  const page = await context.newPage(); page.setDefaultTimeout(6000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
   delete window.RTCPeerConnection;
   window.fixtureSocketCloses = [];
   window.fixtureSends = [];
   window.fixtureErrors = [];
   document.addEventListener('DOMContentLoaded', () => {
    const error = document.getElementById('error');
    new MutationObserver(() => { if (error.textContent && window.fixtureErrors.length < 8) window.fixtureErrors.push(error.textContent); }).observe(error, { childList: true, subtree: true, characterData: true });
   });
   const BaseSocket = WebSocket;
   window.WebSocket = class extends BaseSocket {
    constructor(...args) { super(...args); this.addEventListener('close', event => window.fixtureSocketCloses.push({ code: event.code, reason: event.reason })); }
    send(data) {
     if (window.fixtureSends.length < 32) {
      if (typeof data === 'string') window.fixtureSends.push(/^[A-Za-z0-9_-]{32}$/.test(data) ? 'auth' : data.length < 64 ? data : 'metadata');
      else { const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
       window.fixtureSends.push({ type: bytes[0], action: bytes[0] === 5 || bytes[0] === 8 ? bytes[1] : null }); }
     }
     return super.send(data);
    }
   };
   const viewport = new EventTarget(); Object.assign(viewport, { width: innerWidth, height: innerHeight, offsetTop: 0, scale: 1 });
   Object.defineProperty(window, 'visualViewport', { value: viewport });
   window.fixtureKeyboardHeight = height => { viewport.height = height; viewport.dispatchEvent(new Event('resize')); };
  });
  try {
   await page.goto(invitation.url + '#connect=' + invitation.key);
   await page.locator('#stream-panel').waitFor({ state: 'visible' });
   await until(() => page.locator('#display').evaluate(canvas => canvas.width === 1600));
   if (variant.rtl) await page.locator('html').evaluate(element => element.dir = 'rtl');
   if (variant.zoom) await page.locator('html').evaluate((element, zoom) => element.style.zoom = String(zoom), variant.zoom);
   await page.locator('#display').evaluate(canvas => {
    const ctx = canvas.getContext('2d'); const paint = () => { ctx.fillStyle = '#e8edf1'; ctx.fillRect(0, 0, 1600, 900);
    ctx.fillStyle = '#273e4a'; ctx.fillRect(0, 0, 1600, 74); ctx.font = '32px sans-serif'; ctx.fillStyle = 'white'; ctx.fillText('Notes · generated desktop preview', 54, 48);
    ctx.fillStyle = '#243943'; ctx.font = '48px sans-serif'; ctx.fillText('Remote editing', 180, 250);
    ctx.font = '30px sans-serif'; ctx.fillText('Keep the field readable while you type.', 180, 330);
    ctx.fillStyle = 'white'; ctx.fillRect(180, 510, 900, 140); ctx.strokeStyle = '#1d7c9b'; ctx.lineWidth = 5; ctx.strokeRect(180, 510, 900, 140);
    ctx.fillStyle = '#243943'; ctx.font = '22px sans-serif'; ctx.fillText('Draft a message here', 210, 592);
    }; const draw = ctx.drawImage.bind(ctx);
    ctx.drawImage = (...args) => { draw(...args); paint(); window.fixtureRenderedFrames = (window.fixtureRenderedFrames || 0) + 1; }; paint();
   });
   await page.bringToFront();
   await until(() => page.evaluate(() => window.fixtureRenderedFrames > 0 && document.visibilityState === 'visible'
     && document.getElementById('status').textContent === 'Streaming'), 'decoded, visible streaming state');
   await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
   const canvas = page.locator('#display'); const original = await canvas.evaluate(element => element.style.transform);
   let rect = await canvas.boundingBox(); await page.mouse.click(rect.x + rect.width * .3, rect.y + rect.height * .65);
   await until(() => inputs.some(packet => packet[0] === 3 && packet[1] === 1), 'initial tap accepted');
   await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
   await page.locator('#keyboard-input').waitFor({ state: 'visible' });
   await page.evaluate(height => window.fixtureKeyboardHeight(height), variant.zoom ? 390 : variant.width > variant.height ? 160 : 460);
   await until(() => canvas.evaluate(element => Number(element.style.transform.match(/scale\(([0-9.]+)\)/)?.[1]) >= 2.5));
   const focused = await canvas.evaluate(element => { const r = element.getBoundingClientRect(), s = document.getElementById('stage').getBoundingClientRect(); return { x: r.x + r.width * .3, y: r.y + r.height * .65, stage: { x: s.x, y: s.y, width: s.width, height: s.height }, transform: element.style.transform }; });
   assert.ok(focused.x >= focused.stage.x - 1 && focused.x <= focused.stage.x + focused.stage.width + 1);
   assert.ok(focused.y >= focused.stage.y - 1 && focused.y <= focused.stage.y + focused.stage.height + 1);
   const beforeTap = inputs.length; await page.mouse.click(focused.x, focused.y);
   await until(() => inputs.slice(beforeTap).some(packet => packet[0] === 3 && packet[1] === 1));
   const tap = inputs.slice(beforeTap).find(packet => packet[0] === 3 && packet[1] === 1);
   assert.ok(Math.abs(tap.readUInt32BE(10) - 480) <= 2); assert.ok(Math.abs(tap.readUInt32BE(14) - 585) <= 2);
   await page.locator('#keyboard-input').fill('café 😊');
   await until(() => inputs.some(packet => packet[0] === 9));
   assert.equal(inputs.filter(packet => packet[0] === 9).map(packet => packet.subarray(3).toString()).join(''), 'café 😊');
   assert.equal(await page.evaluate(() => document.activeElement.id), 'keyboard-input');
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
   if (variant.width > variant.height && !variant.zoom) {
    const mode = page.getByRole('button', { name: 'Floating keyboard layout', exact: true });
    await mode.click(); await page.locator('#typing-layout-help').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#floating-keyboard-slot').isHidden(), true, 'docked keyboard gets guidance before side layout activates');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'keyboard-input');
    await mode.click(); await page.locator('#typing-layout-help').waitFor({ state: 'hidden' });
   }
   await page.screenshot({ path: path.join(output, `docked-${variant.width}-${!!variant.rtl}-${variant.zoom || 1}.png`), fullPage: true });
   await page.getByRole('button', { name: 'Close keyboard', exact: true }).click();
   await page.evaluate(height => window.fixtureKeyboardHeight(height), variant.height);
   await until(async () => (await canvas.evaluate(element => element.style.transform)) === original);
   await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
   const beside = page.getByRole('button', { name: 'Floating keyboard layout', exact: true });
   let split = false;
   if (variant.width > variant.height && !variant.zoom) {
    await beside.click(); await page.locator('#floating-keyboard-slot').waitFor({ state: 'visible' }); split = true;
    const stage = await page.locator('#stage').boundingBox(), pane = await page.locator('#control-panels').boundingBox();
    assert.ok(variant.rtl ? pane.x + pane.width <= stage.x + 1 : stage.x + stage.width <= pane.x + 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'keyboard-input');
    await page.screenshot({ path: path.join(output, `beside-${!!variant.rtl}.png`), fullPage: true });
    await beside.click(); await page.locator('#floating-keyboard-slot').waitFor({ state: 'hidden' });
   }
   assert.equal(await page.evaluate(() => document.getElementById('display').style.transform === document.getElementById('rtc-display').style.transform), true);
   assert.deepEqual(errors, []);
   results.push({ engine, ...variant, lastTapVisibleWhileDocked: true, zoomedTouchCoordinatesCorrect: true,
    unicodeExactlyOnce: true, previousViewRestored: true, floatingSpaceSeparated: split,
    dockedFloatingModeDiscoverable: variant.width > variant.height && !variant.zoom, noRealIMEOrCapture: true });
  } catch (error) {
   const stem = `failure-${variant.width}-${!!variant.rtl}-${variant.zoom || 1}`;
   await page.screenshot({ path: path.join(output, stem + '.png'), fullPage: true });
   await writeFile(path.join(output, stem + '.json'), JSON.stringify({ error: error.message, errors, parserErrors, framesSent,
    nativeInputs: inputs.slice(0,32).map(packet => ({type: packet[0], action: packet[0] === 5 || packet[0] === 8 ? packet[1] : null})), state: await page.evaluate(() => ({
    status: document.getElementById('status')?.textContent, visibility: document.visibilityState,
    error: document.getElementById('error')?.textContent, closes: window.fixtureSocketCloses,
    errorHistory: window.fixtureErrors,
    outgoing: window.fixtureSends,
    decoded: window.fixtureRenderedFrames || 0, transform: document.getElementById('display')?.style.transform,
    keyboardOpen: document.body.classList.contains('keyboard-open'),
   })) }, null, 2)); throw error;
  }
  finally { await context.close(); native?.destroy(); await receiver.shutdown(); }
 }
 passed = true;
 await writeFile(path.join(output, 'results.json'), JSON.stringify({ status: 'passed', simulatedKeyboard: true, physicalDevice: false, results }, null, 2));
 console.log(`${engine}: ${results.length} typing view scenarios pass.`);
} finally { SrdParser.prototype.push = parserPush; if (!passed) await writeFile(path.join(output, 'results.json'), JSON.stringify({ status: 'failed', physicalDevice: false, results }, null, 2)); await browser.close(); }
