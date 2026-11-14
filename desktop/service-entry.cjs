// Electron utilityProcess provides Node. No system Node or Terminal is used.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const parent = process.parentPort;
let service, origin, usbDevices;
const startup = (async () => {
  const { createControlService } = await import(pathToFileURL(path.join(__dirname, '../gui/server/service.mjs')).href);
  const { UsbDevices } = await import(pathToFileURL(path.join(__dirname, 'usb-devices.mjs')).href);
  usbDevices = new UsbDevices();
  service = createControlService({ configuredPort: 0, browserPort: 27180, trustedDevicesPath: process.env.DSKCPY_TRUST_STORE || null });
  origin = `http://127.0.0.1:${await service.listen()}`;
})();
async function api(endpoint, body) {
  const response = await fetch(origin + endpoint, { method: body ? 'POST' : 'GET',
    headers: body ? { Origin: origin, 'Content-Type': 'application/json' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Service request failed');
  return response.json();
}
// Register immediately so messages arriving during module loading are retained.
parent.on('message', async ({ data }) => {
  if (!data || !Number.isSafeInteger(data.id)) return;
  try {
    await startup;
    let value;
    switch (data.action) {
      case 'ready': await api('/api/status'); value = true; break;
      case 'status': {
        const status = service.publicState();
        value = { running: status.running, browser: { waiting: status.browser.waiting, connected: status.browser.connected } }; break;
      }
      case 'readiness': {
        const readiness = (await api('/api/status')).readiness;
        value = { ready: Boolean(readiness?.transports?.browser?.ready), keyboard: readiness?.features?.browserKeyboard === true,
          adb: readiness?.checks?.some(check => check.id === 'adb' && check.ready) === true }; break;
      }
      case 'usb-devices': {
        const result = await api('/api/devices');
        value = { devices: usbDevices.update(result.error ? [] : result.devices), error: Boolean(result.error) }; break;
      }
      case 'trusted-list': value = await api('/api/browser/trusted'); break;
      case 'trusted-action': {
        if (!data.args || !['approve','reject','revoke','pause','resume'].includes(data.args.action)) throw new Error('Invalid device action');
        value = await api('/api/browser/trusted', data.args); break;
      }
      case 'invite': {
        const mode = data.args?.mode || 'internet';
        if (!['internet', 'usb'].includes(mode)) throw Error('Invalid connection mode');
        let browserSerial;
        if (mode === 'usb') {
          const result = await api('/api/devices');
          if (result.error) throw Error('USB enumeration failed');
          browserSerial = usbDevices.resolve(data.args?.device, result.devices);
        }
        value = await api('/api/browser/invite', { browserTransport: mode, ...(browserSerial ? { browserSerial } : {}),
          maxSize: 1600, maxFps: 30, bitRateMbps: 8 }); break;
      }
      case 'stop': value = await api('/api/stream/stop', {}); break;
      case 'shutdown': {
        await service.shutdown();
        // Allow native stdin q / bounded force-stop to release held input before
        // the parent retires this utility process.
        const deadline = Date.now() + 4500;
        while (service.publicState().running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        value = true; break;
      }
      default: throw new Error('Unknown host action');
    }
    // Never send native logs, paths, device IDs or arbitrary service state.
    if (data.action === 'invite') value = { mode: value.mode, url: value.url, key: value.key,
      openedOnPhone: value.openedOnPhone === true,
      expiresAt: value.expiresAt, status: { running: value.status.running,
        browser: { waiting: value.status.browser.waiting, connected: value.status.browser.connected } } };
    if (data.action === 'stop') value = true;
    parent.postMessage({ id: data.id, ok: true, value });
  } catch { parent.postMessage({ id: data.id, ok: false }); }
});
