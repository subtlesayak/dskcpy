// Two real isolated browser contexts, generated video and a fake native input
// collector. No TV/casting API, OS capture, real clipboard or desktop input.
import { chromium, webkit } from 'playwright';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { browserJoinUrl } from '../../gui/receiver/protocol.mjs';
import { generateMediaFixture, mediaPacket } from './media-fixture.mjs';
import { confirmReceiverAction } from './browser-actions.mjs';
import { once } from 'node:events';
import net from 'node:net';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const engine = process.argv[2] || 'chromium';
if (!['chromium', 'webkit'].includes(engine)) throw Error('Unknown fixture browser');
const output = path.resolve(`desktop/out/presentation-${engine}`); await mkdir(output, { recursive: true });
const generated = await generateMediaFixture();
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true,
  ...(engine === 'chromium' ? { channel: 'chromium', args: ['--disable-gpu', '--mute-audio'] } : {}) });
const until = async (predicate, label) => { for (let i = 0; i < 600; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('Presentation fixture: ' + label); };
const results = []; let pass = false;
const decodedFrames = page => page.evaluate(async () => {
  const peer = window.__testPeers?.at(-1);
  if (!peer) return window.__testDecodedFrames;
  return [...(await peer.getStats()).values()].filter(value => value.type === 'inbound-rtp' && value.kind === 'video')
    .reduce((count, value) => count + (value.framesDecoded || 0), 0);
});
try {
 for (const variant of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 700, rtl: true }, { width: 640, height: 780, zoom: 2 }, {width:390,height:844,pointerButtons:false}]) {
  let native, pending = Buffer.alloc(0), nativeCalls = 0, frames = 0, acks = 0, pointerDowns = 0, scrolls = 0, typed = '';
  const held = new Set(), errors = [], inputs = [], pendingVideo = new Set();
  let bridge;
  const broker = createBrowserReceiver({ configuredPort: 0, presentationControl: true, onConnect: async value => {
    bridge = value; nativeCalls++; native = net.connect(value.port, '127.0.0.1'); native.on('error', () => {}); await once(native, 'connect');
    let paused = true, frame = 0, tick = 0;
    native.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        const type = pending[0]; if (type === 9 && pending.length < 3) break;
        const size = type === 11 ? 14 : type === 3 ? 32 : type === 7 ? 21 : [4, 6].includes(type) ? 9 : type === 5 ? 2 : type === 8 ? 5 : type === 9 ? 3 + pending.readUInt16BE(1) : 0;
        assert.ok(size, 'unexpected owned fixture packet'); if (pending.length < size) break;
        const packet = Buffer.from(pending.subarray(0, size)); pending = pending.subarray(size); inputs.push(packet);
        if (type === 4) { acks++; const pts = packet.readBigUInt64BE(1); for (const old of pendingVideo) if (old <= pts) pendingVideo.delete(old); }
        if (type === 5 && packet[1] === 7) paused = true;
        if (type === 5 && packet[1] === 8) paused = false;
        if (type === 3) { if (packet[1] === 0) { pointerDowns++; held.add('mouse'); } else if ([1, 3, 6].includes(packet[1])) held.delete('mouse'); }
        if (type === 7 && (packet.readInt32BE(13) || packet.readInt32BE(17))) scrolls++;
        if (type === 8) {
          if (packet[1] === 2) { for (const value of held) if (typeof value === 'number') held.delete(value); }
          else if (packet[1] === 0) { held.add(packet.readUInt16BE(2)); if (packet.readUInt16BE(2) === 42 && packet[4] === 0) typed = Array.from(typed).slice(0, -1).join(''); }
          else held.delete(packet.readUInt16BE(2));
        }
        if (type === 9) typed += packet.subarray(3).toString('utf8');
      }
    });
    const header = Buffer.from('53524431000000010000028000000168', 'hex'); native.write(header); native.write(mediaPacket(generated.configuration, 0, 1));
    const timer = setInterval(() => {
      const pts = BigInt(tick++ * 100000); if (paused || native.destroyed || pendingVideo.size >= 2) return;
      const unit = generated.frames[frame++ % generated.frames.length]; pendingVideo.add(pts); frames++; native.write(mediaPacket(unit.payload, pts, unit.key ? 2 : 0));
    }, 100);
    native.once('close', () => clearInterval(timer));
  } });
  const pictureContext = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const controllerContext = await browser.newContext({ viewport: { width: variant.width, height: variant.height }, hasTouch: true });
  let picture, controller;
  try {
    await pictureContext.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.__testControllerLink = value; } } });
      window.__testDecodedFrames = 0;
      window.__testPeers = [];
      if (window.RTCPeerConnection) { const Original = RTCPeerConnection; window.RTCPeerConnection = class extends Original { constructor(...args) { super(...args); window.__testPeers.push(this); } }; }
      if (window.VideoDecoder) {
        const Original = VideoDecoder;
        window.VideoDecoder = class extends Original { constructor(init) { super({ ...init, output: frame => { window.__testDecodedFrames++; init.output(frame); } }); } };
      }
    });
    await controllerContext.addInitScript(() => {
      window.__testControllerSockets = [];
      const OriginalSocket = WebSocket;
      window.WebSocket = class extends OriginalSocket { constructor(...args) { super(...args); window.__testControllerSockets.push(this); } };
      window.__testAudioContexts = 0;
      if (window.AudioContext) { const Original = AudioContext; window.AudioContext = class extends Original { constructor(...args) { super(...args); window.__testAudioContexts++; } }; }
      const getter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')?.get;
      Object.defineProperty(document, 'hidden', { get: () => window.__testHidden ?? getter?.call(document) ?? false });
    });
    const invitation = await broker.invite('local', { keyboard: true, pointerButtons: variant.pointerButtons !== false, textFocus: true });
    picture = await pictureContext.newPage(); picture.setDefaultTimeout(7000); picture.on('pageerror', e => errors.push(e.message));
    await picture.goto(browserJoinUrl(invitation.url, invitation.key));
    await until(() => picture.locator('#status').textContent().then(text => text === 'Streaming'), 'initial generated picture');
    await picture.getByRole('button', { name: 'Options', exact: true }).click();
    await picture.getByRole('button', { name: 'Use phone as touchpad and keyboard', exact: true }).click();
    await picture.locator('#presentation-method').selectOption('app-cast');
    await picture.getByRole('button', { name: 'Create controller link', exact: true }).click();
    await picture.getByRole('button', { name: 'Copy controller link', exact: true }).click();
    const link = await picture.evaluate(() => window.__testControllerLink);
    assert.match(link, /#controller=[A-Za-z0-9_-]{43}$/);
    await picture.locator('#presentation-background').check();
    await picture.getByRole('button', { name: 'Done', exact: true }).click();
    await until(() => picture.evaluate(() => document.activeElement.id === 'more'), 'dialog close-event focus restoration');
    assert.equal(await picture.evaluate(() => document.activeElement.id), 'more', 'setup restores focus to visible controls');
    controller = await controllerContext.newPage(); controller.setDefaultTimeout(7000); controller.on('pageerror', e => errors.push(e.message));
    await controller.goto(link); await controller.bringToFront();
    await until(() => controller.locator('#controller-status').textContent().then(text => text === 'Controller connected'), 'authorized controller');
    assert.equal(new URL(controller.url()).hash, '');
    if (variant.rtl) await controller.evaluate(() => document.documentElement.dir = 'rtl');
    if (variant.zoom) await controller.evaluate(zoom => document.body.style.zoom = String(zoom), variant.zoom);
    await controller.locator('#controller-pad').click(); await until(() => pointerDowns === 1, 'one balanced controller tap');
    await until(() => held.size === 0, 'tap released');
    if (variant.pointerButtons === false) {
      assert.equal(await controller.getByRole('button',{name:'Secondary click',exact:true}).isDisabled(),true);
      assert.match(await controller.locator('#controller-secondary-help').textContent(),/unavailable/);
      assert.equal(inputs.some(packet=>packet[0]===11),false);
    } else {
      await controller.getByRole('button', {name:'Secondary click',exact:true}).click();
      await until(() => inputs.filter(packet=>packet[0]===11).length===1,'one explicit secondary click');
      const secondary=inputs.find(packet=>packet[0]===11);
      assert.equal(secondary.length,14); assert.equal(secondary[1],0);
      assert.equal(secondary.readUInt16BE(10),640); assert.equal(secondary.readUInt16BE(12),360);
      assert.ok(secondary.readUInt32BE(2)<640 && secondary.readUInt32BE(6)<360 && held.size===0);
    }
    if (engine === 'chromium') {
      const box = await controller.locator('#controller-pad').boundingBox(), cdp = await controllerContext.newCDPSession(controller), before = scrolls;
      const points = offset => [{ id: 1, x: box.x + box.width * .4, y: box.y + box.height * .4 + offset }, { id: 2, x: box.x + box.width * .6, y: box.y + box.height * .4 + offset }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(0) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(20) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await until(() => scrolls > before, 'actual Chromium two-finger scroll'); await cdp.detach();
    }
    await controller.getByRole('button', { name: 'Start drag', exact: true }).click(); await until(() => held.has('mouse'), 'held drag');
    await controller.getByRole('button', { name: 'Keyboard', exact: true }).click(); await until(() => held.size === 0, 'keyboard cancels drag');
    await controller.locator('#controller-input').fill('café 😊'); await until(() => typed === 'café 😊', 'committed Unicode through existing helper');
    assert.equal(await controller.locator('#controller-input').inputValue(), 'café 😊');
    if (variant.width > variant.height) await controller.setViewportSize({ width: variant.width, height: 220 });
    await until(async () => {
      const rect = await controller.locator('#controller-input').boundingBox();
      return rect && rect.y >= 0 && rect.y + rect.height <= controller.viewportSize().height;
    }, 'typing field above simulated keyboard');
    const closeRect = await controller.getByRole('button', { name: 'Close keyboard', exact: true }).boundingBox();
    assert.ok(closeRect.y >= 0 && closeRect.y + closeRect.height <= controller.viewportSize().height, 'close stays reachable');
    await controller.screenshot({ path: path.join(output, `controller-${variant.width}-${Boolean(variant.rtl)}-${variant.zoom || 1}${variant.pointerButtons === false ? '-old-host' : ''}.png`), fullPage: true });
    await controller.getByRole('button', { name: 'Close keyboard', exact: true }).click();
    if (variant.width > variant.height) await controller.setViewportSize({ width: variant.width, height: variant.height });
    await controller.locator('#controller-pad').focus();
    for (const id of ['controller-keyboard', 'controller-click', ...(variant.pointerButtons === false ? [] : ['controller-secondary']), 'controller-drag', null]) {
      await controller.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab');
      const focused = await controller.evaluate(() => ({ id: document.activeElement.id, tag: document.activeElement.tagName,
        outline: getComputedStyle(document.activeElement).outlineStyle, width: parseFloat(getComputedStyle(document.activeElement).outlineWidth) }));
      if (id) assert.equal(focused.id, id); else assert.equal(focused.tag, 'SUMMARY');
      assert.ok(focused.outline !== 'none' && focused.width > 0, 'visible keyboard focus');
    }
    await controller.keyboard.press('Space');
    const range = controller.locator('#controller-pointer-speed'); await range.focus(); await range.press('End');
    assert.equal(await range.inputValue(), '4'); await range.press('Home'); assert.equal(await range.inputValue(), '0.25');
    await range.evaluate(el => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await controller.locator('#controller-shortcut-key').selectOption('KeyA');
    await controller.locator('[data-modifier="8"]').check(); await controller.getByRole('button', { name: 'Send shortcut', exact: true }).click();
    await until(() => inputs.some(packet => packet[0] === 8 && packet[1] === 0 && packet.readUInt16BE(2) === 4 && packet[4] === 8), 'explicit Command/Meta shortcut');
    await controller.locator('[data-modifier="8"]').uncheck();
    await controller.locator('#controller-auto-keyboard').check();
    bridge.focusHint(true); assert.equal(await controller.locator('#controller-typing').isVisible(), false, 'focus hint does not steal Options focus');
    await controller.locator('#controller-options > summary').click();
    await new Promise(resolve => setTimeout(resolve, 120)); bridge.focusHint(true);
    await controller.locator('#controller-typing').waitFor({ state: 'visible' });
    const beforeSuggestion = typed; await controller.locator('#controller-input').fill('germ');
    await until(() => typed === beforeSuggestion + 'germ', 'partial word');
    await new Promise(resolve => setTimeout(resolve, 120)); bridge.focusHint(true);
    await controller.locator('#controller-input').fill('German');
    await until(() => typed === beforeSuggestion + 'German', 'single suggestion replacement after repeated focus hint');
    await controller.getByRole('button', { name: 'Close keyboard', exact: true }).click();
    await controller.getByRole('button', { name: 'Start drag', exact: true }).click(); await until(() => held.has('mouse'), 'drag before background');
    const beforeAway = acks, beforeDecodedAway = await decodedFrames(picture);
    await controller.evaluate(() => { window.__testHidden = true; document.dispatchEvent(new Event('visibilitychange')); });
    await until(() => held.size === 0, 'background releases input');
    await until(() => acks > beforeAway + 1, 'presentation continues while controller is hidden');
    await until(async () => await decodedFrames(picture) > beforeDecodedAway + 1, 'decoded presentation continues while controller is hidden');
    await controller.evaluate(() => { window.__testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
    await controller.bringToFront();
    await until(() => controller.locator('#controller-status').textContent().then(text => text === 'Controller connected'), 'controller returns');
    await controller.reload(); await controller.bringToFront();
    await until(() => controller.locator('#controller-status').textContent().then(text => text === 'Controller connected'), 'cookie-only controller reload');
    assert.equal(await controller.locator('#controller-pointer-speed').inputValue(), '2');
    assert.equal(nativeCalls, 1); assert.equal(await controller.locator('video,audio,canvas').count(), 0);
    assert.equal(await controller.evaluate(() => window.__testAudioContexts), 0, 'controller creates no duplicate audio player');
    await controller.locator('#controller-options').evaluate(el => el.open = true);
    await confirmReceiverAction(controller, { name: 'End presentation', accept: false });
    assert.equal(broker.status().connected, true); assert.equal(native.destroyed, false);
    await confirmReceiverAction(controller, { name: 'End presentation' });
    await until(() => controller.locator('#controller-status').textContent().then(text => text.startsWith('Presentation ended')), 'separate End presentation');
    assert.equal(broker.status().controllerConnected, true); assert.equal(await bridge.restartNative(), false);
    const beforeStatusRecovery = inputs.length;
    const socketsBefore = await controller.evaluate(() => window.__testControllerSockets.length);
    await controller.evaluate(() => window.__testControllerSockets.at(-1).close(4001, 'Owned transient status-page socket loss'));
    await until(async () => await controller.evaluate(() => window.__testControllerSockets.length) > socketsBefore
      && broker.status().controllerConnected
      && await controller.locator('#controller-status').textContent().then(text => text.startsWith('Presentation ended')),
    'ended presentation retains cookie-only controller status recovery');
    assert.equal(nativeCalls,1,'status recovery cannot launch another capture');
    assert.equal(await bridge.restartNative(),false,'status recovery cannot restart an ended presentation');
    assert.equal(await controller.getByRole('button',{name:'Keyboard',exact:true}).isDisabled(),true);
    assert.equal(await controller.getByRole('button',{name:'Click',exact:true}).isDisabled(),true);
    // Detach/attach intentionally release old input. Permit only those cleanup
    // messages; status recovery must not deliver a fresh press, move or text.
    const freshInput=inputs.slice(beforeStatusRecovery).filter(packet=>[3,7,8,9,10,11].includes(packet[0])
      && !(packet[0]===3&&packet[1]===3) && !(packet[0]===8&&packet[1]===2));
    assert.deepEqual(freshInput.map(packet=>packet.toString('hex')),[],'status-only recovery delivers cleanup only, never fresh input');
    await confirmReceiverAction(controller, { name: 'Stop sharing' });
    await until(() => !broker.status().connected && native.destroyed, 'explicit whole-session Stop');
    assert.equal(held.size, 0); assert.deepEqual(errors, []);
    results.push({ ...variant, generatedVideo: true, independentBrowserContexts: true, roleFragmentCleared: true,
      tapAndDrag: true, twoFingerScroll: engine === 'chromium' ? 'actual Chromium touch input' : 'not exercised in WebKit', committedUnicode: true, keyboardOpenLayout: true,
      keyboardFocusVisible: true, nativeFocusTraversal: engine === 'webkit' ? 'Option+Tab' : 'Tab', pointerPreferenceKeyboardAndReload: true, explicitModifierShortcut: true, secondaryClickPacket: variant.pointerButtons !== false, oldHostSecondaryClickDenied: variant.pointerButtons === false,
      autoKeyboardWithoutOptionsFocusSteal: true, suggestionReplacementAfterRepeatedFocus: true, simulatedVisibilityLifecycle: true,
      presentationContinued: true, controllerReload: true, noControllerMediaOrAudioContext: true,
      cancelEndPreservedSession: true, separateEndPresentation: true, endedControllerStatusRecovery: true, confirmedStop: true,
      nativeCalls, generatedFrames: frames, generatedAcks: acks, physicalDevice: false, castingQualified: false });
  } catch (error) {
    await writeFile(path.join(output, 'failure.json'), JSON.stringify({ variant, error: String(error.message).replace(/#controller=[A-Za-z0-9_-]+/g, '#controller=[redacted]'), errors,
      state: controller ? await controller.evaluate(() => ({ status: document.querySelector('#controller-status')?.textContent, error: document.querySelector('#controller-error')?.textContent })).catch(() => null) : null }, null, 2));
    if (controller) await controller.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw Error(String(error.message).replace(/#(?:controller|connect)=[A-Za-z0-9_-]+/g, '#invitation=[redacted]'));
  } finally { await pictureContext.close(); await controllerContext.close(); native?.destroy(); await broker.shutdown(); }
 }
 pass = true; console.log(`${engine}: ${results.length} dual-context presentation/controller flows pass.`);
} finally { await browser.close(); await writeFile(path.join(output, 'results.json'), JSON.stringify({ status: pass ? 'passed' : 'failed', engine, physicalDevice: false, castingQualified: false, results }, null, 2)); }
