// Real Electron utility-process IPC with a fixed fake service. No native host,
// listeners, invitations, permission API, capture or desktop input is started.
const assert = require('node:assert/strict');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');

module.exports = async function checkOwnedLifecycle(OwnedBackend, fork, directory) {
  const modulePath = path.join(directory, 'owned-lifecycle-service.cjs');
  await writeFile(modulePath, `
    setInterval(() => {}, 1000);
    let active = false;
    process.parentPort.on('message', ({ data }) => {
      const value = data.action === 'status' ? { running: active, browser: {} }
        : data.action === 'shutdown-if-idle' ? !active : true;
      if (data.action === 'status' && process.env.DSKCPY_TEST_INCOMING_ON_STATUS === '1') active = true;
      process.parentPort.postMessage({ id: data.id, ok: true,
        value });
    });
  `);
  const route = { origin: '', bind: '127.0.0.1' };
  const next = { origin: '', bind: '127.0.0.2' };
  const counts = [];
  for (const scenario of ['concurrent-setup', 'quit-during-setup', 'incoming-after-idle']) {
    const live = new Set(); let created = 0;
    const backend = new OwnedBackend({ modulePath, environment: scenario === 'incoming-after-idle' ? { DSKCPY_TEST_INCOMING_ON_STATUS: '1' } : {}, fork(module, args, options) {
      const child = fork(module, args, options); ++created; live.add(child);
      child.once('exit', () => live.delete(child)); return child;
    } });
    try {
      await backend.ensure(route);
      if (scenario === 'concurrent-setup') {
        await Promise.all([backend.ensure(next), backend.ensure(next)]);
        assert.equal(created, 2, 'Concurrent setup creates one replacement');
      } else if (scenario === 'quit-during-setup') {
        await Promise.allSettled([backend.ensure(next), backend.shutdown()]);
        assert.equal(created, 1, 'Quit vetoes replacement before fork');
      } else {
        const owner = backend.child;
        await assert.rejects(backend.ensure(next), /Stop this app/);
        assert.equal(created, 1); assert.equal(backend.child, owner);
        assert.equal(live.has(owner), true, 'Incoming session retains its owner');
      }
      await Promise.all([backend.shutdown(), backend.shutdown()]);
      assert.equal(backend.child, null);
      await assert.rejects(backend.ensure(route), /Host closed/);
      counts.push(created);
    } finally {
      await backend.shutdown().catch(() => {});
      // Only handles created by this test, including any orphan under a
      // regression. Never discover or terminate a process by name or port.
      for (const child of live) child.kill();
      const deadline = Date.now() + 5000;
      while (live.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(live.size, 0, 'All fixed fake services exited');
    }
  }
  return { realUtilityLifecycleIpc: true, createdPerScenario: counts,
    lifecycleWorkersAreFixedFakes: true, lifecycleNativeProgramStarted: false };
};
