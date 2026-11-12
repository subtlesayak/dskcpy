import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('service IPC runs the existing backend on its own ephemeral controller without capture', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-host-ipc-'));
  const native = path.join(directory, 'fake-host');
  await writeFile(native, '#!/bin/sh\nprintf "%s\\n" "--reverse-display --reverse-socket --reverse-keyboard ScreenCaptureKit/VideoToolbox"\n', { mode: 0o755 });
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    process.parentPort = { on: (_event, fn) => parentPort.on('message', data => fn({ data })), postMessage: data => parentPort.postMessage(data) };
    require(workerData);`, { eval: true,
    workerData: path.resolve('desktop/service-entry.cjs'), env: { ...process.env,
      SCRCPY_GUI_BINARY: native, ADB: path.join(directory, 'no-adb'), DSKCPY_VIEWER_ORIGIN: '',
      DSKCPY_VIEWER_TLS_CERT: '', DSKCPY_VIEWER_TLS_KEY: '' } });
  let sequence = 0;
  function request(action) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.off('message', listener); reject(Error('IPC timeout')); }, 8000);
      const listener = message => { if (message.id !== id) return; clearTimeout(timeout); worker.off('message', listener); resolve(message); };
      worker.on('message', listener); worker.postMessage({ id, action });
    });
  }
  try {
    assert.equal((await request('ready')).ok, true);
    const ready = await request('readiness'); assert.equal(ready.value.ready, process.platform === 'darwin');
    const status = await request('status');
    assert.deepEqual(status.value, { running: false, browser: { waiting: false, connected: false } });
    assert.ok(!JSON.stringify(status).includes(directory));
    assert.deepEqual(await request('unknown-command'), { id: 4, ok: false });
    assert.equal((await request('shutdown')).ok, true);
  } finally { await worker.terminate(); await rm(directory, { recursive: true, force: true }); }
});
