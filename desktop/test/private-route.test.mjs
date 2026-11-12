import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateRoute } from '../private-route.mjs';
const status = { BackendState: 'Running', Self: { Online: true, DNSName: 'host.test.ts.net.' }, TailscaleIPs: ['100.64.0.1'] };
const ready = { TCP: { 8443: { HTTPS: true } }, Web: { 'host.test.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:27180' } } } } };
function fixture(serve) {
  const calls = [];
  const route = createPrivateRoute({ fileExists: () => true, execute: async (_file, args) => {
    calls.push(args);
    if (args[0] === 'status') return { stdout: JSON.stringify(status) };
    if (args[1] === 'status') return { stdout: JSON.stringify(serve) };
    serve = ready; return { stdout: '' };
  } });
  return { route, calls, mutations: () => calls.filter(args => args[0] === 'serve' && args[1] !== 'status') };
}
test('route setup needs explicit consent and never overwrites an existing route', async () => {
  const absent = fixture({}); await assert.rejects(absent.route.configure(), /Confirm/); assert.equal(absent.calls.length, 0);
  const conflict = fixture({ TCP: { 8443: { TCPForward: '127.0.0.1:22' } } });
  await assert.rejects(conflict.route.configure({ confirmed: true }), /Another app/); assert.equal(conflict.mutations().length, 0);
  const existing = fixture(ready); assert.equal((await existing.route.configure({ confirmed: true })).ready, true);
  assert.equal(existing.mutations().length, 0);
});
test('consented setup uses private Serve only, then verifies the dedicated route', async () => {
  const f = fixture(null); assert.equal((await f.route.configure({ confirmed: true })).ready, true);
  assert.deepEqual(f.mutations(), [['serve', '--bg', '--https=8443', 'http://127.0.0.1:27180']]);
});
