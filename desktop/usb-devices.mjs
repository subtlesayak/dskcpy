import { randomBytes } from 'node:crypto';

// Serial numbers stay in the utility process. The renderer receives only
// short-lived selection handles; reconnecting a removed phone needs a new one.
export class UsbDevices {
  constructor() { this.handles = new Map(); }
  update(devices) {
    const present = new Set();
    const result = devices.filter(device => device.transport === 'USB' && !/^emulator-/.test(device.serial)).slice(0, 64).map(device => {
      present.add(device.serial);
      let id = [...this.handles].find(([, serial]) => serial === device.serial)?.[0];
      if (!id) { id = randomBytes(16).toString('hex'); this.handles.set(id, device.serial); }
      const state = device.authorized ? 'ready' : device.state === 'unauthorized' ? 'unauthorized' : 'offline';
      // Model labels are untrusted device data, rendered as text, never HTML.
      return { id, name: String(device.model || 'Android phone').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80), state };
    });
    for (const [id, serial] of this.handles) if (!present.has(serial)) this.handles.delete(id);
    return result;
  }
  resolve(id, devices) {
    const serial = typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? this.handles.get(id) : null;
    if (!serial || !devices.some(device => device.serial === serial && device.transport === 'USB' && !/^emulator-/.test(device.serial) && device.authorized))
      throw Error('Refresh and select an authorized USB phone.');
    return serial;
  }
}
