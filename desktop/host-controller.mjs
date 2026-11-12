import { browserJoinUrl } from '../gui/receiver/protocol.mjs';

export function hostPhase({ status, permissions, route, runtimeReady, busy, error, checked }) {
  // A newly failed check never hides the stop action for an owned session.
  if (status?.browser?.connected || status?.running) return 'sharing';
  if (status?.browser?.waiting) return 'inviting';
  if (busy) return 'preparing';
  if (error) return 'error';
  if (checked === false) return 'checking';
  if (!runtimeReady) return 'installation';
  if (!permissions.screen) return 'screen-permission';
  if (!permissions.control) return 'control-permission';
  if (!route.connected) return 'network';
  if (route.conflict) return 'route-conflict';
  if (!route.ready) return 'private-link';
  return 'ready';
}

export function validateInvitation(invitation, expectedOrigin, now = Date.now()) {
  const expiresAt = typeof invitation?.expiresAt === 'string' ? Date.parse(invitation.expiresAt) : invitation?.expiresAt;
  if (!invitation || invitation.mode !== 'internet' || !Number.isFinite(expiresAt)
      || expiresAt <= now || expiresAt > now + 300000 + 5000) {
    throw new Error('The connection invitation is unavailable. Try Start sharing again.');
  }
  const url = new URL(invitation.url);
  if (url.origin !== expectedOrigin || url.protocol !== 'https:' || url.pathname !== '/'
      || url.username || url.password || url.search || url.hash) {
    throw new Error('The private connection address changed. Check the connection setup.');
  }
  return { joinUrl: browserJoinUrl(url.href, invitation.key), expiresAt };
}

export class HostController {
  constructor({ backend, checkSetup, now = Date.now, onChange = () => {} }) {
    this.backend = backend; this.checkSetup = checkSetup; this.now = now; this.onChange = onChange;
    this.status = null; this.permissions = { screen: false, control: false };
    this.route = { connected: false, ready: false }; this.runtimeReady = false;
    this.features = { keyboard: false };
    this.busy = false; this.error = null; this.invitation = null; this.generation = 0;
    this.closed = false; this.checked = false; this.startAttempt = null; this.refreshAttempt = null;
  }
  snapshot() {
    const phase = hostPhase(this);
    return { phase, permissions: { ...this.permissions },
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
        const next = await this.checkSetup();
        if (this.closed || mine !== this.generation) return this.snapshot();
        this.permissions = next.permissions; this.route = next.route; this.runtimeReady = next.runtimeReady;
        this.features = { keyboard: next.features?.keyboard === true };
        this.checked = true;
      }
      const status = await this.backend.status();
      if (this.closed || mine !== this.generation) return this.snapshot();
      this.status = status;
      if (!status.browser?.waiting || status.browser?.connected || (this.invitation && this.invitation.expiresAt <= this.now())) this.invitation = null;
      this.emit(); return this.snapshot();
    })().finally(() => { if (this.refreshAttempt === record) this.refreshAttempt = null; });
    this.refreshAttempt = record;
    return record.promise;
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
        const result = await this.backend.invite();
        if (mine !== this.generation || this.closed) return this.snapshot();
        this.invitation = validateInvitation(result, this.route.origin, this.now());
        this.status = result.status || await this.backend.status();
      } catch {
        // A timed-out preparation must not leave an invitation behind. This
        // backend is the app's owned child, never a discovered running service.
        if (requested && mine === this.generation) await this.backend.stop().catch(() => {});
        if (mine === this.generation && !this.closed) {
          this.invitation = null;
          this.error = 'Sharing could not start. Check the connection setup, then try again.';
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
    ++this.generation; this.busy = false; this.invitation = null; this.error = null;
    await this.backend.stop();
    return this.refresh();
  }
  async close() {
    if (this.closed) return;
    this.closed = true; ++this.generation; this.invitation = null;
    await this.backend.shutdown();
  }
}
