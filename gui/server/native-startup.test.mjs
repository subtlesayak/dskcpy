import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeStartupHistory } from './native-startup.mjs';
const line = phase => `INFO: Reverse startup: ${phase}`;
test('startup facts are ordered, deduplicated and separate from raw/private output', () => {
  let ticks = 0;
  const history = createNativeStartupHistory({ now: () => `time-${++ticks}` }), attempt = history.begin();
  assert.equal(history.snapshot().current.phase, 'host-check');
  for (const phase of ['install-start', 'install-ready', 'launch-start', 'launch-ready', 'socket-wait']) assert.equal(attempt.observe(line(phase)), true);
  for (let n = 0; n < 300; n++) assert.equal(attempt.observe('DEBUG: retry PRIVATE_DEVICE_OR_PATH'), false);
  assert.equal(attempt.observe(line('install-start')), false);
  assert.equal(attempt.observe(line('socket-wait')), false);
  assert.equal(attempt.observe(line('unknown-private-data')), false);
  assert.equal(attempt.observe(line('x'.repeat(1024))), false);
  assert.equal(attempt.observe(line('socket-failed')), true);
  assert.equal(attempt.observe(line('transport-ready')), false);
  attempt.finish();
  const value = history.snapshot();
  assert.equal(value.current.status, 'failed'); assert.equal(value.current.failure, 'socket-failed');
  assert.equal(value.current.events.length, 6); assert.ok(value.current.endedAt);
  assert.ok(!JSON.stringify(value).includes('PRIVATE'));
  value.current.events.length = 0; assert.equal(history.snapshot().current.events.length, 6);
});
test('three earlier retries survive and stale handles cannot change a new attempt', () => {
  const history = createNativeStartupHistory(); let old;
  for (let n = 0; n < 6; n++) {
    const attempt = history.begin({ retry: n > 0 });
    if (old) { assert.equal(old.observe(line('transport-ready')), false); assert.equal(old.finish(), false); }
    attempt.observe(line('launch-ready')); attempt.finish(); old = attempt;
  }
  assert.deepEqual(history.snapshot().previous.map(value => value.attempt), [3, 4, 5]);
  assert.equal(history.snapshot().current.attempt, 6);
  history.begin(); assert.equal(history.snapshot().current.attempt, 1); assert.deepEqual(history.snapshot().previous, []);
  history.clear(); assert.equal(history.snapshot(), null); assert.equal(old.observe(line('install-start')), false);
});
test('connection readiness does not claim video and owner Stop overrides a startup failure', () => {
  const history = createNativeStartupHistory(); let attempt = history.begin();
  assert.ok(attempt.observe('\x1b[32m'+line('socket-ready')+'\x1b[0m'));
  attempt.observe(line('transport-ready'));
  assert.equal(history.snapshot().current.status, 'connected');
  assert.equal(attempt.observe(line('metadata-failed')), false);
  attempt.finish(); assert.equal(history.snapshot().current.status, 'ended');
  attempt = history.begin(); attempt.observe(line('socket-failed')); attempt.finish({ stopped: true });
  assert.equal(history.snapshot().current.status, 'stopped');
  assert.equal(attempt.observe(line('transport-ready')), false);
});
test('old hosts with no phase markers stay unreported; preflight failure is explicit', () => {
  const history = createNativeStartupHistory();
  const attempt = history.begin(); attempt.spawned();
  assert.equal(history.snapshot().current.status, 'unreported');
  attempt.finish(); assert.equal(history.snapshot().current.status, 'unreported');
  assert.equal(history.snapshot().current.failure, null);
  history.begin().finish({ preflight: true });
  assert.equal(history.snapshot().current.status, 'failed'); assert.equal(history.snapshot().current.failure, 'host-check-failed');
});
