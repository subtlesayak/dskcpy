import test from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection, useH264, useOPUS, H264RtpPayload, splitH264NalUnits } from 'werift';
import { createRtcMedia, privateRtcBind, rtpTimestamp, sessionScopedIceLite } from './browser-rtc.mjs';

const configuration = Buffer.from('000000016742c01e0102030000000168ce3c80', 'hex');
const key = Buffer.from('0000000165888401020304', 'hex');
const delta = Buffer.from('00000001419a01020304', 'hex');
const rtpNals = packets => packets.flatMap(p => splitH264NalUnits(H264RtpPayload.deSerialize(p.payload).payload, 4, 'annexb'));

test('RTC sends configuration with an IDR when the native frame omits parameter sets', async t => {
  let peer;
  const media = createRtcMedia({ configuration, peerFactory: options => (peer = new RTCPeerConnection(options)) });
  t.after(() => media.close());
  const packets = []; peer.getSenders()[0].sendRtp = async p => { packets.push(p); };
  peer.connectionStateChange.execute('connected');
  assert.equal(await media.frame(key, 100n, true), true);
  const nals = rtpNals(packets);
  assert.deepEqual(nals.map(n => n[0] & 31), [7, 8, 5]);
  assert.deepEqual(Buffer.concat(nals.slice(0,2)), Buffer.concat(splitH264NalUnits(configuration,4,'annexb')));
});

test('RTC configuration change retains RTP/audio state, waits for IDR and never retains old pixels', async t => {
  let peer, requests = 0, time = 0;
  const media = createRtcMedia({ configuration, now: () => time, onKeyframe: () => requests++,
    peerFactory: options => (peer = new RTCPeerConnection(options)) });
  t.after(() => media.close());
  const video = [], audio = []; peer.getSenders()[0].sendRtp = async p => { video.push(p); };
  peer.getSenders()[1].sendRtp = async p => { audio.push(p); };
  peer.connectionStateChange.execute('connected');
  await media.frame(key,100n,true); await media.sound(Buffer.from([0xf8,0xff,0xfe]),100n);
  const next = Buffer.from('000000016742c01e1122330000000168ce3c81','hex');
  time = 400; assert.equal(media.configure(Buffer.concat([next,key])), true);
  assert.equal(await media.frame(delta,200n,false),false);
  const start=video.length; assert.equal(await media.frame(key,300n,true),true);
  const nals=rtpNals(video.slice(start));assert.deepEqual(nals.map(n=>n[0]&31),[7,8,5]);
  assert.deepEqual(Buffer.concat(nals.slice(0,2)),Buffer.concat(splitH264NalUnits(next,4,'annexb')));
  assert.equal((video[start].header.sequenceNumber-video[start-1].header.sequenceNumber)&0xffff,1);
  assert.equal(new Set(video.map(p=>p.header.ssrc)).size,1);
  await media.sound(Buffer.from([0xf8,0xff,0xfe]),101n);
  assert.equal((audio[1].header.timestamp-audio[0].header.timestamp)>>>0,480);
  assert.ok(requests>=2);assert.equal(media.configure(next),false);
  for(const invalid of [Buffer.alloc(65537),key,configuration.subarray(0,11),Buffer.from('000000016764001e0102030000000168ce3c80','hex')])
    assert.throws(()=>media.configure(invalid),/configuration|profile|parameter/);
  assert.equal(await media.frame(delta,400n,false),true,'rejected config preserves last working configuration');
  await media.close();assert.equal(media.configure(next),false);
});

test('an old in-flight IDR cannot satisfy a newer configuration epoch', async t => {
  let peer, finish;
  const media=createRtcMedia({configuration,peerFactory:o=>(peer=new RTCPeerConnection(o))});
  t.after(()=>media.close());peer.connectionStateChange.execute('connected');
  const sender=peer.getSenders()[0];sender.sendRtp=()=>finish?Promise.resolve():new Promise(r=>{finish=r;});
  const old=media.frame(key,1n,true);
  media.configure(Buffer.from('000000016742c01e1122330000000168ce3c81','hex'));
  finish();await old;sender.sendRtp=async()=>{};
  assert.equal(await media.frame(delta,2n,false),false);
  assert.equal(await media.frame(key,3n,true),true);
  assert.equal(await media.frame(delta,4n,false),true);
});

