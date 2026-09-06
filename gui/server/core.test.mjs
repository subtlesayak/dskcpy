import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildScrcpyArgs,
  parseAdbDevices,
  sanitizeStreamConfig,
  validateIpEndpoint,
  sanitizePairingConfig,
  isAllowedMutation,
  validateHostEncoder,
} from './core.mjs';

test('VideoToolbox configuration preserves the native argument and respects host boundaries', () => {
  const config = sanitizeStreamConfig({ connection: 'usb', encoder: 'h264_videotoolbox' });
  assert.equal(config.encoder, 'h264_videotoolbox');
  assert.ok(buildScrcpyArgs(config).includes('--video-encoder=h264_videotoolbox'));
  for (const encoder of ['auto', 'h264_videotoolbox']) assert.doesNotThrow(() => validateHostEncoder(encoder, 'darwin'));
  for (const encoder of ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf', 'libx264']) {
    assert.throws(() => validateHostEncoder(encoder, 'darwin'), /Mac host requires/);
    assert.doesNotThrow(() => validateHostEncoder(encoder, 'win32'));
  }
  assert.throws(() => validateHostEncoder('h264_videotoolbox', 'win32'), /macOS host/);
});

test('parses USB and TCP/IP adb devices', () => {
  const devices = parseAdbDevices(`List of devices attached
USB_TEST_001 device product:test_device model:Test_Phone transport_id:1
192.168.1.42:5555 unauthorized product:test model:Pixel_8 transport_id:2
`);

  assert.equal(devices.length, 2);
  assert.deepEqual(devices[0], {
    serial: 'USB_TEST_001',
    state: 'device',
    model: 'Test Phone',
    product: 'test_device',
    transport: 'USB',
    authorized: true,
  });
  assert.equal(devices[1].transport, 'Wi-Fi');
  assert.equal(devices[1].authorized, false);
});

test('validates IPv4 endpoints and ports', () => {
  assert.equal(validateIpEndpoint('192.168.1.20'), true);
  assert.equal(validateIpEndpoint('10.0.0.2:5555'), true);
  assert.equal(validateIpEndpoint('999.0.0.2'), false);
  assert.equal(validateIpEndpoint('10.0.0.2:99999'), false);
  assert.equal(validateIpEndpoint('phone.local; calc.exe'), false);
});

test('builds a shell-free low-latency command argument list', () => {
  const config = sanitizeStreamConfig({
    connection: 'ip',
    address: '192.168.1.20:5555',
    maxSize: 1920,
    maxFps: 60,
    bitRateMbps: 12,
    encoder: 'h264_nvenc',
  });

  assert.deepEqual(buildScrcpyArgs(config), [
    '--reverse-display',
    '--verbosity=debug',
    '--port=27184:27199',
    '--connection=ip:192.168.1.20:5555',
    '--max-size=1920',
    '--max-fps=60',
    '--video-bit-rate=12M',
    '--video-encoder=h264_nvenc',
  ]);
});

test('rejects an invalid direct-IP configuration', () => {
  assert.throws(
    () => sanitizeStreamConfig({ connection: 'ip', address: 'not an ip' }),
    /valid IPv4/,
  );
});

test('wireless mode is TCP/IP only, even with a USB device attached', () => {
  const args = buildScrcpyArgs(sanitizeStreamConfig({ connection: 'wifi' }));
  assert.ok(!args.some((arg) => arg.startsWith('--connection=')));
  assert.ok(args.includes('--select-tcpip'));
  assert.ok(!args.includes('--select-usb'));
});

test('an explicit wireless target avoids duplicate transport ambiguity without incompatible flags', () => {
  const serial = 'adb-test-random._adb-tls-connect._tcp';
  const config = sanitizeStreamConfig({ connection: 'wifi', serial });
  const args = buildScrcpyArgs(config);
  assert.ok(args.includes(`--serial=${serial}`));
  assert.ok(!args.includes('--select-tcpip'));
  assert.ok(!args.some((arg) => arg.startsWith('--connection=')));
  assert.throws(() => sanitizeStreamConfig({ connection: 'wifi', serial: 'USB123' }), /connection method/);
  assert.throws(() => sanitizeStreamConfig({ connection: 'usb', serial }), /connection method/);
  assert.throws(() => sanitizeStreamConfig({ connection: 'wifi', serial: '1.2.3.4:5555; calc' }), /identifier/);
});

test('recognizes automatically connected wireless-debugging devices', () => {
  const [device] = parseAdbDevices('adb-test-random._adb-tls-connect._tcp device model:Pixel_8');
  assert.equal(device.transport, 'Wi-Fi');
  assert.equal(device.authorized, true);
});

test('pairing requires an explicit port and six digits, preserving leading zeros', () => {
  assert.deepEqual(sanitizePairingConfig({ address: ' 192.168.1.20:37895 ', pairingCode: '001234' }), {
    address: '192.168.1.20:37895', pairingCode: '001234',
  });
  for (const address of ['192.168.1.20', '192.168.1.20:0', '192.168.1.20:65536', '1.2.3.4:1234; calc']) {
    assert.throws(() => sanitizePairingConfig({ address, pairingCode: '123456' }));
  }
  for (const pairingCode of ['12345', '1234567', '123\n45', 123456]) {
    assert.throws(() => sanitizePairingConfig({ address: '192.168.1.20:37895', pairingCode }));
  }
});

test('mutation requests reject cross-origin sites and simple form posts', () => {
  const json = { 'content-type': 'application/json' };
  assert.equal(isAllowedMutation(json, 27183), true);
  assert.equal(isAllowedMutation({ ...json, origin: 'http://127.0.0.1:27183' }, 27183), true);
  assert.equal(isAllowedMutation({ ...json, origin: 'http://localhost:5173' }, 27183), true);
  for (const origin of ['https://example.com', 'http://localhost.example.com:27183', 'null', 'http://127.0.0.1:9999']) {
    assert.equal(isAllowedMutation({ ...json, origin }, 27183), false);
  }
  assert.equal(isAllowedMutation({ 'content-type': 'text/plain' }, 27183), false);
});
