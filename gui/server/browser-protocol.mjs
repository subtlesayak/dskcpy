import { readClipboardRequest, CLIPBOARD_MAX } from '../receiver/clipboard.mjs';
// Existing SRD1 packets are unchanged. Clipboard-v1 adds an opt-in flag32 reply.
// One WebSocket message carries the
// 16-byte stream header, then one complete 16-byte-header media packet each.
export const MAX_PACKET = 16 * 1024 * 1024;

export class SrdParser {
  constructor(deliver) {
    this.deliver = deliver;
    this.streamHeader = true;
    this.buffer = Buffer.alloc(16);
    this.used = 0;
  }
  push(chunk) {
    while (chunk.length) {
      const count = Math.min(chunk.length, this.buffer.length - this.used);
      chunk.copy(this.buffer, this.used, 0, count);
      this.used += count;
      chunk = chunk.subarray(count);
      if (this.used !== this.buffer.length) continue;
      if (this.streamHeader) {
        if (this.buffer.readUInt32BE(0) !== 0x53524431 || this.buffer.readUInt32BE(4) !== 1
            || !this.buffer.readUInt32BE(8) || !this.buffer.readUInt32BE(12)
            || this.buffer.readUInt32BE(8) > 16384 || this.buffer.readUInt32BE(12) > 16384) {
          throw new Error('Invalid native stream header.');
        }
        this.streamHeader = false;
        this.deliver(this.buffer, true);
      } else if (this.buffer.length === 16) {
        const size = this.buffer.readUInt32BE(0);
        const flags = this.buffer.readUInt32BE(12);
        if (size > MAX_PACKET || ![0, 1, 2, 3, 4, 8, 16, 32].includes(flags)
            || (flags === 32 && (size < 8 || size > CLIPBOARD_MAX + 8))) {
          throw new Error('Invalid native packet.');
        }
        if (size) {
          const packet = Buffer.allocUnsafe(16 + size);
          this.buffer.copy(packet);
          this.buffer = packet;
          continue;
        }
        this.deliver(this.buffer, false);
      } else {
        this.deliver(this.buffer, false);
      }
      this.buffer = Buffer.alloc(16);
      this.used = 0;
    }
  }
}

export function validBrowserInput(data, width, height, { keyboard = false, clipboard = false } = {}) {
  if (data[0] === 10) { try { if (!clipboard || !keyboard) return false; readClipboardRequest(data); return true; } catch { return false; } }
  if (data[0] === 8) {
    if (!keyboard || data.length !== 5 || data[1] > 2) return false;
    const usage = data.readUInt16BE(2);
    return data[1] === 2 ? usage === 0 && data[4] === 0
      : (usage >= 4 && usage <= 0x73) || (usage >= 0xe0 && usage <= 0xe7);
  }
  if (data[0] === 9) {
    if (!keyboard || data.length < 4 || data.length > 515 || data.readUInt16BE(1) !== data.length - 3) return false;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(3));
      return text.length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
    } catch { return false; }
  }
  if (data.length === 9 && [4, 6].includes(data[0])) return true;
  // Close and Lock are deliberately not exposed by the experimental receiver.
  if (data.length === 2 && data[0] === 5) return [0, 1, 2, 3, 4, 7, 8, 9, 10, 11].includes(data[1]);
  if (data.length === 21 && data[0] === 7) {
    return data.readUInt16BE(9) === width && data.readUInt16BE(11) === height
      && data.readUInt32BE(1) < width && data.readUInt32BE(5) < height
      && Math.abs(data.readInt32BE(13)) <= 120 && Math.abs(data.readInt32BE(17)) <= 120;
  }
  if (data.length !== 32 || data[0] !== 3 || ![0, 1, 2, 3, 5, 6].includes(data[1])) return false;
  return data.readBigUInt64BE(2) < 16n
    && data.readUInt16BE(18) === width && data.readUInt16BE(20) === height
    && data.readUInt32BE(10) < width && data.readUInt32BE(14) < height
    && data.readUInt32BE(24) <= 1 && data.readUInt32BE(28) <= 1;
}