test('parameter replay keeps AUD first and adds only the missing PPS without duplicating pixels', async t => {
  let peer;
  const media=createRtcMedia({configuration,peerFactory:o=>(peer=new RTCPeerConnection(o))});t.after(()=>media.close());
  const packets=[];peer.getSenders()[0].sendRtp=async p=>{packets.push(p);};peer.connectionStateChange.execute('connected');
  const sps=splitH264NalUnits(configuration,4,'annexb')[0];
  await media.frame(Buffer.concat([Buffer.from('0000000109f000000001','hex'),sps,key]),1n,true);
  assert.deepEqual(rtpNals(packets).map(n=>n[0]&31),[9,7,8,5]);
});
async function until(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Private WebRTC transition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('WebRTC restricts host interfaces and maps microseconds with RTP wraparound', () => {
  for (const address of ['127.0.0.1', '192.168.10.2', '10.0.0.1', '100.64.0.2']) assert.equal(privateRtcBind(address), true);
  for (const address of ['0.0.0.0', '8.8.8.8', 'localhost', '::', '169.254.1.2']) {
    assert.equal(privateRtcBind(address), false);
    assert.throws(() => createRtcMedia({ bind: address, configuration }), /private IPv4/);
  }
  assert.equal(rtpTimestamp(1000000n, 90000), 90000);
  assert.equal(rtpTimestamp(1000000n, 48000), 48000);
  assert.equal(rtpTimestamp(50000000000n, 90000), 4500000000 % 2 ** 32);
});

test('real private ICE/DTLS/SRTP peers exchange native H264 and Opus without public servers', { timeout: 15000 }, async (t) => {
  let keyRequests = 0;
  const sender = createRtcMedia({ configuration, onKeyframe: () => keyRequests++ });
  const receiver = new RTCPeerConnection({
    codecs: { video: [useH264({ payloadType: 96, parameters: 'profile-level-id=42c01e;packetization-mode=1;level-asymmetry-allowed=1' })], audio: [useOPUS({ payloadType: 111 })] },
    iceServers: [], iceUseDefaultStunServer: false, iceUseIpv4: true, iceUseIpv6: false,
    iceInterfaceAddresses: { udp4: '127.0.0.1' }, iceUseTcp: false, bundlePolicy: 'max-bundle',
  });
  t.after(async () => { await sender.close(); await receiver.close(); });
  const packets = [];
  receiver.onTrack.subscribe((track) => track.onReceiveRtp.subscribe((packet) => packets.push({ kind: track.kind, packet })));
  assert.equal(await sender.frame(key, 0n, true), false);
  const offer = await sender.offer();
  const lines = offer.sdp.split('\r\n');
  assert.equal(lines.filter(line => line === 'a=ice-lite').length, 1, 'ICE-lite is a single session flag');
  assert.ok(lines.indexOf('a=ice-lite') < lines.findIndex(line => line.startsWith('m=')), 'ICE-lite must precede all media sections');
  const candidates = offer.sdp.split('\r\n').filter((line) => line.startsWith('a=candidate:'));
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((line) => line.split(' ')[4] === '127.0.0.1'));
  await receiver.setRemoteDescription(offer);
  await receiver.setLocalDescription(await receiver.createAnswer());
  await sender.answer({ type: 'answer', sdp: receiver.localDescription.sdp });
  await until(() => sender.connected);
  assert.equal(await sender.frame(delta, 10000n, false), false);
  assert.equal(await sender.frame(key, 20000n, true), true);
  assert.equal(await sender.frame(delta, 30000n, false), true);
  assert.equal(await sender.sound(Buffer.from([0xf8, 0xff, 0xfe]), 20000n), true);
  await until(() => packets.some((entry) => entry.kind === 'audio') && packets.filter((entry) => entry.kind === 'video').length >= 2);
  assert.ok(keyRequests > 0);
  assert.equal(packets.find((entry) => entry.kind === 'audio').packet.header.timestamp, 960);
  await sender.close();
  assert.equal(await sender.frame(key, 40000n, true), false);
  assert.equal(await sender.sound(Buffer.from([1]), 40000n), false);
});

test('invalid or unsolicited SDP answers are rejected without enabling media', async () => {
  const sender = createRtcMedia({ configuration });
  try {
    await assert.rejects(sender.answer({ type: 'answer', sdp: 'not sdp' }), /Invalid/);
    assert.equal(sender.connected, false);
  } finally { await sender.close(); }
});

test('only routed PLI and new FIR requests trigger throttled keyframes', async (t) => {
  let peer, requests = 0, time = 0;
  const media = createRtcMedia({ configuration, now: () => time,
    onKeyframe: () => requests++, peerFactory: (options) => (peer = new RTCPeerConnection(options)) });
  t.after(() => media.close());
  const sender = peer.getSenders()[0];
  const feedback = (value) => sender.handleRtcpPacket({ type: 206, feedback: value });
  feedback({ count: 15, bitrate: 1000000 }); // REMB shares PSFB type 206.
  feedback({ count: 99 });
  assert.equal(requests, 0);
  feedback({ count: 1 }); // PLI.
  assert.equal(requests, 1);
  time = 100; feedback({ count: 1 }); assert.equal(requests, 1);
  const fir = (ssrc, sequenceNumber) => feedback({ count: 4, senderSsrc: 123, fir: [{ ssrc, sequenceNumber }] });
  time = 400; fir(sender.ssrc, 1); assert.equal(requests, 2);
  time = 800; fir(sender.ssrc, 1); assert.equal(requests, 2);
  fir((sender.ssrc + 1) >>> 0, 2); assert.equal(requests, 2);
  time = 1200; fir(sender.ssrc, 2); assert.equal(requests, 3);
  await media.close();
  time = 1600; feedback({ count: 1 }); assert.equal(requests, 3);
});

