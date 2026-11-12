// OS startup registration is changed only by a validated user toggle. Reading
// this preference, launching at login, or starting a stream never enrolls it.
export class StartupPreference {
  constructor({ platform, executable, available, read, write }) {
    Object.assign(this, { platform, executable, available, read, write });
    this.value = { available, requested: false, enabled: false, requiresApproval: false, wasOpenedAtLogin: false, error: null };
  }
  options() {
    return this.platform === 'win32' ? { path: this.executable, args: ['--background'] } : { type: 'mainAppService' };
  }
  snapshot() { return { ...this.value }; }
  refresh() {
    if (!this.available) return this.snapshot();
    try {
      const raw = this.read(this.options());
      const requested = raw.openAtLogin === true;
      const requiresApproval = raw.status === 'requires-approval';
      const enabled = requested && !requiresApproval && (this.platform !== 'darwin' || raw.status === 'enabled')
        && (this.platform !== 'win32' || raw.executableWillLaunchAtLogin !== false);
      this.value = { ...this.value, requested, enabled, requiresApproval, error: null,
        wasOpenedAtLogin: this.platform === 'darwin' && raw.wasOpenedAtLogin === true };
    } catch { this.value.error = 'Startup settings could not be read. Check your system’s login or startup settings.'; }
    return this.snapshot();
  }
  set(requested) {
    if (typeof requested !== 'boolean') throw new Error('Choose whether to open dskcpy at login.');
    if (!this.available) throw new Error('Install the app before changing startup settings.');
    this.value.error = null;
    try {
      this.write({ ...this.options(), openAtLogin: requested });
      const next = this.refresh();
      if (next.requested !== requested) this.value.error = 'Your system did not save this change. Check its login or startup settings.';
    } catch { this.value.error = 'Startup settings could not be changed. Check your system’s login or startup settings.'; }
    return this.snapshot();
  }
}
