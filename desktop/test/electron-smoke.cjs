// Invoked only by run-electron-smoke.mjs. A hidden renderer with synthetic UI
// state plus a real utility service using a fake --help-only native program.
// It never loads main.cjs, starts capture, creates an invitation, calls an OS
// permission API, opens Tailscale, writes the clipboard, or touches a live host.
const { app, BrowserWindow, ipcMain, utilityProcess, session } = require('electron');
const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const configPath = process.argv.find(value => value.startsWith('--smoke-config='))?.slice('--smoke-config='.length);
if (!configPath) throw new Error('A smoke configuration is required');
const config = require(configPath);
app.setName('dskcpy isolated runtime check');
app.setPath('userData', path.join(config.ownedDirectory, 'user-data'));
app.disableHardwareAcceleration();
let window, backend, stage = 'app-ready';
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  app.dock?.hide();
  // Even accidental external renderer requests remain blocked in this fixture.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const { OwnedBackend } = await import(pathToFileURL(path.join(config.application, 'desktop/owned-backend.mjs')).href);
  backend = new OwnedBackend({ fork: utilityProcess.fork,
    modulePath: path.join(config.application, 'desktop/service-entry.cjs'),
    environment: { ...process.env, SCRCPY_GUI_BINARY: config.fakeNative,
      ADB: path.join(config.ownedDirectory, 'absent-adb'), DSKCPY_VIEWER_ORIGIN: '',
      DSKCPY_TRUST_STORE: path.join(config.ownedDirectory, 'synthetic-device-registry.json'),
      DSKCPY_VIEWER_TLS_CERT: '', DSKCPY_VIEWER_TLS_KEY: '' } });
  stage = 'utility-start'; await backend.ensure({});
  stage = 'utility-readiness';
  const readiness = await backend.readiness();
  assert.equal(readiness.ready, ['darwin', 'win32'].includes(process.platform));
  assert.equal(readiness.adb, false);
  assert.equal(readiness.clipboard, false);
  assert.deepEqual(await backend.usbDevices(), { devices: [], error: true });
  stage = 'utility-idle';
  assert.deepEqual(await backend.status(), { running: false, browser: { waiting: false, connected: false } });
  let state = { phase: 'ready', features: { keyboard: true }, permissions: { screen: true, control: true },
    route: { connected: true, ready: true, conflict: false }, startup: { available: true, requested: false, enabled: false, requiresApproval: false, error: null }, error: null, invitation: null, canStop: false };
  const page = pathToFileURL(path.join(config.application, 'gui/dist-desktop/desktop/index.html')).href;
  window = new BrowserWindow({ show: false, skipTaskbar: true, width: 620, height: 740,
    webPreferences: { preload: path.join(config.application, 'desktop/preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const errors = []; window.webContents.on('preload-error', () => errors.push('preload failure'));
  function handle(name, callback) {
    ipcMain.handle(`host:${name}`, (event, ...args) => {
      assert.equal(event.sender, window.webContents); assert.equal(event.senderFrame, window.webContents.mainFrame);
      assert.equal(event.senderFrame.url, page); return callback(...args);
    });
  }
  handle('snapshot', () => state);
  handle('trusted-list', () => backend.request('trusted-list'));
  handle('trusted-action', (action, id) => {
    assert.equal(action, 'pause'); assert.equal(id, undefined);
    return backend.request('trusted-action', { action });
  });
  handle('connection', connection => {
    assert.ok(['internet', 'usb'].includes(connection)); state = { ...state, connection, phase: connection === 'usb' ? 'usb-device' : 'ready', usb: { available: true, error: false, selected: null, devices: [] } };
    window.webContents.send('host:changed', state); return state;
  });
  handle('clipboard-allowed', allowed => { assert.equal(typeof allowed,'boolean'); return state; });
  handle('usb-device', id => { assert.equal(id, 'synthetic'); return state; });
  handle('start', () => {
    state = { ...state, phase: 'inviting', canStop: true, invitation: {
      joinUrl: 'https://example.invalid/join/synthetic#connect=synthetic-test-only', expiresAt: Date.now() + 300000 } };
    window.webContents.send('host:changed', state); return state;
  });
  handle('stop', () => { state = { ...state, phase: 'ready', canStop: false, invitation: null };
    window.webContents.send('host:changed', state); return state; });
  handle('copy-invitation', () => true);
  handle('set-open-at-login', enabled => {
    assert.equal(typeof enabled, 'boolean'); state.startup = { ...state.startup, requested: enabled, enabled };
    window.webContents.send('host:changed', state); return state.startup;
  });
  stage = 'renderer-load'; await window.loadURL(page);
  stage = 'renderer-actions';
  const check = await window.webContents.executeJavaScript(`(async () => {
    if (typeof require !== 'undefined' || typeof process !== 'undefined') throw Error('Node reached renderer');
    if (typeof window.dskcpyHost?.snapshot !== 'function') throw Error('Preload unavailable');
    const wait = async expected => {
      const deadline = Date.now() + 5000;
      while (document.querySelector('h1')?.textContent !== expected) {
        if (Date.now() > deadline) throw Error('View did not update');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await wait('Your computer, wherever you are');
    await window.dskcpyHost.start(); await wait('Open this on your other device');
    const copied = await window.dskcpyHost.copyInvitation();
    await window.dskcpyHost.stop(); await wait('Your computer, wherever you are');
    await window.dskcpyHost.setOpenAtLogin(true); await window.dskcpyHost.setOpenAtLogin(false);
    await window.dskcpyHost.setClipboardAllowed(true); await window.dskcpyHost.setClipboardAllowed(false);
    await window.dskcpyHost.setConnection('usb'); await wait('Connect your Android phone');
    await window.dskcpyHost.selectUsbDevice('synthetic');
    await window.dskcpyHost.setConnection('internet'); await wait('Your computer, wherever you are');
    const devices = await window.dskcpyHost.trustedList();
    if (!devices.available || devices.devices.length || devices.pending.length) throw Error('Empty synthetic device registry unavailable');
    const paused = await window.dskcpyHost.trustedAction('pause');
    if (!paused.paused || paused.devices.length) throw Error('Synthetic remembered pause IPC failed');
    return { bridgeLoaded: true, nodeUnavailable: true, rendererStartStopEvents: true, syntheticCopy: copied, syntheticStartupIpc: true, rememberedDeviceIpc: true, usbPreloadIpc: true, utilityMissingAdbHandled: true, clipboardConsentIpc: true };
  })()`);
  stage = 'renderer-validation';
  assert.deepEqual(errors, []); assert.equal(window.isVisible(), false);
  stage = 'utility-shutdown'; await backend.shutdown(); backend = null;
  stage = 'result-write';
  await writeFile(config.result, JSON.stringify({ ...check, utilityProcessIpc: true,
    bundledRuntime: process.versions.electron, hiddenWindow: true, nativeProgram: 'fake --help only',
    realInvitation: false, realDeviceEnrolled: false, screenCapture: false, permissionApis: false, tailscale: false,
    actualHostShellLaunched: false, desktopMediaQualified: false }, null, 2));
}).catch(async error => {
  await writeFile(config.result, JSON.stringify({ passed: false, stage, category: error.code === 'ERR_ASSERTION' ? 'assertion' : 'runtime' }));
  process.exitCode = 1;
}).finally(async () => {
  await backend?.shutdown().catch(() => {}); window?.destroy(); app.exit(process.exitCode || 0);
});
