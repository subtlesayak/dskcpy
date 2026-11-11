import test from 'node:test';
import assert from 'node:assert/strict';
import { RTCPeerConnection, useH264, useOPUS } from 'werift';
import { createRtcMedia, privateRtcBind, rtpTimestamp } from './browser-rtc.mjs';

const configuration = Buffer.from('000000016742c01e0102030000000168ce3c80', 'hex');
const key = Buffer.from('0000000165888401020304', 'hex');
const delta = Buffer.from('00000001419a01020304', 'hex');
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
    sender.sendRtp = () => new Promise((resolve) => { finish = resolve; });
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
