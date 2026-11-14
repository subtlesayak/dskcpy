import { browserJoinUrl } from '../gui/receiver/protocol.mjs';

export function hostPhase({ status, permissions, route, runtimeReady, busy, error, checked, connection = 'internet', usb }) {
  // A newly failed check never hides the stop action for an owned session.
  if (status?.browser?.connected || status?.running) return 'sharing';
  if (status?.browser?.waiting) return 'inviting';
  if (busy) return 'preparing';
  if (error) return 'error';
  if (checked === false) return 'checking';
  if (!runtimeReady) return 'installation';
  if (!permissions.screen) return 'screen-permission';
  if (!permissions.control) return 'control-permission';
  if (connection === 'usb') {
    if (!usb?.available) return 'usb-tool';
    if (usb.error || !usb.devices.length) return 'usb-device';
    if (!usb.devices.some(device => device.state === 'ready'))
      return usb.devices.some(device => device.state === 'unauthorized') ? 'usb-authorize' : 'usb-device';
    if (!usb.devices.some(device => device.id === usb.selected && device.state === 'ready')) return 'usb-select';
    return 'ready';
  }
  if (!route.connected) return 'network';
  if (route.conflict) return 'route-conflict';
  if (!route.ready) return 'private-link';
  return 'ready';
}

export function validateInvitation(invitation, expectedOrigin, now = Date.now(), mode = 'internet') {
  const expiresAt = typeof invitation?.expiresAt === 'string' ? Date.parse(invitation.expiresAt) : invitation?.expiresAt;
  if (!['internet', 'usb'].includes(mode) || !invitation || invitation.mode !== mode || !Number.isFinite(expiresAt)
      || expiresAt <= now || expiresAt > now + 300000 + 5000) {
    throw new Error('The connection invitation is unavailable. Try Start sharing again.');
  }
  const url = new URL(invitation.url);
  if (url.origin !== expectedOrigin || (mode === 'usb' ? url.origin !== 'http://127.0.0.1:27180' : url.protocol !== 'https:') || url.pathname !== '/'
      || url.username || url.password || url.search || url.hash) {
    throw new Error('The private connection address changed. Check the connection setup.');
  }
  return { joinUrl: browserJoinUrl(url.href, invitation.key), expiresAt,
    ...(mode === 'usb' ? { openedOnPhone: invitation.openedOnPhone === true } : {}) };
}

