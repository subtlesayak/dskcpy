import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { browserJoinUrl, parseJoinFragment } from '../receiver/protocol.mjs';

test('independently decoded QR contains the exact one-use invitation in a fragment, never the request path', () => {
  const key = 'x'.repeat(32), join = browserJoinUrl('https://desktop.example:8443/', key);
  const { modules } = QRCode.create(join, { errorCorrectionLevel: 'M' });
  const scale = 5, width = (modules.size + 8) * scale, rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < modules.size; y++) for (let x = 0; x < modules.size; x++) if (modules.data[y * modules.size + x]) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const offset = (((y + 4) * scale + dy) * width + (x + 4) * scale + dx) * 4;
      rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = 0;
    }
  }
  const decoded = jsQR(rgba, width, width);
  assert.equal(decoded.data, join);
  const url = new URL(decoded.data);
  assert.equal(url.pathname + url.search, '/');
  assert.equal(parseJoinFragment(url.hash), key);
});

test('QR join rejects invalid keys, unsafe destinations and ambiguous fragment fields', () => {
  const key = 'x'.repeat(32);
  for (const address of ['http://desktop.example/', 'https://user@desktop.example/',
    'https://desktop.example/path', 'https://desktop.example/?code=secret', 'https://desktop.example/#anything']) {
    assert.throws(() => browserJoinUrl(address, key));
  }
  assert.throws(() => browserJoinUrl('https://desktop.example/', 'short'));
  for (const hash of ['', '#connect=short', `#connect=${key}&other=1`, `#other=1&connect=${key}`, `#connect=${key}&connect=${key}`]) assert.equal(parseJoinFragment(hash), null);
});
