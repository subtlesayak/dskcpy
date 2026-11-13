import test from 'node:test';
import assert from 'node:assert/strict';
import { UsbDevices } from '../usb-devices.mjs';
const phone = (serial, state = 'device', transport = 'USB') => ({ serial, state, transport, authorized: state === 'device', model: 'Test phone' });
test('USB handles filter wireless peers, hide serials and remain stable only while present', () => {
  const usb = new UsbDevices(), devices = [phone('PRIVATE-SERIAL'), phone('WIFI-PEER', 'device', 'Wi-Fi'), phone('emulator-5554')];
  const first = usb.update(devices); assert.equal(first.length, 1); assert.match(first[0].id, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(first).includes('PRIVATE-SERIAL')); assert.ok(!JSON.stringify(first).includes('WIFI-PEER'));
  assert.equal(usb.update(devices)[0].id, first[0].id); assert.equal(usb.resolve(first[0].id, devices), 'PRIVATE-SERIAL');
  usb.update([]); assert.throws(() => usb.resolve(first[0].id, devices));
  assert.notEqual(usb.update(devices)[0].id, first[0].id);
});
test('stale handles and unauthorized/offline phones cannot select an ADB target', () => {
  const usb = new UsbDevices(), devices = [phone('one'), phone('two', 'unauthorized'), phone('three', 'offline')];
  const list = usb.update(devices); assert.deepEqual(list.map(d => d.state), ['ready', 'unauthorized', 'offline']);
  for (const id of [list[1].id, list[2].id, 'one', 'x'.repeat(32), null]) assert.throws(() => usb.resolve(id, devices));
  assert.throws(() => usb.resolve(list[0].id, [phone('one', 'unauthorized')]));
  assert.throws(() => usb.resolve(list[0].id, [phone('one', 'device', 'Wi-Fi')]));
});
