import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { privateRtcBind } from '../server/browser-rtc.mjs';
import { parseOptions } from './launch.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
try {
  if (process.platform !== 'darwin') throw new Error('Run this launcher in Terminal on the Mac.');
  if (process.argv.slice(2).some((arg) => arg !== '--check')) throw new Error('Use --check or no arguments.');
  const executable = path.resolve(root, process.env.SCRCPY_GUI_BINARY || 'build-macos/app/scrcpy');
  const dashboardPort = parseOptions([], process.env).port;
  if (!existsSync(executable) || !existsSync(path.join(root, 'gui/dist/index.html'))) {
    throw new Error('Build the Mac host and GUI before launching browser sharing.');
  }
  const tailscale = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale'].find(existsSync);
  if (!tailscale) throw new Error('Install and connect Tailscale on both devices first.');
  const env = { ...process.env, TAILSCALE_BE_CLI: '1' };
  const read = (args) => JSON.parse(execFileSync(tailscale, args, { env, timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const status = read(['status', '--json']);
  if (status.BackendState !== 'Running' || !status.Self?.Online) throw new Error('Connect Tailscale on this Mac first.');
  const bind = (status.TailscaleIPs || []).find((address) => privateRtcBind(address) && address.startsWith('100.'));
  const hostname = status.Self.DNSName?.replace(/\.$/, '');
  if (!bind || !/^[a-z0-9.-]+\.ts\.net$/i.test(hostname || '')) throw new Error('A private Tailscale IPv4 address and HTTPS hostname are required.');
  const serve = read(['serve', 'status', '--json']);
  const handler = serve?.Web?.[`${hostname}:8443`]?.Handlers?.['/'];
  const serveReady = handler?.Proxy === 'http://127.0.0.1:27180';
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ nativeBuilt: true, guiBuilt: true, vpnOnline: true,
      privateMediaInterface: true, privateHttpsReady: serveReady, dashboardPort, receiverPort: 27180, httpsPort: 8443 }));
  } else {
    if (!serveReady) throw new Error('Private receiver HTTPS on port 8443 is not configured. Existing Serve routes were left unchanged.');
    console.log(`Open http://127.0.0.1:${dashboardPort} on THIS MAC. Choose Browser receiver → Internet / VPN.`);
    console.log('Create an invitation, then scan its QR with the receiving phone’s camera while connected to Tailscale.');
    console.log('Keep this Terminal open. Capture and input still need the Mac permissions.');
    const child = spawn(process.execPath, ['gui/scripts/launch.mjs', '--no-open', '--no-reuse'], {
      cwd: root, stdio: 'inherit', env: { ...env,
        SCRCPY_GUI_BINARY: executable, SCRCPY_ICON_DIR: path.join(root, 'app/data'),
        DISPLAY_BRIDGE_PORT: String(dashboardPort), DSKCPY_VIEWER_PORT: '27180',
        DSKCPY_VIEWER_ORIGIN: `https://${hostname}:8443`, DSKCPY_VIEWER_RTC_BIND: bind,
      },
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', () => { console.error('Could not start the browser-sharing dashboard.'); process.exitCode = 1; });
    child.on('exit', (code) => { process.exitCode = code ?? 1; });
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
