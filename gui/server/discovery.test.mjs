import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMdnsServices } from './discovery.mjs';

test('mDNS separates pairing and connection ports and deduplicates advertised endpoints', () => {
  const result = parseMdnsServices(`List of discovered mdns services
phone _adb-tls-pairing._tcp 192.168.1.20:37123
phone _adb-tls-connect._tcp. 192.168.1.20:42123
alias _adb-tls-connect._tcp 192.168.1.20:42123
legacy _adb._tcp 10.0.0.20:5555`);
  assert.deepEqual(result.map(({ kind, address }) => ({ kind, address })), [
    { kind: 'connect', address: '192.168.1.20:42123' },
    { kind: 'legacy', address: '10.0.0.20:5555' },
    { kind: 'pairing', address: '192.168.1.20:37123' },
  ]);
});

test('mDNS ignores malformed, public, loopback and overlay endpoints and caps results', () => {
  const endpoints = ['127.0.0.1:1234', '100.64.0.2:1234', '8.8.8.8:1234', '0.0.0.0:1',
    '192.168.001.2:12', '192.168.1.2:0', '192.168.1.2:65536', '[::1]:1234', 'phone.local:1234',
    '192.168.1.2:1234;calc', '192.168.1.2'];
  assert.deepEqual(parseMdnsServices(endpoints.map((address) => `x _adb._tcp ${address}`).join('\n')), []);
  assert.deepEqual(parseMdnsServices('x _http._tcp 192.168.1.2:80'), []);
  assert.equal(parseMdnsServices(Array.from({ length: 100 }, (_, n) => `phone${n} _adb._tcp 10.0.0.1:${n + 1}`).join('\n')).length, 64);
});
