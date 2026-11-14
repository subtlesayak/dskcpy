import test from 'node:test';
import assert from 'node:assert/strict';
import { HostController, hostPhase, validateInvitation } from '../host-controller.mjs';
import { inspectPrivateRoute } from '../private-route.mjs';

const blank = () => ({ running: false, browser: { waiting: false, connected: false } });
function fixture() {
  let status = blank(), invites = 0, stops = 0, closed = 0, ready = true;
  const setup = { permissions: { screen: true, control: true }, runtimeReady: true,
    route: { connected: true, ready: true, origin: 'https://host.test.ts.net:8443' } };
  const backend = { prepareReceiver: async () => ({ url: setup.route.origin + '/', instance: 'c'.repeat(32) }), status: async () => status,
    invite: async () => { invites++; status = { running: false, browser: { waiting: true, connected: false } };
      return { mode: 'internet', url: setup.route.origin + '/', key: 'a'.repeat(32), expiresAt: 301000, status }; },
    stop: async () => { stops++; status = blank(); }, shutdown: async () => { closed++; } };
  const host = new HostController({ backend, probeReceiver: async () => ({ ready: true }), checkSetup: async () => ({ ...setup, runtimeReady: ready }), now: () => 1000 });
  return { host, backend, setup, setStatus: next => { status = next; }, counts: () => ({ invites, stops, closed }), setReady: next => { ready = next; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('receiver port conflict explains recovery without stopping or inviting', async () => {
  const f=fixture();f.backend.prepareReceiver=async()=>{throw Object.assign(Error('private diagnostic'),{code:'receiver-port-in-use'});};
  await f.host.start();
  assert.match(f.host.snapshot().error,/already using the receiver connection/);
  assert.match(f.host.snapshot().error,/Keep using it/);
  assert.ok(!f.host.snapshot().error.includes('private diagnostic'));
  assert.equal(f.counts().stops,0);assert.equal(f.counts().invites,0);
});

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

function usbFixture(devices = [{ id: 'b'.repeat(32), name: 'Test phone', state: 'ready' }]) {
  const f = fixture(); let invited;
  f.setup.usb = { available: true, error: false, devices };
  f.setup.route = { connected: false, ready: false };
  f.backend.invite = async args => { invited = args;
    return { mode: 'usb', url: 'http://127.0.0.1:27180/', key: 'a'.repeat(32), expiresAt: 301000, openedOnPhone: true,
      status: { running: false, browser: { waiting: true, connected: false } } }; };
  return { ...f, invited: () => invited };
}
test('USB setup works without a private route and asks the utility to auto-open the selected phone', async () => {
  const f = usbFixture(); await f.host.setConnection('usb');
  assert.equal(f.host.snapshot().phase, 'ready'); assert.equal(f.invited(), undefined);
  await f.host.start();
  assert.deepEqual(f.invited(), { mode: 'usb', device: 'b'.repeat(32) });
  assert.equal(f.host.snapshot().phase, 'inviting'); assert.equal(f.host.snapshot().invitation.openedOnPhone, true);
  assert.match(f.host.snapshot().invitation.joinUrl, /^http:\/\/127.0.0.1:27180\/join\//);
  await f.host.setConnection('internet'); assert.equal(f.host.connection, 'usb', 'an owned invitation cannot be reconfigured');
});
test('USB setup distinguishes missing tool, cable, authorization, enumeration failure and selection', async () => {
  for (const [usb, phase] of [
    [{ available: false }, 'usb-tool'], [{ available: true, devices: [] }, 'usb-device'],
    [{ available: true, error: true }, 'usb-device'],
    [{ available: true, devices: [{ id: '1', state: 'unauthorized' }] }, 'usb-authorize'],
    [{ available: true, devices: [{ id: '1', state: 'offline' }] }, 'usb-device'],
    [{ available: true, devices: [{ id: '1', state: 'ready' }, { id: '2', state: 'ready' }] }, 'usb-select'],
  ]) {
    const f = usbFixture(); Object.assign(f.setup.usb, usb); await f.host.setConnection('usb'); await f.host.start();
    assert.equal(f.host.snapshot().phase, phase); assert.equal(f.invited(), undefined);
  }
});
test('USB selection is explicit for multiple phones and invalidated when the selected phone disappears', async () => {
  const f = usbFixture([{ id: '1', state: 'ready' }, { id: '2', state: 'ready' }, { id: '3', state: 'unauthorized' }]);
  await f.host.setConnection('usb'); assert.throws(() => f.host.selectUsbDevice('3'));
  f.host.selectUsbDevice('2'); assert.equal(f.host.snapshot().phase, 'ready');
  f.setup.usb.devices = [{ id: '1', state: 'ready' }, { id: '4', state: 'ready' }];
  await f.host.start(); assert.equal(f.host.snapshot().phase, 'usb-select'); assert.equal(f.invited(), undefined);
});
test('USB invitation validation never accepts a network address, credentials or mismatched mode', () => {
  const base = { mode: 'usb', key: 'a'.repeat(32), expiresAt: 301000 };
  for (const url of ['http://localhost:27180/', 'http://127.0.0.1:9999/', 'https://host.test/', 'http://127.0.0.1:27180/?secret=x', 'http://user@127.0.0.1:27180/'])
    assert.throws(() => validateInvitation({ ...base, url }, new URL(url).origin, 1000, 'usb'));
  assert.throws(() => validateInvitation({ ...base, mode: 'internet', url: 'http://127.0.0.1:27180/' }, 'http://127.0.0.1:27180', 1000, 'usb'));
});
test('cancelling USB setup invalidates delayed enumeration and never creates an invitation', async () => {
  const f = usbFixture(); await f.host.setConnection('usb'); let release;
  f.host.checkSetup = () => new Promise(resolve => { release = resolve; });
  const start = f.host.start(); await tick(); await f.host.stop(); release(f.setup); await start;
  assert.equal(f.invited(), undefined); assert.equal(f.host.snapshot().canStop, false);
});
test('a selected phone disappearing cannot silently redirect Start to the only remaining phone', async () => {
  const f = usbFixture([{ id: '1', state: 'ready' }, { id: '2', state: 'ready' }]);
  await f.host.setConnection('usb'); f.host.selectUsbDevice('1');
  f.setup.usb.devices = [{ id: '2', state: 'ready' }];
  await f.host.start(); assert.equal(f.invited(), undefined); assert.equal(f.host.snapshot().phase, 'usb-select');
  await f.host.start(); assert.equal(f.invited(), undefined, 'a second Start cannot clear the target-loss latch');
  f.host.selectUsbDevice('2'); await f.host.start(); assert.deepEqual(f.invited(), { mode: 'usb', device: '2' });
});

test('clipboard is off by default, explicit per invitation and cleared by Stop or a target change', async () => {
  const f=fixture();f.setup.features={keyboard:true,clipboard:true};await f.host.refresh({setup:true});
  assert.equal(f.host.snapshot().clipboardAllowed,false);assert.throws(()=>f.host.setClipboardAllowed('true'));
  f.host.setClipboardAllowed(true);assert.equal(f.host.snapshot().clipboardAllowed,true);
  let args;const invite=f.backend.invite;f.backend.invite=async next=>{args=next;return invite(next);};
  await f.host.start();assert.equal(args.clipboard,true);f.host.setClipboardAllowed(false);assert.equal(f.host.snapshot().clipboardAllowed,true,'an owned session cannot be reconfigured');
  await f.host.stop();assert.equal(f.host.snapshot().clipboardAllowed,false);
  f.host.setClipboardAllowed(true);await f.host.setConnection('usb');assert.equal(f.host.snapshot().clipboardAllowed,false);
});
test('an old native host cannot be opted into clipboard by the desktop IPC', async () => {
  const f=fixture();await f.host.refresh({setup:true});f.host.setClipboardAllowed(true);assert.equal(f.host.snapshot().clipboardAllowed,false);
});

test('private link is checked against the owned backend before any invitation is created', async () => {
  const f = fixture(); let release; f.host.probeReceiver = (descriptor, origin, options) => {
    assert.equal(descriptor.instance, 'c'.repeat(32)); assert.equal(origin, f.setup.route.origin); assert.ok(options.signal);
    return new Promise(resolve => { release = resolve; });
  };
  const start = f.host.start(); await tick();
  assert.equal(f.host.snapshot().phase, 'checking-link'); assert.equal(f.host.snapshot().canStop, true);
  assert.equal(f.host.snapshot().invitation, null); assert.equal(f.counts().invites, 0);
  assert.ok(!JSON.stringify(f.host.snapshot()).includes('c'.repeat(32)));
  release({ ready: true }); await start; assert.equal(f.counts().invites, 1); assert.equal(f.host.snapshot().phase, 'inviting');
});
test('failed private probes create no invitation, expose actionable fixed guidance and never stop an existing service', async () => {
  for (const reason of ['certificate', 'name', 'response', 'timeout', 'PRIVATE RAW ERROR']) {
    const f = fixture(); f.host.probeReceiver = async () => ({ ready: false, reason }); await f.host.start();
    assert.equal(f.counts().invites, 0); assert.equal(f.counts().stops, 0); assert.equal(f.host.snapshot().phase, 'error'); assert.equal(f.host.snapshot().route.verified, false);
    assert.match(f.host.snapshot().error, /try again/); assert.ok(!f.host.snapshot().error.includes('PRIVATE')); assert.equal(f.host.snapshot().canStop, false);
  }
});
test('Cancel or Quit during a pending private-link check prevents a late invitation', async () => {
  for (const action of ['stop', 'close']) {
    const f = fixture(); let finish, signal; f.host.probeReceiver = (_descriptor, _origin, options) => {
      signal = options.signal; return new Promise(resolve => { finish = resolve; });
    };
    const start = f.host.start(); await tick(); await f.host[action](); assert.equal(signal.aborted, true);
    finish({ ready: true }); await start; assert.equal(f.counts().invites, 0); assert.equal(f.host.invitation, null);
  }
});
test('remembered receiver connecting during a probe is preserved even when the local check fails', async () => {
  const f = fixture(); f.host.probeReceiver = async () => {
    f.setStatus({ running: true, browser: { waiting: false, connected: true } }); return { ready: false, reason: 'timeout' };
  };
  await f.host.start(); assert.equal(f.host.snapshot().phase, 'sharing'); assert.equal(f.counts().stops, 0); assert.equal(f.counts().invites, 0); assert.equal(f.host.snapshot().error, null);
});
test('USB never prepares or probes a private receiver address', async () => {
  const f = usbFixture(); f.backend.prepareReceiver = () => { throw Error('unexpected network preparation'); };
  f.host.probeReceiver = () => { throw Error('unexpected network access'); };
  await f.host.setConnection('usb'); await f.host.start(); assert.equal(f.host.snapshot().phase, 'inviting');
});

test('a remembered receiver winning the final invitation race is not stopped by Start failure', async () => {
  const f = fixture(); f.backend.invite = async () => {
    f.setStatus({ running: true, browser: { waiting: false, connected: true } }); throw Error('already connected');
  };
  await f.host.start(); assert.equal(f.host.snapshot().phase, 'sharing'); assert.equal(f.counts().stops, 0); assert.equal(f.host.snapshot().error, null);
});
test('a pending remembered connection found during preparation is preserved without inventing a QR', async () => {
  const f = fixture(); f.backend.prepareReceiver = async () => {
    f.setStatus({ running: false, browser: { waiting: true, connected: false } }); throw Error('already waiting');
  };
  await f.host.start(); assert.equal(f.host.snapshot().phase, 'inviting'); assert.equal(f.host.snapshot().invitation, null); assert.equal(f.counts().stops, 0); assert.equal(f.counts().invites, 0);
});
