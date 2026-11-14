// Actual browser codecs/RTC with synthetic lavfi media and a fake native input
// collector. Never starts the real host, reads capture devices or sends OS input.
import { chromium, webkit } from 'playwright';
import { createBrowserReceiver } from '../../gui/server/browser.mjs';
import { createRtcMedia } from '../../gui/server/browser-rtc.mjs';
import { validBrowserInput } from '../../gui/server/browser-protocol.mjs';
import { generateMediaFixture, mediaPacket } from './media-fixture.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const engine = process.argv[2] || 'webkit';
assert.ok(['webkit', 'chromium'].includes(engine), 'Choose webkit or chromium');
const transport = process.argv[3] || 'webrtc';
assert.ok(['webrtc', 'webcodecs', 'fallback', 'auto', 'native-only', 'connected-fallback', 'adaptive', 'codec-update'].includes(transport), 'Choose a supported generated-media test transport');
const output = path.resolve(`desktop/out/browser-media-${engine}-${transport}`); await mkdir(output, { recursive: true });
const fixture = await generateMediaFixture({outOfBandParameters:transport==='codec-update',retainSps:transport==='codec-update'});
const replacement = transport==='codec-update' ? await generateMediaFixture({replacement:true,outOfBandParameters:true}) : null;
let activeFixture=fixture;
const browser = await ({ chromium, webkit })[engine].launch(engine === 'chromium'
  ? { headless: true, channel: 'chromium', args: ['--disable-gpu'] } : { headless: true });
