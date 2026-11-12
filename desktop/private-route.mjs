import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { privateRtcBind } from '../gui/server/browser-rtc.mjs';

export function inspectPrivateRoute(status, serve, httpsPort = 8443, receiverPort = 27180) {
  status ||= {}; serve ||= {};
  const bind = (status.TailscaleIPs || []).find(ip => privateRtcBind(ip) && ip.startsWith('100.'));
  const hostname = status.Self?.DNSName?.replace(/\.$/, '');
  const connected = status.BackendState === 'Running' && status.Self?.Online === true
    && Boolean(bind) && /^[a-z0-9.-]+\.ts\.net$/i.test(hostname || '');
  if (!connected) return { connected: false, ready: false, conflict: false };
  const web = serve.Web?.[`${hostname}:${httpsPort}`];
  const handlers = web?.Handlers || {};
  const tcp = serve.TCP?.[String(httpsPort)];
  const proxy = `http://127.0.0.1:${receiverPort}`;
  // A dedicated origin is necessary: another app on the same origin could
  // otherwise reach a browser's path-scoped resume cookie.
  const ready = Object.keys(handlers).length === 1 && handlers['/']?.Proxy === proxy
    && (!tcp || tcp.HTTPS === true) && !serve.AllowFunnel?.[`${hostname}:${httpsPort}`];
  const occupied = Boolean(web || tcp || serve.AllowFunnel?.[`${hostname}:${httpsPort}`]);
  return { connected: true, ready, conflict: occupied && !ready,
    origin: `https://${hostname}:${httpsPort}`, bind };
}

export function createPrivateRoute({ platform = process.platform, environment = process.env,
  execute = promisify(execFile), fileExists = existsSync, httpsPort = 8443, receiverPort = 27180 } = {}) {
  const candidates = platform === 'win32'
    ? [path.join(environment.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
    : ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'];
  const executable = candidates.find(fileExists);
  const env = { ...environment, ...(platform === 'darwin' ? { TAILSCALE_BE_CLI: '1' } : {}) };
  const run = args => execute(executable, args, { env, timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
  async function check() {
    if (!executable) return { connected: false, ready: false, conflict: false };
    try {
      const status = JSON.parse((await run(['status', '--json'])).stdout);
      const serve = JSON.parse((await run(['serve', 'status', '--json'])).stdout);
      return inspectPrivateRoute(status, serve, httpsPort, receiverPort);
    } catch { return { connected: false, ready: false, conflict: false }; }
  }
  async function configure({ confirmed = false } = {}) {
    if (!confirmed) throw new Error('Confirm private connection setup first.');
    const current = await check();
    if (!current.connected) throw new Error('Connect Tailscale on this computer first.');
    if (current.conflict) throw new Error('Another app uses this private address. Its settings were left unchanged.');
    if (current.ready) return current;
    await run(['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${receiverPort}`]);
    const next = await check();
    if (!next.ready) throw new Error('Private connection setup did not finish. Open Tailscale and try again.');
    return next;
  }
  return { check, configure };
}
