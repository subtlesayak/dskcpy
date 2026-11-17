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
  const adb = path.join(directory, 'fake-adb'), devices = path.join(directory, 'devices.txt');
  await writeFile(devices, 'List of devices attached\nPRIVATE-USB-SERIAL device model:Test_Phone\nprivate-host:5555 device model:Wireless_Peer\n');
  await writeFile(adb, '#!/bin/sh\ncase "$1" in\nversion) printf "%s\\n" "Android Debug Bridge version 1.0.41";;\ndevices) cat "$DSKCPY_USB_FIXTURE";;\n*) exit 7;;\nesac\n', { mode: 0o755 });
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    process.parentPort = { on: (_event, fn) => parentPort.on('message', data => fn({ data })), postMessage: data => parentPort.postMessage(data) };
    const originalFetch=globalThis.fetch;let preparation=0;
    globalThis.fetch=(url,options)=>url.endsWith('/api/browser/prepare')
      ? Promise.resolve(new Response(JSON.stringify({code:++preparation===1?'receiver-port-in-use':'private diagnostic',error:'private diagnostic'}),{status:400}))
      : originalFetch(url,options);
    require(workerData);`, { eval: true,
    workerData: path.resolve('desktop/service-entry.cjs'), env: { ...process.env,
      SCRCPY_GUI_BINARY: native, ADB: adb, DSKCPY_USB_FIXTURE: devices, DSKCPY_VIEWER_ORIGIN: '',
      DSKCPY_VIEWER_TLS_CERT: '', DSKCPY_VIEWER_TLS_KEY: '' } });
  let sequence = 0;
  function request(action, args) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { worker.off('message', listener); reject(Error('IPC timeout')); }, 8000);
      const listener = message => { if (message.id !== id) return; clearTimeout(timeout); worker.off('message', listener); resolve(message); };
      worker.on('message', listener); worker.postMessage({ id, action, args });
    });
  }
  try {
    assert.equal((await request('ready')).ok, true);
    const ready = await request('readiness'); assert.equal(ready.value.ready, process.platform === 'darwin');
    const status = await request('status');
    assert.deepEqual(status.value, { running: false, browser: { waiting: false, connected: false }, nativeInputPermission: null });
    assert.ok(!JSON.stringify(status).includes(directory));
    assert.deepEqual(await request('unknown-command'), { id: 4, ok: false });
    assert.equal(ready.value.adb, true);
    const usb = await request('usb-devices'); assert.equal(usb.ok, true);
    assert.equal(usb.value.devices.length, 1); assert.equal(usb.value.devices[0].name, 'Test Phone');
    assert.ok(!JSON.stringify(usb).includes('PRIVATE-USB-SERIAL')); assert.ok(!JSON.stringify(usb).includes('private-host'));
    assert.equal((await request('invite', { mode: 'usb', device: 'PRIVATE-USB-SERIAL' })).ok, false, 'serials are not renderer selection handles');
    await writeFile(devices, 'List of devices attached\nPRIVATE-USB-SERIAL unauthorized model:Test_Phone\n');
    assert.equal((await request('invite', { mode: 'usb', device: usb.value.devices[0].id })).ok, false, 'authorization must still exist at Start');
    assert.equal((await request('invite', { mode: 'invalid' })).ok, false);
    assert.deepEqual((await request('status')).value, { running: false, browser: { waiting: false, connected: false }, nativeInputPermission: null });
    const conflict=await request('prepare-receiver');assert.equal(conflict.ok,false);assert.equal(conflict.code,'receiver-port-in-use');
    assert.ok(!JSON.stringify(conflict).includes('private diagnostic'));
    const unknown=await request('prepare-receiver');assert.equal(unknown.ok,false);assert.equal(unknown.code,undefined);
    assert.equal((await request('shutdown')).ok, true);
  } finally { await worker.terminate(); await rm(directory, { recursive: true, force: true }); }
});