const until = async (condition, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(r => setTimeout(r, 25)); }
  throw Error(`Synthetic browser transition missing: ${label}`);
};
let native, pending = Buffer.alloc(0), videoTimer, audioTimer, audioEnabled = false, paused = false;
let frameIndex = 0, videoTick = 0, audioTick = 0, audioSent = 0;
const inputs = [], heldKeys = new Set(), touches = new Set(), errors = [];
const sourcePendingVideo = new Set(), sourcePendingAudio = new Set();
const counts = { videoAcks: 0, audioAcks: 0, pointer: 0, scroll: 0, keyboard: 0, text: 0, answers: 0, answerErrors: 0, rtcConnected: 0, sentFrames: 0, nativeConnections: 0 };
const brokerModes = [];
let injectRtcFailure;
const adaptiveCommands = [];
const stopSource = () => { clearInterval(videoTimer); clearInterval(audioTimer); };
const receiver = createBrowserReceiver({ configuredPort: 0, onChange: () => brokerModes.push(receiver.status().mediaMode), rtcMediaFactory: options => {
  const m = createRtcMedia({ ...options, ...(process.env.DSKCPY_TEST_MEDIA_BIND ? {bind: process.env.DSKCPY_TEST_MEDIA_BIND} : {}), onConnected: () => { counts.rtcConnected++; options.onConnected?.(); } });
  injectRtcFailure = async () => { const cleanup = m.close(); options.onFailure(Error('Owned synthetic RTC transport failure')); await cleanup; };
  const answer = m.answer, frame = m.frame;
  m.answer = async d => { counts.answers++; try { await answer(d); } catch(e) { counts.answerErrors++; throw e; } };
  m.frame = async (...args) => { const sent = await frame(...args); if (sent) counts.sentFrames++; return sent; };
  return m;
}, onConnect: async bridge => {
  counts.nativeConnections++;
  native = net.connect(bridge.port, '127.0.0.1'); native.on('error', () => {}); await once(native, 'connect');
  native.on('close', stopSource);
  native.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length) {
      const type = pending[0];
      const size = type === 3 ? 32 : type === 7 ? 21 : [4, 6].includes(type) ? 9 : type === 5 ? 2 : type === 8 ? 5
        : type === 9 && pending.length >= 3 ? 3 + pending.readUInt16BE(1) : 0;
      if (type === 9 && pending.length < 3) return;
      assert.ok(size, 'Unexpected fake-native packet'); if (pending.length < size) return;
      const packet = Buffer.from(pending.subarray(0, size)); pending = pending.subarray(size);
      const quality = transport === 'adaptive' && type === 5 && [12,13,14].includes(packet[1]);
      assert.ok(quality || validBrowserInput(packet, fixture.width, fixture.height, { keyboard: true }));
      if (quality) {
        adaptiveCommands.push(packet[1]);
        bridge.videoQuality({level:packet[1]-12,fps:packet[1]===14?15:packet[1]===13?30:60,bitRate:packet[1]===14?3600000:packet[1]===13?7200000:12000000});
      }
      if ([3, 7, 8, 9].includes(type)) { inputs.push(packet); assert.ok(inputs.length <= 1000); }
      if (type === 4) { counts.videoAcks++; const ack = Number(packet.readBigUInt64BE(1)); for (const pts of sourcePendingVideo) if (pts <= ack) sourcePendingVideo.delete(pts); }
      if (type === 6) { counts.audioAcks++; const ack = Number(packet.readBigUInt64BE(1)); for (const pts of sourcePendingAudio) if (pts <= ack) sourcePendingAudio.delete(pts); }
      if (type === 7) counts.scroll++;
      if (type === 3) { counts.pointer++; if (packet[1] === 0) touches.add(packet.readBigUInt64BE(2)); else if ([1, 3].includes(packet[1])) touches.clear(); }
      if (type === 8) {
        counts.keyboard++; const usage = packet.readUInt16BE(2);
        if (packet[1] === 0) heldKeys.add(usage); else if (packet[1] === 1) heldKeys.delete(usage); else heldKeys.clear();
      }
      if (type === 9) counts.text++;
      if (type === 5) {
        if (packet[1] === 7) paused = true;
        if (packet[1] === 8) { paused = false; frameIndex = 0; }
        if (packet[1] === 10) audioEnabled = true;
        if (packet[1] === 11) audioEnabled = false;
      }
    }
  });
  const header = Buffer.from('53524431000000010000028000000168', 'hex');
  native.write(header); native.write(mediaPacket(fixture.configuration, 0, 1));
  if (transport === 'adaptive') bridge.videoQuality({level:0,fps:60,bitRate:12000000});
  native.write(mediaPacket(fixture.sound.configuration, 0, 4));
  videoTimer = setInterval(() => {
    const pts = videoTick++ * 100000;
    if (paused || native.destroyed || native.writableLength > 65536 || sourcePendingVideo.size >= 2) return;
    const frame = activeFixture.frames[frameIndex++ % activeFixture.frames.length]; sourcePendingVideo.add(pts); native.write(mediaPacket(frame.payload, pts, frame.key ? 2 : 0));
  }, 100);
  audioTimer = setInterval(() => {
    const tick = audioTick++;
    if (!audioEnabled || paused || native.destroyed || native.writableLength > 65536 || sourcePendingAudio.size >= 4) return;
    sourcePendingAudio.add(tick * 10000); native.write(mediaPacket(fixture.sound.frames[tick % fixture.sound.frames.length], tick * 10000, 8)); audioSent++;
  }, 10);
} });
let page, context;
const currentMode = () => receiver.status().mediaMode;
const report = { engine, transport, forcedRtcFailure: ['fallback', 'connected-fallback'].includes(transport), faultKind: transport === 'connected-fallback' ? 'sender-failure-after-native-rtc' : transport === 'fallback' ? 'answer-rejection' : null, browserVersion: browser.version(), syntheticMedia: true, fakeNativeInput: true, physicalDevice: false,
  actualScreenCapture: false, audiblePlaybackQualified: false, encoder: fixture.encoder };
