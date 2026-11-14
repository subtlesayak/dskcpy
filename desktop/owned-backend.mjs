// The desktop app talks only to the child it creates. It never discovers,
// attaches to, stops, or reconfigures an existing controller.
export class OwnedBackend {
  constructor({ fork, modulePath, environment, onExit = () => {} }) {
    Object.assign(this, { fork, modulePath, environment, onExit });
    this.child = null; this.pending = new Map(); this.sequence = 0; this.configuration = null;
    this.opening = null; this.closed = false; this.retiring = new WeakSet();
  }
  async ensure(route) {
    if (this.closed) throw new Error('Host closed');
    const configuration = JSON.stringify({ origin: route.origin || '', bind: route.bind || '127.0.0.1' });
    if (this.opening) await this.opening;
    if (this.child && this.configuration === configuration) return;
    if (this.child) {
      const status = await this.status();
      if (status.running || status.browser?.waiting || status.browser?.connected) throw new Error('Stop this app’s sharing before changing its connection.');
      await this.retire();
    }
    this.opening = (async () => {
      const child = this.fork(this.modulePath, [], { env: { ...this.environment,
        DSKCPY_VIEWER_ORIGIN: route.origin || '', DSKCPY_VIEWER_RTC_BIND: route.bind || '127.0.0.1' },
        stdio: 'ignore', serviceName: 'dskcpy Host service' });
      this.child = child; this.configuration = configuration;
      child.on('message', message => {
        const waiting = this.pending.get(message?.id);
        if (!waiting || waiting.child !== child) return;
        clearTimeout(waiting.timer); this.pending.delete(message.id);
        if (message.ok) waiting.resolve(message.value); else waiting.reject(new Error('The sharing service could not finish this action.'));
      });
      child.once('exit', () => {
        for (const [id, waiting] of this.pending) if (waiting.child === child) {
          clearTimeout(waiting.timer); waiting.reject(new Error('The sharing service closed.')); this.pending.delete(id);
        }
        if (this.child === child) { this.child = null; this.configuration = null; if (!this.retiring.has(child)) this.onExit(); }
      });
      try { await this.request('ready'); }
      catch (error) {
        this.retiring.add(child);
        if (this.child === child) { this.child = null; this.configuration = null; }
        child.kill(); throw error;
      }
    })().finally(() => { this.opening = null; });
    return this.opening;
  }
  request(action, args) {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Open the sharing service first.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The sharing service took too long.')); }, 20000);
      this.pending.set(id, { resolve, reject, timer, child });
      try { child.postMessage({ id, action, args }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  status() { return this.request('status'); }
  readiness() { return this.request('readiness'); }
  usbDevices() { return this.request('usb-devices'); }
  invite(args) { return this.request('invite', args); }
  stop() { return this.child ? this.request('stop') : Promise.resolve(); }
  async retire() {
    const child = this.child;
    if (!child) return;
    this.retiring.add(child);
    try { await this.request('shutdown'); } finally {
      // This handle belongs only to this app; never terminate by name or port.
      if (this.child === child) { this.child = null; this.configuration = null; }
      child.kill();
    }
  }
  async shutdown() { this.closed = true; if (this.opening) await this.opening.catch(() => {}); await this.retire(); }
}
