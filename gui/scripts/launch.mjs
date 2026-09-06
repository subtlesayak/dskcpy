import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { inspectReadiness, resolveRuntime } from '../server/runtime.mjs';

const execFileAsync = promisify(execFile);
const defaultRepo = fileURLToPath(new URL('../../', import.meta.url));

export function parseOptions(args, environment = process.env) {
  const allowed = ['--check', '--no-open', '--help'];
  if (args.some((arg) => !allowed.includes(arg))) {
    throw new Error('Unknown option. Use --check, --no-open or --help.');
  }
  const rawPort = environment.DISPLAY_BRIDGE_PORT ?? '27183';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('DISPLAY_BRIDGE_PORT must be a port number from 1 to 65535.');
  }
  return { check: args.includes('--check'), open: !args.includes('--no-open'),
    help: args.includes('--help'), port: Number(rawPort) };
}

// Only a small, explicit identity response is accepted. Do not follow redirects,
// read session state, stop another process, or assume any occupied port is ours.
export function probeDashboard(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (state) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      request.destroy();
      resolve(state);
    };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/api/health', agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('error', () => finish('occupied'));
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024) finish('occupied');
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          finish(response.statusCode === 200 && health.app === 'dskcpy' && health.apiVersion === 1
            ? 'dskcpy' : 'occupied');
        } catch { finish('occupied'); }
      });
    });
    const timer = setTimeout(() => finish('occupied'), timeoutMs);
    request.on('error', (error) => finish(error.code === 'ECONNREFUSED' ? 'free' : 'occupied'));
  });
}

export async function checkInstallation(repoDir, nodeVersion = process.versions.node) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  if (!(major > 22 || (major === 22 && minor >= 12))) {
    throw new Error('Node.js 22.12 or later is required. Install a supported Node.js version and reopen the launcher.');
  }
  const guiDir = path.join(repoDir, 'gui');
  try { createRequire(path.join(guiDir, 'package.json')).resolve('ws'); }
  catch { throw new Error('Dashboard dependencies are missing. In the gui folder, run: npm.cmd ci'); }
  try {
    if (!(await stat(path.join(guiDir, 'dist/index.html'))).isFile()) throw new Error();
  } catch { throw new Error('Dashboard files are not built. In the gui folder, run: npm.cmd run build'); }
}

async function checkRuntime(repoDir, environment) {
  return inspectReadiness(resolveRuntime(repoDir, environment), (exe, args, options) =>
    execFileAsync(exe, args, { ...options, windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }));
}

async function openDashboard(url) {
  if (process.platform === 'win32') {
    await execFileAsync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/rundll32.exe'),
      ['url.dll,FileProtocolHandler', url], { windowsHide: true, timeout: 5000 });
  } else {
    await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeout: 5000 });
  }
}

function occupiedError(port) {
  return new Error(`Port ${port} is occupied, but did not identify as dskcpy. Nothing was stopped. `
    + 'Check the existing app (older dskcpy versions may need a manual restart), or set DISPLAY_BRIDGE_PORT to a free port.');
}

export async function launch({ args = [], environment = process.env, repoDir = defaultRepo,
  probe = probeDashboard, inspect = checkInstallation, readiness = checkRuntime,
  open = openDashboard, log = console.log,
  createService = async (options) => (await import('../server/service.mjs')).createControlService(options),
} = {}) {
  const options = parseOptions(args, environment);
  if (options.help) {
    log('dskcpy launcher: --check (no server/browser/capture), --no-open (keep server in this terminal).');
    return { exitCode: 0 };
  }
  const url = `http://127.0.0.1:${options.port}`;
  const showDashboard = async () => {
    log(`Dashboard: ${url}`);
    if (options.open) {
      try { await open(url); }
      catch { log('Could not open the browser automatically. Open the dashboard address above on this computer.'); }
    }
  };
  const existing = await probe(options.port);
  if (existing === 'occupied') throw occupiedError(options.port);
  if (existing === 'dskcpy' && !options.check) {
    log('Using the running dskcpy dashboard. Its stream and settings were not changed.');
    await showDashboard();
    return { exitCode: 0, reused: true };
  }
  await inspect(repoDir);
  const status = await readiness(repoDir, { ...environment });
  for (const check of status.checks) {
    log(`${check.ready ? 'OK' : 'CHECK'} - ${check.label}: ${check.ready ? 'Ready.' : check.message}`);
  }
  const canStream = status.transports.browser.ready;
  if (options.check) {
    log('Check only: no service, browser, device connection or capture was started.');
    if (existing === 'dskcpy') log('An existing dashboard was left unchanged; checks above describe this checkout.');
    return { exitCode: canStream ? 0 : 1, readiness: status };
  }
  if (!canStream) log('Streaming needs the components marked CHECK. The dashboard can still open for diagnostics.');
  log('Keep this terminal open. Use Ctrl+C to stop this service and its streams.');
  log('Run from your normal Windows desktop or Mac Terminal, not a restricted automation session.');
  const service = await createService({ environment: { ...environment }, configuredPort: options.port });
  try {
    await service.listen();
  } catch (error) {
    await service.shutdown();
    if (error.code !== 'EADDRINUSE') throw error;
    // A second launcher may have won the race while dependencies were checked.
    if (await probe(options.port) !== 'dskcpy') throw occupiedError(options.port);
    log('Another dskcpy launcher started first. Using its dashboard without changing its stream.');
    await showDashboard();
    return { exitCode: 0, reused: true };
  }
  await showDashboard();
  return { exitCode: 0, service, readiness: status };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  let ownedService;
  let stopping = false;
  const shutdown = async () => {
    stopping = true;
    await ownedService?.shutdown();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const result = await launch({ args: process.argv.slice(2) });
    ownedService = result.service;
    process.exitCode = result.exitCode;
    if (stopping) await ownedService?.shutdown();
  } catch (error) {
    console.error(`dskcpy could not start: ${error.message}`);
    process.exitCode = 1;
  }
}