try {
  const invitation = await receiver.invite('local', { keyboard: true, adaptiveVideo: transport === 'adaptive' });
  context = await browser.newContext({ viewport: { width: 844, height: 600 }, hasTouch: true });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ transport }) => {
    window.__decoded = {video: 0, audio: 0};
    if (transport === 'native-only') { delete window.VideoDecoder; delete window.EncodedVideoChunk; }
    window.__testSockets = [];
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, { construct(Target, args) {
      const socket = new Target(...args), record = {route: new URL(args[0]).pathname, fallbackRequests: 0, codeMessages: 0};
      window.__sendOwnedFeedback = value => socket.send(JSON.stringify(value));
      window.__testSockets.push(record);
      const send = socket.send.bind(socket); socket.send = value => { if (value === 'media-fallback') record.fallbackRequests++; if (typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value)) record.codeMessages++; return send(value); };
      socket.addEventListener('message', e => { if (typeof e.data !== 'string') return; try { const value = JSON.parse(e.data); if (value.type === 'media-fallback') record.recoveryAcknowledged = value.mediaMode === 'webcodecs'; if (value.type === 'authenticated') Object.assign(record, {authenticated: true, mediaMode: value.mediaMode, mediaFallback: value.mediaFallback, negotiatedProtocol: socket.protocol}); } catch {} });
      socket.addEventListener('close', e => { record.closeCode = e.code; record.closeCategory = ['media-fallback','capture-ended','capture-recovery'].includes(e.reason) ? e.reason : 'other'; });
      return socket;
    } });
    if (!['webrtc', 'native-only'].includes(transport)) {
      if (['webcodecs','adaptive'].includes(transport)) delete window.RTCPeerConnection;
      for (const [name, kind] of [['VideoDecoder', 'video'], ['AudioDecoder', 'audio']]) {
        const Real = window[name];
        if (Real) window[name] = new Proxy(Real, { construct(Target, [options]) { return new Target({ ...options, output(frame) { window.__decoded[kind]++; options.output(frame); } }); } });
      }
      const Audio = window.AudioContext;
      window.AudioContext = new Proxy(Audio, { construct(Target, args) {
        const ac = new Target(...args), create = ac.createBufferSource.bind(ac), silent = ac.createGain();
        silent.gain.value = 0; silent.connect(ac.destination);
        ac.createBufferSource = () => { const source = create(), connect = source.connect.bind(source); source.connect = (destination, ...rest) => connect(destination === ac.destination ? silent : destination, ...rest); return source; };
        return ac;
      } });
      if (['webcodecs','adaptive'].includes(transport)) return;
    }
    const Real = window.RTCPeerConnection; window.__testPeers = [];
    window.RTCPeerConnection = new Proxy(Real, { construct(Target, args) { const pc = new Target(...args); if (transport === 'fallback') pc.createAnswer = async () => { throw new DOMException('Owned synthetic RTC failure', 'OperationError'); }; pc.__iceCounts = { candidates: 0, errors: [], protocols: [], states: [] }; pc.addEventListener('iceconnectionstatechange', () => pc.__iceCounts.states.push(pc.iceConnectionState)); pc.addEventListener('icecandidate', e => { if (e.candidate) { pc.__iceCounts.candidates++; pc.__iceCounts.protocols.push(e.candidate.protocol); pc.__iceCounts.candidateClass = {type: e.candidate.type, component: e.candidate.component, addressKind: e.candidate.address?.endsWith('.local') ? 'mdns' : e.candidate.address === '0.0.0.0' ? 'unspecified-v4' : e.candidate.address?.startsWith('127.') ? 'loopback-v4' : e.candidate.address?.includes(':') ? 'ipv6' : 'other-v4', portValid: e.candidate.port > 0 && e.candidate.port < 65536, standardPort: e.candidate.port === 9}; } }); pc.addEventListener('icecandidateerror', e => pc.__iceCounts.errors.push(e.errorCode)); window.__testPeers.push(pc); return pc; } });
    document.addEventListener('DOMContentLoaded', () => { document.getElementById('rtc-display').volume = 0; });
  }, { transport });
  await page.goto(invitation.url + '#connect=' + invitation.key);
  await page.locator('#stream-panel').waitFor({ state: 'visible' });
  const videoReady = () => currentMode() === 'webrtc'
    ? page.locator('#rtc-display').evaluate(v => v.videoWidth === 640 && v.videoHeight === 360 && v.currentTime > .3)
    : page.evaluate(() => window.__decoded.video >= 4);
  await until(videoReady, 'actual H.264 video pixels');
  if (transport === 'connected-fallback') {
    assert.equal(currentMode(), 'webrtc', 'healthy native RTC video is established before fault injection');
    await page.getByRole('button', { name: 'Audio off', exact: true }).click();
    await until(() => audioSent >= 5 && audioEnabled, 'audio before the owned RTC fault');
    await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
    await page.keyboard.down('Control'); await until(() => heldKeys.size > 0, 'held key before the owned RTC fault');
    report.initialRtcReceiving = await page.locator('#rtc-display').evaluate(v => ({width: v.videoWidth, height: v.videoHeight, currentTime: v.currentTime}));
    await injectRtcFailure();
    await until(async () => currentMode() === 'webcodecs' && await videoReady(), 'video recovery after established RTC fault');
    await page.keyboard.up('Control');
    await until(() => heldKeys.size === 0 && !audioEnabled, 'held input and audio canceled at active media recovery');
    assert.equal(await page.getByRole('button', { name: 'Audio off', exact: true }).count(), 1);
    report.establishedRtcFaultRecovery = true;
  }
  report.finalMediaMode = currentMode();
  report.initialSocketStates = await page.evaluate(() => window.__testSockets);
  report.initialRtcStates = await page.evaluate(() => window.__testPeers?.map(p => ({connection: p.connectionState, ice: p.iceConnectionState})) || []);
  report.fallbackObserved = !['webcodecs','adaptive'].includes(transport) && currentMode() === 'webcodecs';
  if (transport === 'fallback') assert.equal(report.fallbackObserved, true);
  if (['webrtc', 'native-only','codec-update'].includes(transport)) assert.equal(currentMode(), 'webrtc');
  if (transport === 'native-only') { assert.equal(report.initialSocketStates[0].mediaFallback, false); assert.equal(report.initialSocketStates[0].negotiatedProtocol, ''); }
  if (report.fallbackObserved) {
    assert.equal(report.initialSocketStates[0].recoveryAcknowledged, true);
    assert.equal(report.initialSocketStates.length, 2);
    assert.deepEqual(report.initialSocketStates.map(s => s.codeMessages), [1, 0]);
  }
  assert.equal(counts.nativeConnections, 1, 'media recovery retains the original capture');
  report.video = await page.locator(currentMode() === 'webrtc' ? '#rtc-display' : '#display').evaluate(v => {
    const c = document.createElement('canvas'); c.width = 80; c.height = 45;
    const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0, 80, 45); const data = ctx.getImageData(0, 0, 80, 45).data;
    const colors = new Set(); for (let i = 0; i < data.length; i += 64) colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    return { width: v.videoWidth ?? v.width, height: v.videoHeight ?? v.height, distinctSampleColors: colors.size, currentTime: v.currentTime };
  });
  assert.ok(report.video.distinctSampleColors > 10, 'generated color pattern is actually decoded');
  await page.locator('#rtc-display').evaluate(v => v.volume = 0); // No audible tone on the Mac.
  await page.getByRole('button', { name: 'Audio off', exact: true }).click();
  await until(() => page.evaluate(async () => {
    if (window.__decoded.audio > 3) return true;
    const pc = window.__testPeers?.at(-1); if (!pc) return false;
    const stats = [...(await pc.getStats()).values()]; return stats.some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.bytesReceived > 0);
  }), currentMode() === 'webrtc' ? 'actual Opus inbound RTP' : 'actual decoded Opus');
  report.audioDecodeCount = await page.evaluate(() => window.__decoded.audio);
  if (currentMode() === 'webrtc') report.audioStats = await page.evaluate(async () => {
    const stats = [...(await window.__testPeers.at(-1).getStats()).values()];
    return stats.filter(s => s.type === 'inbound-rtp' && s.kind === 'audio').map(s => ({bytesReceived: s.bytesReceived, packetsReceived: s.packetsReceived, totalSamplesReceived: s.totalSamplesReceived}));
  });
  const beforeMute = audioSent;
  await page.getByRole('button', { name: 'Audio on', exact: true }).click(); await until(() => !audioEnabled, 'mute native command');
  const mutedAt = audioSent; await new Promise(r => setTimeout(r, 150)); assert.equal(audioSent, mutedAt);
  if (currentMode() === 'webrtc') assert.equal(await page.locator('#rtc-display').evaluate(v => v.muted), true);
  await page.getByRole('button', { name: 'Audio off', exact: true }).click(); await until(() => audioSent > beforeMute + 3, 'audio resume');
  report.opusTransportAndMuteResume = true;
  if (transport==='codec-update') {
    assert.notDeepEqual(fixture.configuration,replacement.configuration);
    assert.deepEqual(fixture.parameterSetIds,{sps:[0],pps:[0]});assert.deepEqual(replacement.parameterSetIds,{sps:[1],pps:[1]});
    await page.getByRole('button',{name:'Keyboard',exact:true}).click();
    await page.keyboard.down('Control');await until(()=>heldKeys.size===1,'held input before codec configuration update');
    const sentBefore=audioSent,answersBefore=counts.answers;
    native.write(mediaPacket(replacement.configuration,0,1));activeFixture=replacement;frameIndex=0;
    await until(()=>page.locator('#rtc-display').evaluate(v=>{
      const c=document.createElement('canvas');c.width=1;c.height=1;const x=c.getContext('2d');x.drawImage(v,0,0,1,1);
      const [r,g,b]=x.getImageData(0,0,1,1).data;return b>200&&r<30&&g<30;
    }),'new SPS/PPS identifiers and actual replacement pixels on the same RTC peer');
    assert.equal(heldKeys.size,1);assert.equal(audioEnabled,true);await until(()=>audioSent>sentBefore+5,'audio continues during codec configuration update');
    assert.equal(counts.answers,answersBefore);assert.equal(counts.nativeConnections,1);
    assert.equal((await page.evaluate(()=>window.__testSockets)).length,1);
    assert.equal(await page.evaluate(()=>window.__testPeers.length),1);
    await page.keyboard.up('Control');await page.locator('#close-keyboard').click();
    report.codecUpdate={outOfBandParameterSets:true,initialSampleSpsOnly:true,replacementPixelsDecoded:true,changedParameterSetIdentifiers:true,
      retainedAudioAndHeldInput:true,sameRtcPeer:true,sameNativeCapture:true,newInvitation:false,actualNativeEncoderQualified:false};
    report.codecUpdate.parameterSetIds=[fixture.parameterSetIds,replacement.parameterSetIds];
  }
  if (transport === 'adaptive') {
    await page.getByRole('button',{name:'Keyboard',exact:true}).click();
    await page.keyboard.down('Control'); await until(()=>heldKeys.size>0,'held input during quality adjustment');
    const sentBefore = audioSent;
    const sample = sequence=>({type:'video-feedback',sequence,durationMs:2000,frames:60,dropped:0,decodeMs:5,queue:0,lossPct:8,rttMs:50});
    await page.evaluate(s=>window.__sendOwnedFeedback(s),sample(100));
    await new Promise(r=>setTimeout(r,850));await page.evaluate(s=>window.__sendOwnedFeedback(s),sample(101));
    await until(()=>adaptiveCommands.includes(13),'fixed quality reduction');
    assert.equal(heldKeys.size,1);assert.equal(audioEnabled,true);assert.ok(audioSent>sentBefore);assert.equal(counts.nativeConnections,1);
    await page.keyboard.up('Control');await page.locator('#close-keyboard').click();
    await page.getByRole('button',{name:'Options',exact:true}).click();
    const automatic = page.getByRole('checkbox',{name:'Adjust video automatically',exact:true});await automatic.focus();
    assert.equal(await automatic.evaluate(e=>document.activeElement===e),true);await page.keyboard.press('Space');
    await until(()=>adaptiveCommands.includes(12),'manual owner limits restored');
    await until(async()=>/Manual video.*60 FPS cap.*12.0 Mbps target/.test(await page.locator('#video-quality-status').textContent()),'actual native status');
    await page.screenshot({path:path.join(output,'automatic-video.png')});
    for (const [width,height,rtl] of [[320,640,false],[844,390,true]]) {
      await page.setViewportSize({width,height});await page.evaluate(rtl=>{document.documentElement.dir=rtl?'rtl':'ltr'},rtl);
      await automatic.focus();const box=await automatic.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await new Promise(r=>setTimeout(r,150));
      assert.equal(await page.locator('#receiver-viewport').count(),1);
      assert.ok(box.height>=20&&box.width>=20);assert.equal(await automatic.evaluate(e=>getComputedStyle(e).outlineStyle),'solid');
      const label=await page.locator('#video-quality-setting label').boundingBox();assert.ok(label.height>=44);
      await page.screenshot({path:path.join(output,`automatic-video-${width}-${rtl?'rtl':'ltr'}.png`)});
    }
    await page.setViewportSize({width:844,height:600});await page.evaluate(()=>document.documentElement.dir='ltr');
    await page.locator('#close-options').click();
    report.adaptiveVideo={injectedAdvisory:true,actualNativeBitrateQualified:false,fixedCommands:adaptiveCommands,retainedAudioAndHeldInput:true,manualRestore:true,keyboardToggle:true};
  }
  const canvas = page.locator('#display'), bounds = await canvas.boundingBox();
  const beforeTap = counts.pointer, tapStart = inputs.length;
  await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await until(() => counts.pointer >= beforeTap + 2, 'touch down/up');
  const tap = inputs.slice(tapStart).find(p => p[0] === 3 && p[1] === 0);
  assert.ok(Math.abs(tap.readUInt32BE(10) - fixture.width / 2) <= 1);
  assert.ok(Math.abs(tap.readUInt32BE(14) - fixture.height / 2) <= 1);
  const dragStart = inputs.length;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2 + 12, {steps: 3}); await page.mouse.up();
  await until(() => inputs.slice(dragStart).some(p => p[0] === 3 && p[1] === 1), 'released mouse drag');
  const drag = inputs.slice(dragStart).filter(p => p[0] === 3);
  const down = drag.find(p => p[1] === 0), up = drag.find(p => p[1] === 1);
  assert.ok(down && up && up.readUInt32BE(10) > down.readUInt32BE(10), 'drag maps to moved remote coordinates');
  const beforeScroll = counts.scroll; await page.mouse.wheel(0, 60);
  await until(() => counts.scroll > beforeScroll, 'wheel packet');
  assert.equal(touches.size, 0); report.mappedTapMouseDragWheel = true;
  await page.getByRole('button', { name: 'Shortcuts', exact: true }).click();
  await page.getByRole('button', { name: 'Send Tab', exact: true }).click();
  await until(() => inputs.some(p => p[0] === 8 && p[1] === 1 && p.readUInt16BE(2) === 43), 'shortcut release');
  await page.locator('#close-shortcuts').click();
  await page.getByRole('button', { name: 'Keyboard', exact: true }).click();
  await page.locator('#keyboard-input').fill('café 😊'); await until(() => counts.text > 0, 'UTF-8 input');
  assert.equal(Buffer.concat(inputs.filter(p => p[0] === 9).map(p => p.subarray(3))).toString('utf8'), 'café 😊');
  report.exactUnicodeInput = true;
  await page.keyboard.down('Control'); await until(() => heldKeys.size > 0, 'owned held key');
  await page.reload(); await page.keyboard.up('Control');
  await until(() => heldKeys.size === 0 && touches.size === 0, 'released input at reload');
  await until(videoReady, 'actual video after reload');
  assert.equal(await page.locator('#rtc-display').evaluate(v => v.muted), true, 'new page starts muted');
  await until(() => !audioEnabled, 'native audio disabled on reload');
  assert.equal(await page.getByRole('button', { name: 'Audio off', exact: true }).count(), 1);
  await page.screenshot({ path: path.join(output, 'synthetic-receiver.png'), fullPage: true });
  report.stats = await page.evaluate(async () => {
    const pc = window.__testPeers?.at(-1);
    if (!pc) return { decoded: window.__decoded };
    const stats = [...(await pc.getStats()).values()];
    return stats.filter(s => s.type === 'inbound-rtp').map(s => ({ kind: s.kind, bytesReceived: s.bytesReceived, packetsReceived: s.packetsReceived, framesDecoded: s.framesDecoded, totalSamplesReceived: s.totalSamplesReceived }));
  });
  assert.equal(await page.locator('#error').textContent(), ''); assert.deepEqual(errors, []);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('#join-panel').waitFor({ state: 'visible' });
  await until(() => native.destroyed && heldKeys.size === 0 && touches.size === 0, 'clean Stop');
  assert.ok(counts.videoAcks > 5 && counts.audioAcks > 3);
  assert.equal(counts.nativeConnections, 1, 'reload also retains the same capture');
  report.inputAndReloadAndStop = true; report.counts = counts;
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${engine}/${transport}: actual synthetic H.264/Opus receiving, Unicode input, mute, reload and Stop pass.`);
} catch (error) {
  report.failure = error.message.startsWith('Synthetic browser transition missing:') ? error.message : 'Browser media check failed; inspect local test output.'; report.counts = counts; report.brokerModes = brokerModes;
  if (page) {
    report.state = await page.evaluate(() => ({ videoCodecs: window.RTCRtpReceiver?.getCapabilities?.('video')?.codecs.map(c => ({ mimeType: c.mimeType, parameters: c.sdpFmtpLine })), sockets: window.__testSockets, status: document.getElementById('status')?.textContent, error: document.getElementById('error')?.textContent,
      peers: window.__testPeers?.map(p => ({ connection: p.connectionState, ice: p.iceConnectionState, gathering: p.iceGatheringState, candidates: p.__iceCounts, localSdpLength: p.localDescription?.sdp.length, localHasCandidate: p.localDescription?.sdp.includes('a=candidate:'), media: p.localDescription?.sdp.split(/\r?\n/).filter(l => l.startsWith('m=')).map(l => ({ kind: l.split(' ')[0], accepted: l.split(' ')[1] !== '0' })) })),
      video: { width: document.getElementById('rtc-display')?.videoWidth, ready: document.getElementById('rtc-display')?.readyState } })).catch(() => null);
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  }
  await writeFile(path.join(output, 'failure.json'), JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally { stopSource(); await context?.close(); native?.destroy(); await receiver.shutdown(); await browser.close(); }
