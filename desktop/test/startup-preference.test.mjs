import test from 'node:test';
import assert from 'node:assert/strict';
import { StartupPreference } from '../startup-preference.mjs';
function fixture(platform = 'darwin', available = true) {
  let raw = { openAtLogin: false, status: 'not-registered' }; const reads = [], writes = [];
  const startup = new StartupPreference({ platform, available, executable: 'C:\\Program Files\\dskcpy\\Host.exe',
    read: options => { reads.push(options); return raw; },
    write: options => { writes.push(options); raw = { ...raw, openAtLogin: options.openAtLogin, status: options.openAtLogin ? 'enabled' : 'not-registered' }; } });
  return { startup, reads, writes, raw: value => { raw = value; } };
}
test('startup reads never enroll a user or change OS preferences', () => {
  const f = fixture(); f.startup.refresh(); f.startup.refresh();
  assert.equal(f.startup.snapshot().requested, false); assert.equal(f.writes.length, 0);
  for (const invalid of ['true', 1, null, {}, undefined]) assert.throws(() => f.startup.set(invalid));
  assert.equal(f.writes.length, 0);
});
test('explicit startup opt-in and opt-out use the same fixed application identity', () => {
  for (const platform of ['darwin', 'win32']) {
    const f = fixture(platform); assert.equal(f.startup.set(true).enabled, true);
    assert.equal(f.startup.set(false).requested, false);
    const expected = platform === 'win32' ? { path: 'C:\\Program Files\\dskcpy\\Host.exe', args: ['--background'] } : { type: 'mainAppService' };
    assert.deepEqual(f.writes, [{ ...expected, openAtLogin: true }, { ...expected, openAtLogin: false }]);
    assert.deepEqual(f.reads, [expected, expected]);
  }
});
test('an unpackaged or uninstalled app cannot register itself at startup', () => {
  const f = fixture('darwin', false); f.startup.refresh();
  assert.throws(() => f.startup.set(true), /Install/); assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0);
});
test('OS approval, disabled Windows startup and ignored writes are not reported as enabled', () => {
  const mac = fixture(); mac.raw({ openAtLogin: true, status: 'requires-approval', wasOpenedAtLogin: true });
  assert.deepEqual(mac.startup.refresh(), { available: true, requested: true, enabled: false, requiresApproval: true, wasOpenedAtLogin: true, error: null });
  mac.raw({ openAtLogin: true, status: 'not-found' }); assert.equal(mac.startup.refresh().enabled, false);
  const win = fixture('win32'); win.raw({ openAtLogin: true, executableWillLaunchAtLogin: false }); assert.equal(win.startup.refresh().enabled, false);
  const ignored = fixture(); ignored.startup.write = () => {};
  assert.match(ignored.startup.set(true).error, /did not save/); assert.equal(ignored.startup.snapshot().enabled, false);
});
test('OS failure messages cannot expose paths or secrets in the UI', () => {
  const f = fixture(); f.startup.write = () => { throw Error('PRIVATE-PATH-SECRET'); };
  assert.match(f.startup.set(true).error, /could not be changed/);
  assert.ok(!JSON.stringify(f.startup.snapshot()).includes('PRIVATE'));
  f.startup.write = () => {}; f.startup.refresh(); assert.equal(f.startup.snapshot().error, null);
});
