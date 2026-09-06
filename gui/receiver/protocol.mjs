export function ack(type, timestamp) {
  const bytes = new Uint8Array(9);
  bytes[0] = type;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(timestamp));
  return bytes;
}

// Native ACKs are cumulative. A decoded frame completing after a newer frame
// was discarded must never send an older ACK and look like a protocol forgery.
export function createMediaAcknowledger(deliver) {
  const latest = new Map();
  return {
    acknowledge(type, timestamp) {
      const pts = BigInt(timestamp);
      if (pts <= (latest.get(type) ?? -1n)) return false;
      if (deliver(ack(type, pts)) === false) return false;
      latest.set(type, pts); return true;
    },
    reset() { latest.clear(); },
  };
}

export function fitDisplay(width, height, availableWidth, availableHeight) {
  if (![width, height, availableWidth, availableHeight].every((value) => Number.isFinite(value) && value > 0)) return { width: 0, height: 0 };
  const scale = Math.min(availableWidth / width, availableHeight / height);
  return { width: width * scale, height: height * scale };
}

export function needsControlsRow(width, height, availableWidth, availableHeight) {
  const fitted = fitDisplay(width, height, availableWidth, availableHeight);
  // 44px target plus edge/focus clearance, entirely outside the video pixels.
  return (availableWidth - fitted.width) / 2 < 60 && (availableHeight - fitted.height) / 2 < 60;
}

export function takeDecodedTimestamps(pending, remaining) {
  return pending.splice(0, Math.max(0, pending.length - remaining));
}

export function avcCodec(bytes) {
  for (let i = 0; i + 6 < bytes.length; i++) {
    const start = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 ? i + 3
      : bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1 ? i + 4 : -1;
    if (start >= 0 && (bytes[start] & 31) === 7 && start + 3 < bytes.length) {
      return 'avc1.' + Array.from(bytes.subarray(start + 1, start + 4), (b) => b.toString(16).padStart(2, '0')).join('');
    }
  }
  throw new Error('The host did not send an H.264 SPS configuration.');
}

// Some hardware encoders put SPS/PPS in the first IDR instead of extradata.
// Retain parameter sets only: retaining the entire IDR would replay old pixels
// every time they are prepended to a later key frame.
export function avcParameters(bytes) {
  const starts = [];
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1))) {
      const size = bytes[i + 2] === 1 ? 3 : 4;
      starts.push({ offset: i, type: bytes[i + size] & 31 }); i += size - 1;
    }
  }
  const parts = starts.flatMap((entry, i) => [7, 8].includes(entry.type)
    ? [bytes.subarray(entry.offset, starts[i + 1]?.offset ?? bytes.length)] : []);
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function touchPacket(action, id, x, y, width, height) {
  const bytes = new Uint8Array(32);
  const data = new DataView(bytes.buffer);
  bytes[0] = 3; bytes[1] = action;
  data.setBigUint64(2, BigInt(id));
  data.setUint32(10, Math.max(0, Math.min(width - 1, Math.round(x))));
  data.setUint32(14, Math.max(0, Math.min(height - 1, Math.round(y))));
  data.setUint16(18, width); data.setUint16(20, height);
  data.setUint16(22, [1, 3, 6].includes(action) ? 0 : 0xffff);
  data.setUint32(24, 1);
  data.setUint32(28, [1, 3, 6].includes(action) ? 0 : 1);
  return bytes;
}

// Scroll deltas are viewport pixels, positive right/down. Separate from touch
// contacts so a swipe cannot turn into a pressed mouse button/text selection.
export function scrollPacket(x, y, width, height, dx, dy) {
  const bytes = new Uint8Array(21), data = new DataView(bytes.buffer);
  bytes[0] = 7;
  data.setUint32(1, Math.max(0, Math.min(width - 1, Math.round(x))));
  data.setUint32(5, Math.max(0, Math.min(height - 1, Math.round(y))));
  data.setUint16(9, width); data.setUint16(11, height);
  data.setInt32(13, Math.max(-120, Math.min(120, Math.round(dx))));
  data.setInt32(17, Math.max(-120, Math.min(120, Math.round(dy))));
  return bytes;
}