export class HostController {
  constructor({ backend, checkSetup, now = Date.now, onChange = () => {} }) {
    this.backend = backend; this.checkSetup = checkSetup; this.now = now; this.onChange = onChange;
    this.status = null; this.permissions = { screen: false, control: false };
    this.route = { connected: false, ready: false }; this.runtimeReady = false;
    this.features = { keyboard: false, clipboard: false }; this.clipboardAllowed = false;
    this.connection = 'internet'; this.usb = { available: false, error: false, devices: [], selected: null };
    this.usbSelectionLost = false;
    this.busy = false; this.error = null; this.invitation = null; this.generation = 0;
    this.closed = false; this.checked = false; this.startAttempt = null; this.refreshAttempt = null;
  }
  snapshot() {
    const phase = hostPhase(this);
    return { phase, permissions: { ...this.permissions },
      connection: this.connection, usb: { ...this.usb, devices: this.usb.devices.map(device => ({ ...device })) },
      clipboardAllowed: this.clipboardAllowed,
      features: { ...this.features },
      route: { connected: this.route.connected, ready: this.route.ready, conflict: Boolean(this.route.conflict) },
      error: this.error, invitation: phase === 'inviting' ? this.invitation : null,
      canStop: Boolean(this.busy || this.status?.running || this.status?.browser?.waiting || this.status?.browser?.connected) };
  }
  emit() { if (!this.closed) this.onChange(this.snapshot()); }
  async refresh({ setup = false } = {}) {
    if (this.closed) return this.snapshot();
    const mine = this.generation;
    if (this.refreshAttempt?.generation === mine) return this.refreshAttempt.promise;
    const record = { generation: mine };
    record.promise = (async () => {
      if (setup) {
        const next = await this.checkSetup(this.connection);
        if (this.closed || mine !== this.generation) return this.snapshot();
        this.permissions = next.permissions; this.route = next.route; this.runtimeReady = next.runtimeReady;
        this.features = { keyboard: next.features?.keyboard === true, clipboard: next.features?.clipboard === true };
        if (!this.features.clipboard) this.clipboardAllowed = false;
        if (this.connection === 'usb') {
          const devices = next.usb?.devices || [], ready = devices.filter(device => device.state === 'ready');
          if (this.usb.selected && !ready.some(device => device.id === this.usb.selected)) this.usbSelectionLost = true;
          // Never redirect a previously selected phone's sharing to another
          // phone merely because it became the only one attached during Start.
          const selected = ready.some(device => device.id === this.usb.selected) ? this.usb.selected
            : !this.usbSelectionLost && ready.length === 1 ? ready[0].id : null;
          this.usb = { available: next.usb?.available === true, error: next.usb?.error === true, devices, selected };
        }
        this.checked = true;
      }
      const status = await this.backend.status();
      if (this.closed || mine !== this.generation) return this.snapshot();
      if ((this.status?.running || this.status?.browser?.waiting || this.status?.browser?.connected)
          && !status.running && !status.browser?.waiting && !status.browser?.connected) this.clipboardAllowed = false;
      this.status = status;
      if (!status.browser?.waiting || status.browser?.connected || (this.invitation && this.invitation.expiresAt <= this.now())) this.invitation = null;
      this.emit(); return this.snapshot();
    })().finally(() => { if (this.refreshAttempt === record) this.refreshAttempt = null; });
    this.refreshAttempt = record;
    return record.promise;
  }
  async setConnection(connection) {
    if (!['internet', 'usb'].includes(connection)) throw Error('Choose a supported connection.');
    if (this.closed || this.snapshot().canStop) return this.snapshot();
    ++this.generation; this.connection = connection; this.clipboardAllowed = false; this.checked = false; this.error = null; this.invitation = null;
    this.emit(); return this.refresh({ setup: true });
  }
  selectUsbDevice(id) {
    if (this.closed || this.connection !== 'usb' || this.snapshot().canStop) return this.snapshot();
    if (!this.usb.devices.some(device => device.id === id && device.state === 'ready')) throw Error('Choose an authorized phone.');
    if (this.usb.selected !== id) this.clipboardAllowed = false;
    this.usb.selected = id; this.usbSelectionLost = false; this.emit(); return this.snapshot();
  }
  setClipboardAllowed(allowed) {
    if (typeof allowed !== 'boolean') throw Error('Choose whether to allow clipboard transfer.');
    if (this.closed || this.snapshot().canStop) return this.snapshot();
    this.clipboardAllowed = allowed && this.features.clipboard && this.features.keyboard;
    this.emit(); return this.snapshot();
  }
  async start() {
    if (this.closed) throw new Error('Open dskcpy Host again to start sharing.');
    if (this.startAttempt?.generation === this.generation) return this.startAttempt.promise;
    if (this.status?.running || this.status?.browser?.waiting || this.status?.browser?.connected) return this.snapshot();
    const mine = ++this.generation; this.busy = true; this.error = null; this.emit();
    const record = { generation: mine };
    record.promise = (async () => {
      let requested = false;
      try {
        await this.refresh({ setup: true });
        if (mine !== this.generation || this.closed) return this.snapshot();
        if (hostPhase({ ...this, busy: false }) !== 'ready') return this.snapshot();
        requested = true;
        const result = await this.backend.invite({ mode: this.connection, ...(this.clipboardAllowed ? { clipboard: true } : {}), ...(this.connection === 'usb' ? { device: this.usb.selected } : {}) });
        if (mine !== this.generation || this.closed) return this.snapshot();
        this.invitation = validateInvitation(result, this.connection === 'usb' ? 'http://127.0.0.1:27180' : this.route.origin, this.now(), this.connection);
        this.status = result.status || await this.backend.status();
      } catch {
        // A timed-out preparation must not leave an invitation behind. This
        // backend is the app's owned child, never a discovered running service.
        if (requested && mine === this.generation) await this.backend.stop().catch(() => {});
        if (mine === this.generation && !this.closed) {
          this.invitation = null; this.clipboardAllowed = false;
          this.error = this.connection === 'usb' ? 'Sharing could not start. Unlock and authorize the USB phone, then check again. Another sharing app may already be using the connection.'
            : 'Sharing could not start. Check the connection setup, then try again.';
        }
      } finally {
        if (mine === this.generation) this.busy = false;
        this.emit();
      }
      return this.snapshot();
    })().finally(() => { if (this.startAttempt === record) this.startAttempt = null; });
    this.startAttempt = record;
    return record.promise;
  }
  async stop() {
    ++this.generation; this.busy = false; this.invitation = null; this.clipboardAllowed = false; this.error = null;
    await this.backend.stop();
    return this.refresh();
  }
  async close() {
    if (this.closed) return;
    this.closed = true; ++this.generation; this.invitation = null;
    await this.backend.shutdown();
  }
}
