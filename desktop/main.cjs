const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, utilityProcess, systemPreferences, desktopCapturer, shell, dialog, clipboard } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.setName('dskcpy Host');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window, tray, host, backend, privateRoute, startup, timer, quitting = false, refreshing = false;
  const hostRoot = app.isPackaged ? path.join(process.resourcesPath, 'host') : path.join(__dirname, 'stage/host');
  const page = pathToFileURL(path.join(__dirname, '../gui/dist-desktop/desktop/index.html')).href;
  const importLocal = name => import(pathToFileURL(path.join(__dirname, name)).href);
  function show() { if (window) { window.show(); window.focus(); } }
  app.on('second-instance', show);
  app.on('activate', show);
  // A menu/tray app stays available when its setup window is closed.
  app.on('window-all-closed', () => {});
  function permissions() {
    return process.platform === 'darwin' ? {
      screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
      control: systemPreferences.isTrustedAccessibilityClient(false),
    } : { screen: true, control: true };
  }
  function update(snapshot) {
    snapshot = { ...snapshot, startup: startup?.snapshot() };
    if (window && !window.isDestroyed()) window.webContents.send('host:changed', snapshot);
    if (!tray) return;
    tray.setToolTip(snapshot.phase === 'sharing' ? 'dskcpy — sharing your screen' : 'dskcpy Host');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: snapshot.phase === 'sharing' ? 'Sharing your screen' : 'dskcpy Host', enabled: false },
      { label: 'Open dskcpy', click: show },
      { label: 'Stop sharing', enabled: snapshot.canStop, click: () => host.stop().catch(() => show()) },
      { type: 'separator' }, { label: 'Quit dskcpy', click: () => app.quit() },
    ]));
  }
  async function refresh(setup = true) {
    if (refreshing || !host) return host?.snapshot();
    refreshing = true;
    if (setup) startup?.refresh();
    try { return await host.refresh({ setup }); }
    catch { host.error = 'The sharing service is unavailable. Reopen dskcpy to try again.'; host.emit(); return host.snapshot(); }
    finally { refreshing = false; }
  }
  function handle(name, action) {
    ipcMain.handle(`host:${name}`, async (event, ...args) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame
          || event.senderFrame.url !== page) throw new Error('Untrusted host action');
      return action(...args);
    });
  }
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    if (host?.snapshot().canStop && dialog.showMessageBoxSync(window, {
      type: 'question', title: 'Stop sharing and quit?', message: 'Quitting ends access to this computer.',
      buttons: ['Keep sharing', 'Stop sharing and quit'], defaultId: 0, cancelId: 0,
    }) !== 1) return;
    quitting = true; clearInterval(timer);
    Promise.resolve(host?.close()).catch(() => {}).finally(() => app.quit());
  });
  app.whenReady().then(async () => {
    const [{ HostController }, { OwnedBackend }, { createPrivateRoute }, { StartupPreference }] = await Promise.all([
      importLocal('host-controller.mjs'), importLocal('owned-backend.mjs'), importLocal('private-route.mjs'), importLocal('startup-preference.mjs'),
    ]);
    startup = new StartupPreference({ platform: process.platform, executable: app.getPath('exe'),
      available: app.isPackaged && ['darwin', 'win32'].includes(process.platform) && (process.platform !== 'darwin' || app.isInApplicationsFolder()),
      read: options => app.getLoginItemSettings(options), write: options => app.setLoginItemSettings(options) });
    const launchedAtLogin = startup.refresh().wasOpenedAtLogin || process.argv.includes('--background');
    if (launchedAtLogin) app.dock?.hide();
    privateRoute = createPrivateRoute();
    backend = new OwnedBackend({ fork: utilityProcess.fork, modulePath: path.join(__dirname, 'service-entry.cjs'),
      environment: { ...process.env, SCRCPY_GUI_BINARY: path.join(hostRoot, 'bin', process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy'),
        ADB: path.join(hostRoot, 'bin', process.platform === 'win32' ? 'adb.exe' : 'adb'),
        SCRCPY_ICON_DIR: path.join(hostRoot, 'bin'), DSKCPY_VIEWER_PORT: '27180', DSKCPY_TRUST_STORE: path.join(app.getPath('userData'), 'remembered-devices.json'),
        // A package must never inherit development TLS/binary overrides.
        DSKCPY_VIEWER_TLS_CERT: '', DSKCPY_VIEWER_TLS_KEY: '', SCRCPY_RUNTIME_DIR: path.join(hostRoot, 'bin') },
      onExit: () => { if (!quitting && host) { host.status = null; host.invitation = null;
        host.error = 'The sharing service closed. Reopen dskcpy to try again.'; host.emit(); } },
    });
    host = new HostController({ backend, onChange: update, checkSetup: async connection => {
      // Cable setup does not inspect or modify Tailscale, routes or accounts.
      const route = connection === 'usb' ? { connected: false, ready: false } : await privateRoute.check();
      await backend.ensure(route);
      const readiness = await backend.readiness();
      const usb = connection === 'usb' ? { available: readiness.adb, ...(readiness.adb ? await backend.usbDevices() : { devices: [], error: false }) } : undefined;
      return { route, usb, permissions: permissions(), runtimeReady: readiness.ready, features: { keyboard: readiness.keyboard, clipboard: readiness.clipboard } };
    } });
    window = new BrowserWindow({ width: 620, height: 740, minWidth: 360, minHeight: 420,
      title: 'dskcpy Host', backgroundColor: '#0a1419', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true } });
    window.on('focus', () => { startup.refresh(); update(host.snapshot()); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.on('close', event => { if (!quitting) { event.preventDefault(); window.hide(); } });
    const icon = nativeImage.createFromPath(path.join(hostRoot, 'bin', process.platform === 'win32' ? 'icon.ico' : 'scrcpy.png')).resize({ width: 20, height: 20 });
    tray = new Tray(icon); tray.on('click', show); update(host.snapshot());
    handle('snapshot', () => ({ ...host.snapshot(), startup: startup.snapshot() }));
    handle('set-open-at-login', enabled => {
      const next = startup.set(enabled); update(host.snapshot()); return next;
    });
    handle('trusted-list', () => backend.request('trusted-list'));
    handle('trusted-action', (action, id) => {
      if (!['approve', 'reject', 'revoke', 'pause', 'resume'].includes(action)
          || (['approve', 'reject', 'revoke'].includes(action) && !/^[a-f0-9]{32}$/.test(id))) throw new Error('Invalid device action');
      return backend.request('trusted-action', { action, id });
    });
    handle('start', () => host.start());
    handle('connection', connection => host.setConnection(connection));
    handle('usb-device', id => host.selectUsbDevice(id));
    handle('clipboard-allowed', allowed => host.setClipboardAllowed(allowed));
    handle('stop', () => host.stop());
    handle('refresh', () => refresh());
    handle('screen-permission', async () => {
      if (process.platform !== 'darwin') return;
      // A check alone does not register this app in macOS's permission list.
      // Run only after the user presses Allow screen sharing. Zero-sized
      // thumbnails request permission without returning screen pixels to UI.
      try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }); } catch {}
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted')
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      return refresh();
    });
    handle('control-permission', async () => {
      if (process.platform === 'darwin') { systemPreferences.isTrustedAccessibilityClient(true);
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'); }
    });
    handle('tailscale', () => shell.openExternal('https://tailscale.com/download'));
    handle('private-setup', async () => {
      if (host.snapshot().canStop) return host.snapshot();
      const { response } = await dialog.showMessageBox(window, { type: 'question', title: 'Set up your private connection?',
        message: 'Let devices with Tailscale access reach dskcpy?',
        detail: 'This adds a private HTTPS route for this app. It does not create a public link. Sharing still requires a one-use invitation.',
        buttons: ['Cancel', 'Set up connection'], defaultId: 1, cancelId: 0 });
      if (response === 1) {
        try { await privateRoute.configure({ confirmed: true }); }
        catch { host.error = 'Private setup could not finish. Check Tailscale; existing connection settings were kept.'; host.emit(); return host.snapshot(); }
      }
      host.error = null; return refresh();
    });
    handle('copy-invitation', () => {
      const invitation = host.snapshot().invitation;
      if (!invitation || invitation.expiresAt <= Date.now()) return false;
      clipboard.writeText(invitation.joinUrl); return true;
    });
    await window.loadURL(page);
    // Login startup opens the tray host only. It never creates an invitation or
    // starts screen/audio capture; those still require the sharing action.
    if (!launchedAtLogin) window.show();
    await refresh();
    timer = setInterval(() => refresh(false), 1500); timer.unref();
  }).catch(() => {
    dialog.showErrorBox('dskcpy could not open', 'The app installation is incomplete. Install a fresh copy and try again.');
    quitting = true; Promise.resolve(backend?.shutdown()).catch(() => {}).finally(() => app.quit());
  });
}
