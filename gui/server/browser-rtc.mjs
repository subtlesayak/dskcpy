import net from 'node:net';
import { randomInt } from 'node:crypto';
import { RTCPeerConnection, H264Packetizer, RtpHeader, RtpPacket, useH264, useOPUS, splitH264NalUnits, selectMissingH264ParameterSets } from 'werift';
import { avcCodec } from '../receiver/protocol.mjs';

export function privateRtcBind(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export function rtpTimestamp(pts, frequency) {
  return Number((BigInt(pts) * BigInt(frequency) / 1000000n) & 0xffffffffn);
}

// werift 0.27 emits the ICE-lite flag in each media section. RFC 8839 §5.3
// defines it only at session scope. Move only this known host-generated flag;
// preserve candidates, credentials, fingerprints, codecs and their ordering.
export function sessionScopedIceLite(sdp) {
  if (typeof sdp !== 'string' || sdp.length > 32768 || !sdp.startsWith('v=0\r\n'))
    throw new Error('Invalid private media offer.');
  const lines = sdp.split('\r\n');
  if (!lines.includes('a=ice-lite') || !lines.some(line => line.startsWith('m=')))
    throw new Error('Private media offer is missing its ICE-lite session.');
  const scoped = lines.filter(line => line !== 'a=ice-lite');
  scoped.splice(scoped.findIndex(line => line.startsWith('m=')), 0, 'a=ice-lite');
  return scoped.join('\r\n');
}

const nalPrefix = Buffer.from([0, 0, 0, 1]);
function readConfiguration(bytes, expectedProfile) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 65536)
    throw Error('Invalid H.264 parameter configuration size.');
  const sets = splitH264NalUnits(Buffer.from(bytes), 4, 'annexb').filter(n => [7, 8].includes(n[0] & 31))
    .map(n => { const owned = Buffer.alloc(n.length); n.copy(owned); return owned; });
  if (sets.length > 32 || !sets.some(n => (n[0] & 31) === 7) || !sets.some(n => (n[0] & 31) === 8)
      || sets.some(n => n.length < 2)) throw Error('Incomplete H.264 parameter configuration.');
  const data = Buffer.concat(sets.flatMap(n => [nalPrefix, n]));
  const profile = avcCodec(data).slice(5);
  if (expectedProfile && profile !== expectedProfile || sets.some(n => (n[0] & 31) === 7
      && avcCodec(Buffer.concat([nalPrefix, n])).slice(5) !== profile))
    throw Error('H.264 configuration changes the negotiated profile.');
  return { data, sets, profile };
}

