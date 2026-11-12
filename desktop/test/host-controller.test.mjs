import test from 'node:test';
import assert from 'node:assert/strict';
import { HostController, hostPhase, validateInvitation } from '../host-controller.mjs';
import { inspectPrivateRoute } from '../private-route.mjs';

const blank = () => ({ running: false, browser: { waiting: false, connected: false } });
function fixture() {
  let status = blank(), invites = 0, stops = 0, closed = 0, ready = true;
  const setup = { permissions: { screen: true, control: true }, runtimeReady: true,
    route: { connected: true, ready: true, origin: 'https://host.test.ts.net:8443' } };
  const backend = { status: async () => status,
    invite: async () => { invites++; status = { running: false, browser: { waiting: true, connected: false } };
      return { mode: 'internet', url: setup.route.origin + '/', key: 'a'.repeat(32), expiresAt: 301000, status }; },
    stop: async () => { stops++; status = blank(); }, shutdown: async () => { closed++; } };
  const host = new HostController({ backend, checkSetup: async () => ({ ...setup, runtimeReady: ready }), now: () => 1000 });
  return { host, backend, setup, setStatus: next => { status = next; }, counts: () => ({ invites, stops, closed }), setReady: next => { ready = next; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('one start produces a single private invitation; repeated clicks never replace it', async () => {
  const f = fixture(); await Promise.all([f.host.start(), f.host.start()]); await f.host.start();
  assert.equal(f.counts().invites, 1); assert.equal(f.host.snapshot().phase, 'inviting');
  assert.match(f.host.snapshot().invitation.joinUrl, /^https:\/\/host.test.ts.net:8443\/join\/[a-f0-9]{32}#connect=/);
});
test('beginner setup identifies the next missing step without starting capture', async () => {
  for (const [change, expected] of [
    [{ runtimeReady: false }, 'installation'], [{ permissions: { screen: false, control: true } }, 'screen-permission'],
    [{ permissions: { screen: true, control: false } }, 'control-permission'],
    [{ route: { connected: false } }, 'network'], [{ route: { connected: true, ready: false } }, 'private-link'],
  ]) {
    const f = fixture(); Object.assign(f.setup, change); if (change.runtimeReady === false) f.setReady(false);
    await f.host.start(); assert.equal(f.host.snapshot().phase, expected); assert.equal(f.counts().invites, 0);
  }
});
test('an existing owned stream remains visible and stoppable even if later setup checks fail', async () => {
  const f = fixture(); f.setStatus({ running: true, browser: { connected: true } });
  f.setup.permissions.screen = false; await f.host.refresh({ setup: true }); await f.host.start();
  assert.equal(f.host.snapshot().phase, 'sharing'); assert.equal(f.host.snapshot().canStop, true); assert.equal(f.counts().stops, 0);
});
test('stop during asynchronous setup cannot create a late invitation', async () => {
  const f = fixture(); let finish; f.host.checkSetup = () => new Promise(resolve => { finish = resolve; });
  const starting = f.host.start(); await tick(); await f.host.stop(); finish(f.setup); await starting;
  assert.equal(f.counts().invites, 0); assert.equal(f.host.snapshot().canStop, false);
});
test('invitation and its credential disappear once connected or expired', async () => {
  const f = fixture(); await f.host.start(); f.setStatus({ running: true, browser: { connected: true } }); await f.host.refresh();
  assert.equal(f.host.invitation, null); assert.ok(!JSON.stringify(f.host.snapshot()).includes('a'.repeat(32)));
  const expired = fixture(); await expired.host.start(); expired.host.now = () => 302000; await expired.host.refresh();
  assert.equal(expired.host.invitation, null);
});
test('failed invitation preparation is cancelled and private diagnostics do not reach the UI', async () => {
  const f = fixture(); f.backend.invite = async () => { throw Error('PRIVATE-PATH-AND-KEY'); }; await f.host.start();
  assert.equal(f.counts().stops, 1); assert.equal(f.host.snapshot().phase, 'error'); assert.ok(!JSON.stringify(f.host.snapshot()).includes('PRIVATE'));
});
test('quit retires an in-flight start and shuts down only the injected owned backend', async () => {
  const f = fixture(); let finish; f.backend.invite = () => new Promise(resolve => { finish = resolve; });
  const starting = f.host.start(); await tick(); await f.host.close();
  finish({ mode: 'internet', url: f.setup.route.origin + '/', key: 'a'.repeat(32), expiresAt: 301000 }); await starting;
  assert.equal(f.host.invitation, null); assert.equal(f.counts().closed, 1);
});
test('connection addresses cannot smuggle another origin or persisted credential', () => {
  const base = { mode: 'internet', key: 'a'.repeat(32), expiresAt: 301000 };
  for (const url of ['http://host.test.ts.net/', 'https://other.test.ts.net/', 'https://host.test.ts.net:8443/?key=private', 'https://user@host.test.ts.net:8443/']) {
    assert.throws(() => validateInvitation({ ...base, url }, 'https://host.test.ts.net:8443', 1000));
  }
});
test('real backend ISO expiry is accepted; expired and unbounded invitations reject', () => {
  const base = { mode: 'internet', key: 'a'.repeat(32), url: 'https://host.test.ts.net:8443/' };
  assert.equal(validateInvitation({ ...base, expiresAt: new Date(301000).toISOString() }, 'https://host.test.ts.net:8443', 1000).expiresAt, 301000);
  for (const expiresAt of [null, 'invalid', new Date(999).toISOString(), new Date(999999).toISOString()])
    assert.throws(() => validateInvitation({ ...base, expiresAt }, 'https://host.test.ts.net:8443', 1000));
});
test('private setup requires a dedicated private origin and preserves conflicting routes', () => {
  const status = { BackendState: 'Running', Self: { Online: true, DNSName: 'host.test.ts.net.' }, TailscaleIPs: ['100.64.0.1'] };
  const good = { TCP: { 8443: { HTTPS: true } }, Web: { 'host.test.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:27180' } } } } };
  assert.equal(inspectPrivateRoute(status, good).ready, true);
  for (const bad of [
    { TCP: { 8443: { TCPForward: '127.0.0.1:22' } } },
    { Web: { 'host.test.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } },
    { ...good, AllowFunnel: { 'host.test.ts.net:8443': true } },
    { Web: { 'host.test.ts.net:8443': { Handlers: { ...good.Web['host.test.ts.net:8443'].Handlers, '/other': { Proxy: 'http://127.0.0.1:9999' } } } } },
  ]) { const result = inspectPrivateRoute(status, bad); assert.equal(result.ready, false); assert.equal(result.conflict, true); }
  assert.equal(hostPhase({ status: blank(), runtimeReady: true, permissions: { screen: true, control: true }, route: { connected: true, conflict: true } }), 'route-conflict');
});
