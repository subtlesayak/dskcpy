import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { WebSocket } from 'ws';
import { createBrowserReceiver } from './browser.mjs';
import { touchPacket, scrollPacket, secondaryClickPacket, ack, controllerJoinUrl, parseControllerFragment } from '../receiver/protocol.mjs';
import { clipboardRequest } from '../receiver/clipboard.mjs';

const header = Buffer.from('535244310000000100000280000001e0', 'hex');
const releaseKeys = Buffer.from([8, 2, 0, 0, 0]);
function media(pts, flags, bytes = [1, 2, 3]) {
  const data = Buffer.alloc(16 + bytes.length);
  data.writeUInt32BE(bytes.length); data.writeBigUInt64BE(BigInt(pts), 4); data.writeUInt32BE(flags, 12);
  Buffer.from(bytes).copy(data, 16); return data;
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected isolated presentation transition did not occur');
}
const texts = ws => ws.received.filter(m => !m.binary).map(m => JSON.parse(m.data));
async function fixture(t, options = {}) {
  let native, bridge, calls = 0;
  const chunks = [], clients = new Set();
  const receiver = createBrowserReceiver({ configuredPort: 0, presentationControl: true,
    onConnect: async value => {
      calls++; bridge = value; native = net.connect(value.port, '127.0.0.1');
      native.on('error', () => {}); native.on('data', data => chunks.push(data));
      await once(native, 'connect'); native.write(header);
    }, ...options });
  t.after(async () => { for (const ws of clients) ws.terminate(); native?.destroy(); await receiver.shutdown(); });
  const invitation = await receiver.invite('local', options.policy || { keyboard: true, clipboard: true, textFocus: true });
  const origin = invitation.url.slice(0, -1);
  async function open(route = 'stream', cookie) {
    const ws = new WebSocket(invitation.url.replace('http:', 'ws:') + route, { origin, headers: cookie ? { Cookie: cookie } : {} });
    clients.add(ws); ws.received = []; ws.on('error', () => {});
    ws.on('upgrade', response => { ws.cookie = response.headers['set-cookie']?.[0]; });
    ws.on('message', (data, binary) => ws.received.push({ data, binary }));
    await once(ws, 'open'); return ws;
  }
  const presentation = await open(options.webrtc ? 'stream/webrtc' : 'stream'); presentation.send(invitation.key);
  await until(() => presentation.received.some(m => m.binary));
  presentation.send('resume');
  const cookie = presentation.cookie.split(';')[0];
  async function post(route, authorization = cookie, value = { action: 'create' }, extra = {}) {
    return fetch(invitation.url + route, { method: 'POST', headers: { Cookie: authorization,
      Origin: origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });
  }
  async function mint() {
    // A ping orders the presentation's resume ahead of this HTTP request.
    presentation.ping(); await once(presentation, 'pong');
    const response = await post('stream/controller/invite'); assert.equal(response.status, 201);
    return response.json();
  }
  async function pair() {
    const ticket = await mint(), ws = await open('stream/controller');
    ws.send(ticket.key); await until(() => texts(ws).some(m => m.type === 'controller-authenticated'));
    return { ws, ticket, cookie: ws.cookie.split(';')[0] };
  }
  async function controllerStatus(authorization) {
    return (await fetch(invitation.url + 'stream/controller/session', { headers: { Cookie: authorization } })).json();
  }
  async function rejected(route, authorization) {
    const ws = new WebSocket(invitation.url.replace('http:', 'ws:') + route, { origin, headers: { Cookie: authorization } });
    clients.add(ws); ws.on('error', () => {});
    return new Promise(resolve => { ws.once('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); }); });
  }
  return { receiver, presentation, cookie, origin, invitation, open, post, mint, pair, controllerStatus, rejected,
    native: () => native, bridge: () => bridge, calls: () => calls, bytes: () => Buffer.concat(chunks),
    clear: () => { chunks.length = 0; } };
}

test('secondary click belongs to the sole negotiated input owner and is denied on older hosts', async t => {
  const f = await fixture(t, { policy: {keyboard:true,pointerButtons:true} });
  assert.equal(texts(f.presentation)[0].pointerButtons, true); assert.equal(f.bridge().pointerButtons,true);
  const control = await f.pair(); assert.equal(texts(control.ws)[0].pointerButtons,true);
  control.ws.send('resume'); control.ws.ping(); await once(control.ws,'pong');
  const packet=Buffer.from(secondaryClickPacket(100,200,640,480));
  f.clear(); f.presentation.send(packet); f.presentation.ping(); await once(f.presentation,'pong');
  assert.equal(f.bytes().includes(packet),false);
  control.ws.send(packet); await until(()=>f.bytes().includes(packet));
  control.ws.send('suspend'); control.ws.ping(); await once(control.ws,'pong'); f.clear();
  control.ws.send(packet); control.ws.ping(); await once(control.ws,'pong'); assert.equal(f.bytes().includes(packet),false);
  const old=await fixture(t); assert.equal(old.bridge().pointerButtons,false);
  const denied=await old.pair(); assert.equal(texts(denied.ws)[0].pointerButtons,false);
  denied.ws.send('resume'); denied.ws.ping(); await once(denied.ws,'pong'); old.clear();
  const closed=once(denied.ws,'close'); denied.ws.send(packet); await closed;
  assert.equal(old.presentation.readyState,WebSocket.OPEN); assert.equal(old.bytes().includes(packet),false);
  const window=await fixture(t,{policy:{viewOnly:true,keyboard:true,pointerButtons:true}});
  assert.equal(texts(window.presentation)[0].pointerButtons,false); assert.equal(window.bridge().pointerButtons,false);
});

test('controller creation is opt-in, same-origin, explicit and full-desktop only', async t => {
  const defaults = await fixture(t, { presentationControl: false });
  assert.equal((await defaults.post('stream/controller/invite')).status, 404);
  assert.equal(texts(defaults.presentation)[0].presentationControl, undefined);
  const viewOnly = await fixture(t, { policy: { viewOnly: true, keyboard: true } });
  assert.equal((await viewOnly.post('stream/controller/invite')).status, 403);
  const disallowed = await fixture(t, { policy: { keyboard: true, presentationControl: false } });
  assert.equal((await disallowed.post('stream/controller/invite')).status, 403);
  const f = await fixture(t);
  assert.equal((await f.post('stream/controller/invite', '')).status, 403);
  assert.equal((await f.post('stream/controller/invite', f.cookie, {}, { Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.post('stream/controller/invite', f.cookie, {})).status, 400);
  assert.equal((await f.post('stream/controller/invite', f.cookie, { action: 'create', keyboard: true })).status, 400);
  assert.equal(f.receiver.status().presentation, false);
});

test('pairing transfers input once, while only the presentation receives media', async t => {
  const f = await fixture(t);
  const held = Buffer.from(touchPacket(0, 0, 10, 10, 640, 480));
  f.presentation.send(held); await until(() => f.bytes().includes(held)); f.clear();
  const c = await f.pair();
  await until(() => f.bytes().includes(releaseKeys));
  assert.equal(f.receiver.status().presentation, true); assert.equal(f.calls(), 1);
  assert.equal(c.ws.cookie.includes('HttpOnly; SameSite=Strict; Path=/stream/controller;'), true);
  assert.equal(c.ws.cookie.includes('dskcpy_resume_'), false);
  const point = Buffer.from(touchPacket(0, 1, 123, 234, 640, 480));
  f.clear(); f.presentation.send(point); f.presentation.send(Buffer.from([5, 9]));
  await until(() => f.bytes().includes(Buffer.from([5, 9])));
  assert.equal(f.bytes().includes(point), false, 'old combined input epoch cannot keep control');
  c.ws.send('resume'); c.ws.send(point); await until(() => f.bytes().includes(point));
  const frame = media(1, 2), sound = media(2, 8);
  f.native().write(frame); f.native().write(sound);
  await until(() => f.presentation.received.some(m => m.binary && m.data.equals(sound)));
  assert.equal(c.ws.received.some(m => m.binary), false, 'controller gets no media or native header');
  f.presentation.send(ack(4, 1)); f.presentation.send(ack(6, 2));
  await until(() => f.bytes().includes(Buffer.from(ack(6, 2))));
  assert.equal(f.presentation.readyState, WebSocket.OPEN);
  assert.equal(texts(c.ws).find(m => m.type === 'controller-authenticated').role, 'controller');
});

test('controller background and transport loss release input without pausing presentation', async t => {
  const f = await fixture(t), c = await f.pair(); c.ws.send('resume');
  const point = Buffer.from(touchPacket(0, 2, 55, 66, 640, 480));
  c.ws.send(point); c.ws.send(Buffer.from([8, 0, 0, 224, 1])); await until(() => f.bytes().includes(point)); f.clear();
  c.ws.send('suspend'); await until(() => f.bytes().includes(releaseKeys));
  assert.equal(f.bytes().includes(Buffer.from([5, 7])), false, 'controller suspension never sends native media pause');
  const hidden = Buffer.from(touchPacket(0, 3, 77, 88, 640, 480));
  c.ws.send(hidden); c.ws.ping(); await once(c.ws, 'pong'); assert.equal(f.bytes().includes(hidden), false);
  const frame = media(3, 2); f.native().write(frame);
  await until(() => f.presentation.received.some(m => m.binary && m.data.equals(frame)));
  f.presentation.send(ack(4, 3));
  c.ws.send('resume'); c.ws.send(hidden); await until(() => f.bytes().includes(hidden)); f.clear();
  const lost = once(c.ws, 'close'); c.ws.terminate(); await lost;
  await until(() => !f.receiver.status().controllerConnected && f.bytes().includes(releaseKeys));
  assert.equal(f.bytes().includes(Buffer.from([5, 7])), false);
  assert.equal((await f.controllerStatus(c.cookie)).resumable, true);
  const again = await f.open('stream/controller', c.cookie);
  await until(() => texts(again).some(m => m.type === 'controller-authenticated'));
  again.send('resume'); again.send(hidden); await until(() => f.bytes().includes(hidden));
  assert.equal(f.calls(), 1); assert.equal(f.presentation.readyState, WebSocket.OPEN);
});

test('controller grant is role-bound, provisional, one-use and cannot silently replace another owner', async t => {
  const f = await fixture(t), ticket = await f.mint(), pending = await f.open('stream/controller');
  const provisional = pending.cookie.split(';')[0];
  assert.equal((await f.controllerStatus(provisional)).resumable, false);
  pending.send(ticket.key); await until(() => texts(pending).some(m => m.type === 'controller-authenticated'));
  assert.equal((await f.controllerStatus(provisional)).resumable, true);
  assert.equal((await f.controllerStatus(f.cookie)).resumable, false);
  const primary = await fetch(f.invitation.url + 'stream/session', { headers: { Cookie: provisional } });
  assert.equal((await primary.json()).resumable, false);
  assert.equal(await f.rejected('stream/controller', provisional), 403, 'a second controller cannot kick the active owner');
  assert.equal((await f.post('stream/controller/invite')).status, 409);
  assert.equal((await f.post('stream/controller/leave', provisional, {}, { Origin: 'https://untrusted.invalid' })).status, 403);
  const lost = once(pending, 'close'); pending.terminate(); await lost;
  await until(() => !f.receiver.status().controllerConnected);
  assert.equal(await f.rejected('stream/controller', ''), 403, 'used invitation cannot create a fresh role');
  assert.equal(f.presentation.readyState, WebSocket.OPEN);
});

test('controller media ACKs, playback controls and RTC messages revoke only that controller', async t => {
  for (const invalid of [ack(4, 1), Buffer.from([5, 7]), JSON.stringify({ type: 'rtc-answer', description: {} })]) {
    const f = await fixture(t), c = await f.pair(); c.ws.send('resume');
    const ended = once(c.ws, 'close'); c.ws.send(invalid); const [code] = await ended;
    assert.equal(code, 1008); assert.equal(f.presentation.readyState, WebSocket.OPEN);
    assert.equal((await f.controllerStatus(c.cookie)).resumable, false);
    assert.equal(f.calls(), 1);
  }
});

test('controller focus and keyboard readiness metadata never leak into the presentation role', async t => {
  const f = await fixture(t), c = await f.pair(); c.ws.send('resume');
  c.ws.send('keyboard-status-subscribe'); c.ws.send('text-focus-subscribe');
  c.ws.ping(); await once(c.ws, 'pong');
  f.bridge().keyboardStatus('ready'); f.bridge().focusHint(true);
  await until(() => texts(c.ws).some(m => m.type === 'text-focus'));
  assert.equal(texts(f.presentation).some(m => ['text-focus', 'keyboard-status'].includes(m.type)), false);
  assert.equal(texts(c.ws).some(m => m.type === 'keyboard-status' && m.status === 'ready'), true);
});

test('leaving the controller preserves presentation; explicit controller Stop ends both roles', async t => {
  const f = await fixture(t), first = await f.pair();
  const left = once(first.ws, 'close');
  assert.equal((await f.post('stream/controller/leave', first.cookie, {})).status, 204); await left;
  assert.equal((await f.controllerStatus(first.cookie)).resumable, false);
  assert.equal(f.presentation.readyState, WebSocket.OPEN); assert.equal(f.receiver.status().connected, true);
  const second = await f.pair();
  const displayEnded = once(f.presentation, 'close'), controllerEnded = once(second.ws, 'close');
  assert.equal((await f.post('stream/controller/stop', second.cookie, {})).status, 204);
  await Promise.all([displayEnded, controllerEnded]);
  assert.equal(f.receiver.status().connected, false); assert.equal((await f.controllerStatus(second.cookie)).resumable, false);
  assert.equal(f.calls(), 1, 'Stop never starts a replacement capture');
});

test('unused controller invitation expiry and controller-away expiry leave media alive', async t => {
  const f = await fixture(t, { controllerInvitationMs: 50 });
  const ticket = await f.mint(); await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(await f.rejected('stream/controller', ''), 403);
  assert.equal(f.presentation.readyState, WebSocket.OPEN);
  const away = await fixture(t, { resumeMs: 120 });
  const c = await away.pair(); const lost = once(c.ws, 'close'); c.ws.terminate(); await lost;
  await until(() => !away.receiver.status().controllerConnected);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await away.controllerStatus(c.cookie)).resumable, false);
  assert.equal(away.presentation.readyState, WebSocket.OPEN); assert.equal(away.calls(), 1);
  assert.equal(ticket.role, 'controller');
});

test('presentation transport loss gates controller input until the same capture resumes', async t => {
  const f = await fixture(t), c = await f.pair(); c.ws.send('resume');
  const ended = once(f.presentation, 'close'); f.presentation.terminate(); await ended;
  await until(() => texts(c.ws).some(m => m.type === 'controller-state' && !m.presentationAvailable));
  f.clear(); const point = Buffer.from(scrollPacket(15, 20, 640, 480, 0, 10));
  c.ws.send(point); c.ws.ping(); await once(c.ws, 'pong'); assert.equal(f.bytes().includes(point), false);
  const display = await f.open('stream', f.cookie);
  await until(() => display.received.some(m => m.binary));
  assert.equal(texts(display).find(m => m.type === 'authenticated').role, 'presentation');
  assert.equal(texts(display).find(m => m.type === 'authenticated').viewOnly, false,
    'presentation input ownership must not turn full-desktop audio into window-only policy');
  display.send('resume'); display.send(Buffer.from([5, 8])); display.ping(); await once(display, 'pong');
  c.ws.send('resume'); c.ws.send(point); await until(() => f.bytes().includes(point));
  assert.equal(f.calls(), 1); assert.equal(c.ws.readyState, WebSocket.OPEN);
});

test('WebRTC offer, media clock and sender stay with presentation across controller background', async t => {
  const frames = [], sounds = []; let answers = 0, rtcClosed = 0;
  const f = await fixture(t, { webrtc: true, rtcMediaFactory: () => ({
    offer: async () => ({ type: 'offer', sdp: 'synthetic-owned-rtc' }), answer: async () => { answers++; },
    close: async () => { rtcClosed++; }, frame: async (...args) => frames.push(args), sound: async (...args) => sounds.push(args),
  }) });
  const c = await f.pair(); c.ws.send('resume');
  f.native().write(media(0, 1, Buffer.from('000000016742c01e0102030000000168ce3c80', 'hex')));
  await until(() => texts(f.presentation).some(m => m.type === 'rtc-offer'));
  assert.equal(texts(c.ws).some(m => m.type === 'rtc-offer'), false);
  f.presentation.send(JSON.stringify({ type: 'rtc-answer', description: { type: 'answer', sdp: 'owned-fake' } }));
  await until(() => answers === 1);
  c.ws.send('suspend'); c.ws.ping(); await once(c.ws, 'pong');
  f.native().write(media(50, 2)); f.native().write(media(60, 8));
  await until(() => frames.length === 1 && sounds.length === 1);
  assert.equal(frames[0][1], 50n); assert.equal(sounds[0][1], 60n);
  assert.equal(rtcClosed, 0); assert.equal(f.calls(), 1);
  assert.equal(c.ws.received.some(m => m.binary), false);
});

test('native recovery preserves controller grant but discards old input until fresh presentation resume', async t => {
  const f = await fixture(t, { policy: { keyboard: true, captureRecovery: true } }), c = await f.pair();
  c.ws.send('resume'); const oldInput = Buffer.from(touchPacket(0, 4, 22, 33, 640, 480));
  c.ws.send(oldInput); await until(() => f.bytes().includes(oldInput));
  const stopped = once(f.presentation, 'close'); await f.bridge().restartNative(); await stopped;
  await until(() => !f.receiver.status().recovering); f.clear();
  c.ws.send(oldInput); c.ws.ping(); await once(c.ws, 'pong');
  assert.equal(f.bytes().includes(oldInput), false);
  assert.equal(c.ws.readyState, WebSocket.OPEN);
  assert.equal((await f.controllerStatus(c.cookie)).resumable, true);
  const display = await f.open('stream', f.cookie); await until(() => display.received.some(m => m.binary));
  display.send('resume'); display.send(Buffer.from([5, 8])); display.ping(); await once(display, 'pong');
  c.ws.send('resume'); c.ws.send(oldInput); await until(() => f.bytes().includes(oldInput));
  assert.equal(f.calls(), 2, 'only the explicitly requested native recovery starts another capture');
});

test('wrong controller keys are bounded independently and cannot stop or authenticate the presentation', async t => {
  const f = await fixture(t), ticket = await f.mint();
  for (let i = 0; i < 10; i++) {
    const ws = await f.open('stream/controller'), ended = once(ws, 'close');
    ws.send('A'.repeat(43)); const [code] = await ended; assert.equal(code, 1008);
    assert.equal((await f.controllerStatus(ws.cookie.split(';')[0])).resumable, false);
  }
  assert.equal(await f.rejected('stream/controller', ''), 403);
  assert.equal(f.presentation.readyState, WebSocket.OPEN); assert.equal(f.calls(), 1);
  assert.equal(f.receiver.status().connected, true); assert.equal(ticket.role, 'controller');
});

test('controller mint cannot outlive synchronous owner cancellation during the role transition', async t => {
  let f, cancelOnTransition = false;
  f = await fixture(t, { onChange: () => {
    if (cancelOnTransition) { cancelOnTransition = false; f.receiver.cancel(); }
  } });
  cancelOnTransition = true;
  assert.equal((await f.post('stream/controller/invite')).status, 403);
  assert.equal(f.receiver.status().connected, false);
  assert.equal((await f.controllerStatus('')).resumable, false);
});

test('clipboard transfer cancels old work and requires a new controller opt-in', async t => {
  const f = await fixture(t);
  const reply = (id, text) => {
    const bytes = Buffer.from(text), payload = Buffer.alloc(8 + bytes.length);
    payload.writeUInt32BE(id, 2); payload.writeUInt16BE(bytes.length, 6); bytes.copy(payload, 8);
    return media(0, 32, payload);
  };
  f.presentation.send('clipboard-enable'); f.presentation.send(clipboardRequest(0, 1));
  await until(() => f.bytes().includes(Buffer.from(clipboardRequest(0, 1))));
  const c = await f.pair();
  await until(() => f.bytes().includes(Buffer.from([10, 3, 0, 0, 0, 0, 0, 0])));
  f.native().write(reply(1, 'old-owned-fixture')); const fence = media(71, 2); f.native().write(fence);
  await until(() => f.presentation.received.some(m => m.binary && m.data.equals(fence)));
  assert.equal(texts(c.ws).some(m => m.type === 'clipboard-result'), false);
  assert.equal(texts(f.presentation).some(m => m.type === 'clipboard-result'), false);
  c.ws.send('resume'); c.ws.send('clipboard-enable'); c.ws.send(clipboardRequest(0, 1));
  await until(() => f.bytes().includes(Buffer.from(clipboardRequest(0, 2))));
  f.native().write(reply(2, 'new-owned-fixture'));
  await until(() => texts(c.ws).some(m => m.type === 'clipboard-result'));
  assert.equal(texts(c.ws).find(m => m.type === 'clipboard-result').text, 'new-owned-fixture');
  assert.equal(texts(f.presentation).some(m => m.type === 'clipboard-result'), false);

  const denied = await fixture(t), noConsent = await denied.pair(); denied.clear();
  noConsent.ws.send('resume'); const ended = once(noConsent.ws, 'close'); noConsent.ws.send(clipboardRequest(0, 1));
  const [code] = await ended; assert.equal(code, 1008);
  assert.equal(denied.bytes().includes(Buffer.from(clipboardRequest(0, 1))), false);
  assert.equal(denied.presentation.readyState, WebSocket.OPEN);
});

test('End presentation revokes only the picture role and cannot silently restart capture', async t => {
  for (const fromController of [false, true]) {
    const f = await fixture(t, { policy: { keyboard: true, captureRecovery: true } }), c = await f.pair(); c.ws.send('resume');
    const ended = once(f.presentation, 'close');
    const response = await f.post(fromController ? 'stream/controller/end-presentation' : 'stream/presentation/end', fromController ? c.cookie : f.cookie, {});
    assert.ok(response.ok); await ended;
    await until(() => texts(c.ws).some(m => m.type === 'controller-state' && m.presentationEnded));
    assert.equal(c.ws.readyState, WebSocket.OPEN); assert.equal((await f.controllerStatus(c.cookie)).resumable, true);
    assert.equal(f.receiver.status().presentationEnded,true,'host status must distinguish End from active presentation');
    assert.equal(f.receiver.status().presentationAvailable,false);
    assert.equal(f.receiver.status().controllerActive,false);
    for (const token of [f.cookie, f.cookie.split('=')[0] + '=' + 'A'.repeat(43)]) {
      const status = await fetch(f.invitation.url + 'stream/session', { headers: { Cookie: token } });
      assert.equal((await status.json()).resumable, false, 'neither old nor zeroed cookie may restore presentation');
    }
    assert.equal(await f.bridge().restartNative(), false); assert.equal(f.calls(), 1);
    assert.equal(f.receiver.status().connected, true, 'controller still has the separate Stop action');
    assert.equal((await f.post('stream/controller/stop', c.cookie, {})).status, 204);
    assert.equal(f.receiver.status().connected, false);
  }
});

test('ended presentation status reconnect cannot restore input, renew expiry or replay a grant', async t => {
  // Shortened only for this actual expiry test; ordinary fixtures retain the
  // normal recovery budget. Reattach immediately, then await server retirement.
  const f=await fixture(t,{resumeMs:1000,policy:{keyboard:true,captureRecovery:true}}),c=await f.pair();
  c.ws.send('resume'); c.ws.ping(); await once(c.ws,'pong');
  const ended=await f.post('stream/controller/end-presentation',c.cookie,{});
  assert.equal(ended.status,200); assert.deepEqual(await ended.json(),{ended:true});
  await until(()=>texts(c.ws).some(m=>m.type==='controller-state'&&m.presentationEnded));
  const lost=once(c.ws,'close'); c.ws.close(4001,'Owned transient status loss'); await lost;
  const restored=await f.open('stream/controller',c.cookie);
  await until(()=>texts(restored).some(m=>m.type==='controller-authenticated'));
  const state=texts(restored).find(m=>m.type==='controller-authenticated');
  assert.equal(state.presentationEnded,true); assert.equal(state.presentationAvailable,false); assert.equal(state.controllerActive,false);
  const input=Buffer.from(touchPacket(0,9,432,321,640,480)); f.clear();
  restored.send('resume'); restored.send(input); restored.ping(); await once(restored,'pong');
  assert.equal(f.bytes().includes(input),false); assert.equal(await f.bridge().restartNative(),false); assert.equal(f.calls(),1);
  await once(restored,'close',{signal:AbortSignal.timeout(3000)});
  assert.equal(f.receiver.status().connected,false); assert.equal(f.calls(),1);
  assert.equal((await f.controllerStatus(c.cookie)).resumable,false);
  assert.equal(await f.rejected('stream/controller',c.cookie),403);
});

test('controller navigation uses an independent public path and a strict role fragment', () => {
  const key = 'x'.repeat(43), url = new URL(controllerJoinUrl('https://receiver.test/', key));
  assert.match(url.pathname, /^\/controller\/[a-f0-9]{32}$/); assert.equal(url.search, '');
  assert.equal(parseControllerFragment(url.hash), key);
  assert.equal(parseControllerFragment('#connect=' + key), null);
  assert.equal(parseControllerFragment('#controller=' + key + '&extra=1'), null);
  assert.equal(parseControllerFragment('#controller=' + 'x'.repeat(32)), null);
  for (const address of ['http://receiver.test/', 'https://user@receiver.test/', 'https://receiver.test/path', 'https://receiver.test/?code=value'])
    assert.throws(() => controllerJoinUrl(address, key));
});