// Existing authenticated WebSocket carries signaling and control. Media uses
// DTLS-SRTP on ONE explicitly selected private interface. No public STUN/TURN,
// interface discovery, recording, or unbounded frame queue is installed.
export function createRtcMedia({ bind = '127.0.0.1', configuration,
  onKeyframe = () => {}, onFailure = () => {}, onConnected = () => {},
  peerFactory = (options) => new RTCPeerConnection(options), now = Date.now } = {}) {
  if (!privateRtcBind(bind)) throw new Error('Choose an explicit private IPv4 interface for browser media.');
  let parameters = readConfiguration(configuration);
  const profile = parameters.profile;
  const pc = peerFactory({
    codecs: { video: [useH264({ payloadType: 96,
      parameters: `profile-level-id=${profile};packetization-mode=1;level-asymmetry-allowed=1` })],
    audio: [useOPUS({ payloadType: 111 })] },
    iceServers: [], iceUseDefaultStunServer: false, iceUseIpv4: true,
    iceUseIpv6: false, iceUseTcp: false, iceLite: true,
    iceInterfaceAddresses: { udp4: bind }, iceAdditionalHostAddresses: [bind],
    bundlePolicy: 'max-bundle', certificateScope: 'peerConnection', pendingRtp: false,
  });
  const video = pc.addTransceiver('video', { direction: 'sendonly' }).sender;
  const audio = pc.addTransceiver('audio', { direction: 'sendonly' }).sender;
  const packetizer = new H264Packetizer({ payloadType: 96, ssrc: video.ssrc,
    maxPayloadSize: 1100, inputFormat: 'annexb' });
  let sequence = randomInt(65536), closed = false, answering = false;
  let lastAudioSample;
  let connected = false, waitingKey = true, sendingVideo = false, sendingAudio = false, dropped = 0;
  let lastKeyRequest = -Infinity;
  function requestKey() {
    if (now() - lastKeyRequest < 300) return;
    lastKeyRequest = now(); onKeyframe();
  }
  function configure(bytes) {
    if (closed) return false;
    const next = readConfiguration(bytes, profile);
    if (parameters.data.equals(next.data)) return false;
    parameters = next; dropped++; waitingKey = true;
    // Keep this peer, RTP sequence/SSRC, audio clock and authorization. A new
    // decoder reference epoch needs an IDR, not a transport/session restart.
    if (connected) requestKey();
    return true;
  }
  pc.connectionStateChange.subscribe((state) => {
    if (closed) return;
    connected = state === 'connected';
    if (connected) { waitingKey = true; onConnected(); requestKey(); }
    if (state === 'failed') onFailure(new Error('Private browser media connection failed. Check VPN reachability.'));
  });
  // The sender routes PLI/FIR to this track and suppresses repeated FIRs.
  // Other payload-specific feedback (such as REMB) is not a keyframe request.
  video.onKeyFrameRequest.subscribe((kind) => {
    if (!closed && (kind === 'pli' || kind === 'fir')) { dropped++; waitingKey = true; requestKey(); }
  });
  async function offer() {
    await pc.setLocalDescription(await pc.createOffer());
    if (closed) return null;
    return { type: 'offer', sdp: sessionScopedIceLite(pc.localDescription.sdp) };
  }
  async function answer(description) {
    if (closed || answering || pc.signalingState !== 'have-local-offer'
        || description?.type !== 'answer' || typeof description.sdp !== 'string'
        || description.sdp.length > 32768 || !description.sdp.startsWith('v=0\r\n')) {
      throw new Error('Invalid browser media answer.');
    }
    answering = true;
    try { await pc.setRemoteDescription(description); }
    finally { answering = false; }
    if (!closed && !video.codec) throw new Error('This browser did not accept the host H.264 profile.');
  }
  async function frame(payload, pts, key) {
    if (closed || !connected) return false;
    if (sendingVideo) { dropped++; waitingKey = true; requestKey(); return false; }
    if (waitingKey && !key) { requestKey(); return false; }
    sendingVideo = true;
    const started = now(), epoch = dropped;
    try {
      if (key) {
        const nals = splitH264NalUnits(payload, 4, 'annexb');
        const missing = selectMissingH264ParameterSets(parameters.sets, nals);
        if (missing.length) {
          // Preserve AUD ordering and never prepend a retained picture. Only
          // missing SPS/PPS types are added, bounded to 64 KiB of configuration.
          const at = nals.findIndex(n => (n[0] & 31) !== 9);
          const index = at < 0 ? nals.length : at;
          const sets = [...nals.filter(n => [7,8].includes(n[0]&31)), ...missing];
          // A missing PPS must follow its SPS, including when that SPS was in
          // the native sample. Merely prepending the PPS would reverse them.
          payload = Buffer.concat([...nals.slice(0,index), ...sets.filter(n=>(n[0]&31)===7),
            ...sets.filter(n=>(n[0]&31)===8), ...nals.slice(index).filter(n=>![7,8].includes(n[0]&31))]
            .flatMap(n => [nalPrefix, n]));
        }
      }
      const packets = packetizer.packetize(payload, rtpTimestamp(pts, 90000), { isKeyframe: key });
      for (const packet of packets) {
        if (closed || !connected || now() - started > 150) {
          waitingKey = true; requestKey(); return false;
        }
        await video.sendRtp(packet);
      }
      // A concurrent dropped delta requires a fresh IDR, even if this frame
      // finished later. Only an IDR can reset decoder references.
      if (key && epoch === dropped) waitingKey = false;
      return true;
    } finally { sendingVideo = false; }
  }
  async function sound(payload, pts) {
    if (closed || !connected) return false;
    // Native PTS identifies ACKs and enqueue time; several 10 ms Opus packets
    // can share a callback and differ by only one microsecond. RTP must still
    // advance by 480 samples per packet. Preserve real gaps (mute/route changes)
    // and advance even for a dropped in-flight packet, without buffering audio.
    const observed = BigInt(pts) * 48000n / 1000000n;
    const sample = lastAudioSample === undefined || observed > lastAudioSample + 480n
      ? observed : lastAudioSample + 480n;
    lastAudioSample = sample;
    if (sendingAudio) return false;
    sendingAudio = true;
    try {
      await audio.sendRtp(new RtpPacket(new RtpHeader({ payloadType: 111,
        sequenceNumber: sequence++ & 0xffff, timestamp: Number(sample & 0xffffffffn),
        ssrc: audio.ssrc, marker: false }), payload));
      return true;
    } finally { sendingAudio = false; }
  }
  async function close() {
    if (closed) return;
    closed = true; connected = false;
    await pc.close();
  }
  return { offer, answer, frame, sound, configure, close, get connected() { return connected; } };
}