test('loss feedback during an in-flight IDR requires a later IDR; bitrate feedback does not', async (t) => {
  for (const pictureLost of [false, true]) {
    let peer, finish;
    const media = createRtcMedia({ configuration,
      peerFactory: (options) => (peer = new RTCPeerConnection(options)) });
    t.after(() => media.close());
    const sender = peer.getSenders()[0];
    sender.sendRtp = () => finish ? Promise.resolve() : new Promise((resolve) => { finish = resolve; });
    peer.connectionStateChange.execute('connected');
    const inFlight = media.frame(key, 1n, true);
    sender.handleRtcpPacket({ type: 206, feedback: pictureLost ? { count: 1 } : { count: 15, bitrate: 1000000 } });
    finish(); await inFlight;
    sender.sendRtp = async () => {};
    assert.equal(await media.frame(delta, 2n, false), !pictureLost);
    assert.equal(await media.frame(key, 3n, true), true);
    assert.equal(await media.frame(delta, 4n, false), true);
    await media.close();
  }
});


test('burst Opus packets advance a 10 ms sample clock, preserving gaps and RTP wraparound', async (t) => {
  let peer;
  const media = createRtcMedia({ configuration,
    peerFactory: (options) => (peer = new RTCPeerConnection(options)) });
  t.after(() => media.close());
  const packets = [], sender = peer.getSenders()[1];
  sender.sendRtp = async (packet) => { packets.push(packet); };
  peer.connectionStateChange.execute('connected');
  const base = 89478480000n; // Just before the 32-bit RTP clock wraps.
  for (const offset of [0n, 1n, 2n, 3n, 1000000n])
    assert.equal(await media.sound(Buffer.from([0xf0, 0xff, 0xfe]), base + offset), true);
  const start = base * 48000n / 1000000n;
  assert.deepEqual(packets.map((p) => p.header.timestamp),
    [start, start + 480n, start + 960n, start + 1440n, start + 48000n].map((v) => Number(v & 0xffffffffn)));
  assert.deepEqual(packets.slice(1).map((p, i) => (p.header.sequenceNumber - packets[i].header.sequenceNumber) & 0xffff), [1,1,1,1]);
});

test('a dropped concurrent audio packet leaves a sample-clock gap without retaining a queue', async (t) => {
  let peer, finish;
  const media = createRtcMedia({ configuration,
    peerFactory: (options) => (peer = new RTCPeerConnection(options)) });
  t.after(() => media.close());
  const packets = [], sender = peer.getSenders()[1];
  sender.sendRtp = (packet) => { packets.push(packet); return new Promise((resolve) => { finish = resolve; }); };
  peer.connectionStateChange.execute('connected');
  const first = media.sound(Buffer.from([0xf0, 0xff, 0xfe]), 1000000n);
  assert.equal(await media.sound(Buffer.from([0xf0, 0xff, 0xfe]), 1000001n), false);
  finish(); await first;
  sender.sendRtp = async (packet) => { packets.push(packet); };
  assert.equal(await media.sound(Buffer.from([0xf0, 0xff, 0xfe]), 1000002n), true);
  assert.deepEqual(packets.map((p) => p.header.timestamp), [48000, 48960]);
  assert.equal((packets[1].header.sequenceNumber - packets[0].header.sequenceNumber) & 0xffff, 1);
});


test('ICE-lite serialization changes only the known flag and is idempotent', () => {
  const before = 'v=0\r\ns=owned-test\r\na=group:BUNDLE 0 1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=ice-lite\r\na=ice-ufrag:test-only\r\na=candidate:1 1 udp 1 127.0.0.1 12345 typ host\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-lite\r\na=rtpmap:111 opus/48000/2\r\n';
  const expected = before.replaceAll('a=ice-lite\r\n', '').replace('m=video', 'a=ice-lite\r\nm=video');
  assert.equal(sessionScopedIceLite(before), expected);
  assert.equal(sessionScopedIceLite(expected), expected);
  assert.equal(sessionScopedIceLite(before).replace('a=ice-lite\r\n', ''), before.replaceAll('a=ice-lite\r\n', ''));
});

test('missing or invalid host-generated ICE-lite descriptions fail closed', () => {
  for (const value of [null, {}, '', 'v=0\n' + 'a=ice-lite\nm=audio 9 RTP/AVP 0\n',
    'v=0\r\na=ice-lite\r\n', 'v=0\r\nm=audio 9 RTP/AVP 0\r\n',
    'v=0\r\na=ice-lite\r\nm=audio 9 RTP/AVP 0\r\n' + 'x'.repeat(32768)]) {
    assert.throws(() => sessionScopedIceLite(value), /private media offer|Private media offer/);
  }
});
