// Browser-native decoding/playback: no WebCodecs or app installation needed.
export function createRtcReceiver({ element, signal, onPlaying, onError, onFailure = onError }) {
  let pc, closed = false, generation = 0, gatheringTimer, cancelGather, playing;
  const stream = new MediaStream();
  async function offer(description) {
    if (closed || pc || description?.type !== 'offer' || typeof description.sdp !== 'string'
        || description.sdp.length > 32768) throw new Error('Invalid desktop media offer.');
    const mine = ++generation;
    pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
    pc.ontrack = ({ track }) => {
      if (closed || mine !== generation) { track.stop(); return; }
      stream.addTrack(track);
      if (element.srcObject !== stream) element.srcObject = stream;
      void element.play().catch((error) => {
        if (!closed && error.name !== 'AbortError') onError('Tap Resume to start browser playback.');
      });
    };
    pc.onconnectionstatechange = () => {
      if (!closed && ['failed', 'closed'].includes(pc.connectionState)) {
        onFailure('The private media connection ended. Reconnect while both devices are on the VPN.');
      }
    };
    playing = () => { if (!closed && mine === generation) onPlaying(); };
    element.addEventListener('playing', playing);
    await pc.setRemoteDescription(description);
    if (closed) return;
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== 'complete') await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(gatheringTimer); pc.removeEventListener('icegatheringstatechange', check); cancelGather = null; };
      const check = () => { if (closed || pc.iceGatheringState === 'complete') { cleanup(); resolve(); } };
      cancelGather = () => { cleanup(); resolve(); };
      pc.addEventListener('icegatheringstatechange', check);
      gatheringTimer = setTimeout(() => { cleanup(); reject(new Error('Private media setup timed out. Check the VPN connection.')); }, 10000);
      check();
    });
    if (!closed && mine === generation) signal({ type: 'rtc-answer', description: {
      type: 'answer', sdp: pc.localDescription.sdp,
    } });
  }
  function close() {
    if (closed) return;
    closed = true; generation++; cancelGather?.(); clearTimeout(gatheringTimer);
    if (playing) element.removeEventListener('playing', playing);
    pc?.close(); for (const track of stream.getTracks()) track.stop();
    element.pause(); element.srcObject = null;
  }
  return { offer, close };
}
