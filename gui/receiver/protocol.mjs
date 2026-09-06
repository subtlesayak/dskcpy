export function ack(type, timestamp) {
  const bytes = new Uint8Array(9);
  bytes[0] = type;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(timestamp));
  return bytes;
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
  data.setUint16(22, action === 1 || action === 3 ? 0 : 0xffff);
  data.setUint32(24, 1);
  data.setUint32(28, action === 1 || action === 3 ? 0 : 1);
  return bytes;
}
