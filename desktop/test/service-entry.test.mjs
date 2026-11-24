import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('production service IPC carries only role status and rejects malformed presentation state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-role-ipc-'));
  await mkdir(path.join(directory, 'desktop'));
  await mkdir(path.join(directory, 'gui/server'), { recursive: true });
  for (const file of ['service-entry.cjs', 'presentation-state.mjs', 'usb-devices.mjs'])
    await copyFile(path.resolve('desktop', file), path.join(directory, 'desktop', file));
  // Production entry/serializer, fake service effects. No socket, invitation,
  // capture, native input, OS permission or private route is opened.
  await writeFile(path.join(directory, 'gui/server/service.mjs'), `export function createControlService() { return {
    listen: async () => 0, publicState: () => globalThis.fixtureStatus,
    shutdown: async () => {}, shutdownIfIdle: async () => true }; }`);
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    globalThis.fixtureStatus = { running: true, browser: {} };
    globalThis.fetch = async () => new Response(JSON.stringify({ mode:'internet', url:'https://example.invalid', key:'invitation',
      expiresAt:1, status:globalThis.fixtureStatus }));
    process.parentPort = { on: (_event, fn) => parentPort.on('message', data => {
      if (data.fixtureStatus) globalThis.fixtureStatus = data.fixtureStatus;
      fn({data}); }), postMessage: data => parentPort.postMessage(data) };
    require(workerData);`, { eval: true, workerData: path.join(directory, 'desktop/service-entry.cjs') });
  let id = 0;
  const request = (action, fixtureStatus) => new Promise((resolve, reject) => {
    const current = ++id;
    const timeout = setTimeout(() => { worker.off('message', listener); reject(Error('Role IPC timeout')); }, 5000);
    const listener = value => { if (value.id !== current) return; clearTimeout(timeout); worker.off('message', listener); resolve(value); };
    worker.on('message', listener); worker.postMessage({ id: current, action, fixtureStatus });
  });
  try {
    const browser = { waiting:false, connected:true, presentation:true, presentationEnded:true, presentationAvailable:false,
      controllerConnected:true, controllerActive:false, controllerAuthorized:true, privateDiagnostic:'PRIVATE-DIAGNOSTIC' };
    const fixtureStatus = { running:true, browser, nativeInputPermission:'blocked', privateDiagnostic:'PRIVATE-DIAGNOSTIC' };
    const result = await request('status', fixtureStatus);
    assert.deepEqual(result.value, { running:true, browser:{ waiting:false, connected:true, presentation:{ ended:true,
      available:false, controllerConnected:true, controllerActive:false, controllerAuthorized:true } }, nativeInputPermission:'blocked' });
    assert.ok(!JSON.stringify(result).includes('PRIVATE-DIAGNOSTIC'));
    const invitation = await request('invite', fixtureStatus);
    assert.deepEqual(invitation.value.status.browser, result.value.browser);
    assert.ok(!JSON.stringify(invitation).includes('PRIVATE-DIAGNOSTIC'));
    const malformed = await request('status', { running:true, browser:{ ...browser, controllerActive:'PRIVATE-DIAGNOSTIC' } });
    assert.deepEqual(malformed, { id:3, ok:false });
  } finally { await worker.terminate(); await rm(directory, { recursive:true, force:true }); }
});

test('service IPC runs the existing backend on its own ephemeral controller without capture', { skip: process.platform === 'win32' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dskcpy-host-ipc-'));
  const native = path.join(directory, 'fake-host');
  await writeFile(native, '#!/bin/sh\nprintf "%s\\n" "--reverse-display --reverse-socket --reverse-keyboard ScreenCaptureKit/VideoToolbox"\n', { mode: 0o755 });
  const adb = path.join(directory, 'fake-adb'), devices = path.join(directory, 'devices.txt');
  const adbProbe = path.join(directory, 'adb-version-probed');
  await writeFile(devices, 'List of devices attached\nPRIVATE-USB-SERIAL device model:Test_Phone\nprivate-host:5555 device model:Wireless_Peer\n');
  await writeFile(adb, '#!/bin/sh\ncase "$1" in\nversion) echo checked > "$DSKCPY_ADB_PROBE"; printf "%s\\n" "Android Debug Bridge version 1.0.41";;\ndevices) cat "$DSKCPY_USB_FIXTURE";;\n*) exit 7;;\nesac\n', { mode: 0o755 });
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    process.parentPort = { on: (_event, fn) => parentPort.on('message', data => fn({ data })), postMessage: data => parentPort.postMessage(data) };
    const originalFetch=globalThis.fetch;let preparation=0;
    globalThis.fetch=(url,options)=>url.endsWith('/api/browser/prepare')
      ? Promise.resolve(new Response(JSON.stringify({code:++preparation===1?'receiver-port-in-use':'private diagnostic',error:'private diagnostic'}),{status:400}))
      : originalFetch(url,options);
    require(workerData);`, { eval: true,
    workerData: path.resolve('desktop/service-entry.cjs'), env: { ...process.env,
      SCRCPY_GUI_BINARY: native, ADB: adb, DSKCPY_USB_FIXTURE: devices, DSKCPY_ADB_PROBE: adbProbe, DSKCPY_VIEWER_ORIGIN: '',
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
    const network = await request('readiness', { checkAdb: false });
    assert.deepEqual(network.value, { ready: process.platform === 'darwin', keyboard: process.platform === 'darwin',
      clipboard: false, adb: false });
    await assert.rejects(readFile(adbProbe), { code: 'ENOENT' });
    const ready = await request('readiness', { checkAdb: true });
    assert.equal(ready.value.ready, process.platform === 'darwin');
    assert.equal((await readFile(adbProbe, 'utf8')).trim(), 'checked');
    const status = await request('status');
    assert.deepEqual(status.value, { running: false, browser: { waiting: false, connected: false }, nativeInputPermission: null });
    assert.ok(!JSON.stringify(status).includes(directory));
    assert.deepEqual(await request('unknown-command'), { id: 5, ok: false });
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
    const idleClose = await request('shutdown-if-idle');
    assert.equal(idleClose.ok, true); assert.equal(idleClose.value, true);
  } finally { await worker.terminate(); await rm(directory, { recursive: true, force: true }); }
});
