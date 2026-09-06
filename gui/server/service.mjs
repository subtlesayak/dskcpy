import { spawn } from 'node:child_process';
import { existsSync, createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openInternetBridge, summarizeTailnet } from './internet.mjs';
import { resolveRuntime, inspectReadiness } from './runtime.mjs';
import { parseMdnsServices } from './discovery.mjs';

import {
  buildScrcpyArgs,
  formatCommand,
  parseAdbDevices,
  sanitizeStreamConfig,
  validateHostEncoder,
  sanitizePairingConfig,
  isAllowedMutation,
} from './core.mjs';

export function createControlService({
  environment = process.env,
  platform = process.platform,
  configuredPort = Number(environment.DISPLAY_BRIDGE_PORT || 27183),
  spawnProcess = spawn,
  commandRunner,
  readinessProbe = inspectReadiness,
  readInternetStatus,
  bridgeOpener = openInternetBridge,
  stopGraceMs = 3000,
  reconnectDelayMs = 1500,
} = {}) {
  const guiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const repoDir = path.resolve(guiDir, '..');
  const distDir = path.join(guiDir, 'dist');
  const host = '127.0.0.1';
  let port = configuredPort;
  let shuttingDown = false;
  let readinessAttempt = null;
  let startAttempt = null;
  let stopTimer = null;
  let reconnectTimer = null;
  let reconnectSession = null;
  let discoveryAttempt = null;
  const reconnectLimit = 3;
  const runCommand = commandRunner || defaultRunCommand;
  const clients = new Set();
  const pendingClients = new Set();
  const logLimit = 160;

  let streamProcess = null;
  let streamStopRequested = false;
  let pairingInProgress = false;
  let internetBridge = null;
  let lastNativeError = null;
  let logRemainders = { stdout: '', stderr: '' };
  const state = {
    readiness: null,
    running: false,
    stopping: false,
    reconnecting: false,
    reconnectAttempt: 0,
    reconnectLimit,
    nextRetryAt: null,
    config: null,
    pid: null,
    encoder: null,
    latencyMs: null,
    command: null,
    startedAt: null,
    lastExitCode: null,
    error: null,
    logs: [],
    hostPlatform: platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux',
    reverseDisplaySupported: platform === 'win32',
  };

  function currentRuntime() {
    return resolveRuntime(repoDir, environment, platform);
  }

  async function refreshReadiness() {
    if (readinessAttempt) return readinessAttempt;
    readinessAttempt = readinessProbe(currentRuntime(), runCommand);
    try {
      state.readiness = await readinessAttempt;
      state.reverseDisplaySupported = ['win32', 'darwin'].includes(platform)
        && state.readiness.checks.some((check) => check.id === 'capture' && check.ready);
      broadcast();
      return state.readiness;
    } finally { readinessAttempt = null; }
  }

  function exitError(code) {
    if (code === 2) {
      return 'The phone ended the stream or the connection was lost. Start streaming again to reconnect.';
    }
    if (platform === 'win32' && code === 0xc0000135) {
      return 'scrcpy could not start because a required runtime DLL was not found.';
    }
    return code && code !== 0 ? `scrcpy exited unexpectedly with code ${code}.` : null;
  }

  function forceTerminateStreamProcess(child) {
    if (platform !== 'win32' || !child.pid) {
      child.kill();
      return;
    }

    // Node's child.kill() terminates only scrcpy.exe on Windows. scrcpy keeps an
    // `adb shell sleep` child as a device-disconnect sentinel, so kill the exact
    // process tree started by this service to avoid leaking that helper.
    const killer = spawnProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    killer.on('error', () => child.kill());
  }

  function terminateStreamProcess(child) {
    if (stopTimer) return;
    // q (or EOF if this service exits) lets native input cleanup run first.
    child.stdin?.end('q');
    stopTimer = setTimeout(() => {
      stopTimer = null;
      if (streamProcess === child && child.exitCode === null) forceTerminateStreamProcess(child);
    }, stopGraceMs);
  }

  function publicState() {
    return {
      ...state,
      binaryAvailable: state.readiness?.checks.some((check) => check.id === 'binary' && check.ready) ?? false,
    };
  }

  function broadcast() {
    const payload = `data: ${JSON.stringify(publicState())}\n\n`;
    for (const response of clients) {
      writeStatusEvent(response, payload);
    }
  }

  function writeStatusEvent(response, payload) {
    if (response.destroyed || response.writableEnded) return;
    if (response.writableNeedDrain) {
      // Coalesce updates while one bounded snapshot drains. write(false) is
      // ordinary backpressure, not proof that the browser has disconnected.
      pendingClients.add(response);
      return;
    }
    response.write(payload);
  }

  function appendLog(source, message) {
    const clean = message.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
    if (!clean) {
      return;
    }
    if (source === 'stderr' && clean.startsWith('ERROR: ')) {
      lastNativeError = clean.slice(7);
    }
    state.logs.push({
      at: new Date().toISOString(),
      source,
      message: clean,
    });
    if (state.logs.length > logLimit) {
      state.logs.splice(0, state.logs.length - logLimit);
    }

    const encoder = clean.match(/Reverse display encoder: ([^ (]+)/);
    if (encoder) {
      state.encoder = encoder[1];
    }
    const latency = clean.match(/capture-to-decode round-trip: ([0-9.]+) ms/);
    if (latency) {
      state.latencyMs = Number(latency[1]);
      state.reconnecting = false;
    }
    broadcast();
  }

  function consumeOutput(source, chunk) {
    const combined = logRemainders[source] + chunk.toString('utf8');
    const lines = combined.split(/\r?\n/);
    logRemainders[source] = lines.pop() || '';
    for (const line of lines) {
      appendLog(source, line);
    }
  }

  function defaultRunCommand(executable, args, options = {}) {
    const { input, timeoutMs = 3500, maxOutputBytes = 1024 * 1024, ...spawnOptions } = options;
    return new Promise((resolve, reject) => {
      const child = spawnProcess(executable, args, {
        ...spawnOptions,
        windowsHide: true,
        shell: false,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Command timed out'));
      }, timeoutMs);
      if (child.stdin) {
        child.stdin.on('error', () => {}); // ADB may exit before reading stdin.
        child.stdin.end(input);
      }
      const consume = (source, chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          clearTimeout(timer);
          child.kill();
          reject(new Error('Command output exceeded the limit'));
          return;
        }
        if (source === 'stdout') stdout += chunk;
        else stderr += chunk;
      };
      child.stdout.on('data', (chunk) => consume('stdout', chunk));
      child.stderr.on('data', (chunk) => consume('stderr', chunk));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(stderr.trim() || `Command exited with code ${code}`));
        }
      });
    });
  }

  async function listDevices() {
    const result = await runCommand(currentRuntime().env.ADB, ['devices', '-l'], {
      env: currentRuntime().env,
    });
    return parseAdbDevices(result.stdout);
  }

  async function discoverWirelessDevices() {
    if (shuttingDown) throw new Error('The local service is shutting down.');
    if (discoveryAttempt) return discoveryAttempt;
    discoveryAttempt = (async () => {
      try {
        const runtime = currentRuntime();
        const result = await runCommand(runtime.env.ADB, ['mdns', 'services'], {
          env: runtime.env, timeoutMs: 5000, maxOutputBytes: 128 * 1024,
        });
        if (!/List of discovered mdns services/i.test(result.stdout)) throw new Error('Unavailable');
        const services = parseMdnsServices(result.stdout);
        return { services, message: services.length
          ? 'Choose a pairing address or a connection. Discovery does not start a stream.'
          : 'No advertised device found. Enable Wireless debugging on the same Wi-Fi, open the pairing-code dialog if needed, then discover again. Manual IP entry is also available.' };
      } catch {
        throw new Error('Wireless discovery is unavailable. Check ADB supports mDNS and both devices are on the same Wi-Fi, or enter the phone’s address manually.');
      }
    })();
    try { return await discoveryAttempt; }
    finally { discoveryAttempt = null; }
  }

  function cancelReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectSession = null;
    state.reconnecting = false;
    state.nextRetryAt = null;
  }

  function scheduleReconnect(session) {
    if (!session || reconnectSession !== session || shuttingDown) return false;
    if (session.attempts >= reconnectLimit) {
      cancelReconnect();
      state.error = `Automatic reconnection stopped after ${reconnectLimit} attempts. Check the phone and start again.`;
      return false;
    }
    session.attempts++;
    const delay = reconnectDelayMs * session.attempts;
    state.running = true; // Keep Stop available while waiting.
    state.reconnecting = true;
    state.reconnectAttempt = session.attempts;
    state.nextRetryAt = new Date(Date.now() + delay).toISOString();
    appendLog('gui', `Reconnecting to the selected device (attempt ${session.attempts}/${reconnectLimit})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (reconnectSession !== session || shuttingDown) return;
      void startStream(session.config, session).catch(() => {}); // State carries the error.
    }, delay);
    return true;
  }

  async function internetStatus() {
    if (readInternetStatus) return readInternetStatus();
    const candidates = platform === 'win32'
      ? [path.join(environment.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
      : ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/usr/bin/tailscale'];
    const executable = candidates.find(existsSync) || 'tailscale';
    try {
      const result = await runCommand(executable, ['status', '--json'], { timeoutMs: 4000,
        ...(platform === 'darwin' ? { env: { ...environment, TAILSCALE_BE_CLI: '1' } } : {}) });
      return summarizeTailnet(JSON.parse(result.stdout));
    } catch {
      return { ready: false, peers: [], message: 'Tailscale is not available. Install it on both devices, sign in to the same private network, then refresh. No account or device is enrolled automatically.' };
    }
  }

  async function pairWirelessDevice(body) {
    const { address, pairingCode } = sanitizePairingConfig(body);
    if (pairingInProgress) {
      throw new Error('Pairing is already in progress. Wait for it to finish.');
    }
    pairingInProgress = true;
    try {
      // Keep the short-lived secret out of argv, diagnostics, and stored state.
      const result = await runCommand(currentRuntime().env.ADB, ['pair', address], {
        input: `${pairingCode}\n`,
        timeoutMs: 15000,
        env: environment,
      });
      if (!/Successfully paired to/i.test(result.stdout)) {
        throw new Error('Pairing failed');
      }
      return { message: 'Paired. Close the pairing dialog on your phone. If the device does not appear, use Connect IP with the address and port on the main Wireless debugging screen.' };
    } catch {
      // Never reflect ADB output: some versions echo the pairing code.
      throw new Error('Could not pair. Keep the phone’s pairing-code dialog open, check both devices are on the same Wi-Fi, and retry with its current pairing address and code.');
    } finally {
      pairingInProgress = false;
    }
  }

  async function startStream(rawConfig, retrySession = null) {
    if (shuttingDown) throw new Error('The local service is shutting down.');
    if (retrySession && retrySession !== reconnectSession) throw new Error('Connection cancelled.');
    if (streamProcess || startAttempt || (!retrySession && state.running)) {
      throw new Error('A stream started by this control center is already running.');
    }
    const config = sanitizeStreamConfig(rawConfig);
    validateHostEncoder(config.encoder, platform);
    if (!retrySession) {
      cancelReconnect();
      state.reconnectAttempt = 0;
    }
    const attempt = new AbortController();
    startAttempt = attempt; // Reserve the slot before any asynchronous probe.
    state.running = true;
    state.stopping = false;
    state.reconnecting = Boolean(retrySession);
    state.nextRetryAt = null;
    state.config = config;
    state.error = null;
    state.latencyMs = null;
    state.encoder = null;
    state.command = null;
    state.lastExitCode = null;
    state.startedAt = new Date().toISOString();
    lastNativeError = null;
    streamStopRequested = false;
    broadcast();
    try {
      const readiness = await refreshReadiness();
      if (attempt.signal.aborted) throw new Error('Connection cancelled.');
      const transport = readiness.transports[config.connection];
      if (!transport.ready) throw new Error(transport.message);
      if (config.autoReconnect && ['usb', 'wifi'].includes(config.connection) && !config.serial) {
        const devices = (await listDevices()).filter((device) => device.authorized
          && device.transport === (config.connection === 'usb' ? 'USB' : 'Wi-Fi'));
        if (attempt.signal.aborted) throw new Error('Connection cancelled.');
        if (devices.length !== 1) throw new Error('Select one device before enabling automatic reconnection.');
        config.serial = devices[0].serial;
      }
      const runtime = currentRuntime();
      if (!runtime.executable) throw new Error('The streaming program is no longer available.');
      if (config.connection === 'internet') {
        const tailnet = await internetStatus();
        if (attempt.signal.aborted) throw new Error('Connection cancelled.');
        internetBridge = await bridgeOpener({ address: config.address,
          sessionKey: rawConfig.sessionKey, tailnet, signal: attempt.signal });
      }
      if (attempt.signal.aborted) throw new Error('Connection cancelled.');
      if (!retrySession && config.autoReconnect) reconnectSession = { config: { ...config }, attempts: 0 };
      const session = reconnectSession;
      const args = buildScrcpyArgs(config, internetBridge?.port);
      state.command = formatCommand(path.basename(runtime.executable), args);
      appendLog('gui', 'Starting ' + state.command);
      const child = spawnProcess(runtime.executable, args, {
        cwd: repoDir, env: runtime.env, windowsHide: true, shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      streamProcess = child;
      state.pid = child.pid ?? null;
      child.stdin.on('error', () => {}); // Child may exit before reading q.
      child.stdout.on('data', (chunk) => consumeOutput('stdout', chunk));
      child.stderr.on('data', (chunk) => consumeOutput('stderr', chunk));
      child.on('error', (error) => {
        state.error = error.message;
        appendLog('error', error.message);
      });
      let exitHandled = false;
      const handleExit = (code) => {
        if (exitHandled) return;
        exitHandled = true;
        clearTimeout(stopTimer);
        stopTimer = null;
        for (const source of ['stdout', 'stderr']) {
          if (logRemainders[source]) {
            appendLog(source, logRemainders[source]);
            logRemainders[source] = '';
          }
        }
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (streamProcess === child) streamProcess = null;
        internetBridge?.close();
        internetBridge = null;
        state.running = false;
        state.stopping = false;
        state.pid = null;
        state.lastExitCode = code;
        state.error = streamStopRequested ? null : state.error ?? (code ? lastNativeError ?? exitError(code) : null);
        const retryable = !streamStopRequested && (code === 2
          || (code === 1 && /^Reverse display stalled\b/.test(lastNativeError || ''))
          || (retrySession && code === 1 && state.latencyMs === null));
        streamStopRequested = false;
        if (state.error) appendLog('error', state.error);
        appendLog('gui', 'Stream stopped' + (code === null ? '' : ' (exit ' + code + ')'));
        if (!retryable || !scheduleReconnect(session)) cancelReconnect();
        broadcast();
      };
      child.on('exit', handleExit);
      child.on('close', handleExit);
      broadcast();
      return publicState();
    } catch (error) {
      internetBridge?.close();
      internetBridge = null;
      state.running = false;
      state.stopping = false;
      state.pid = null;
      state.error = attempt.signal.aborted ? null : error.message;
      if (attempt.signal.aborted || !retrySession || !scheduleReconnect(retrySession)) cancelReconnect();
      broadcast();
      throw new Error(attempt.signal.aborted ? 'Connection cancelled.' : error.message);
    } finally {
      if (startAttempt === attempt) startAttempt = null;
    }
  }

  function stopStream() {
    cancelReconnect();
    streamStopRequested = true;
    if (startAttempt) {
      state.stopping = true;
      startAttempt.abort();
      broadcast();
      return publicState();
    }
    if (!streamProcess) {
      state.running = false;
      state.stopping = false;
      state.error = null;
      broadcast();
      return publicState();
    }
    appendLog('gui', 'Stopping stream');
    streamStopRequested = true;
    state.stopping = true;
    broadcast();
    terminateStreamProcess(streamProcess);
    return publicState();
  }

  function writeJson(response, statusCode, value) {
    if (response.destroyed || response.writableEnded) return;
    const body = JSON.stringify(value);
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  }

  function readJson(request) {
    return new Promise((resolve, reject) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
        if (body.length > 32 * 1024) {
          request.destroy();
          reject(new Error('Request body is too large.'));
        }
      });
      request.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error('Request body is not valid JSON.'));
        }
      });
      request.on('error', reject);
    });
  }

  function isLocalRequest(request) {
    const hostname = (request.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '');
    return hostname === '127.0.0.1' || hostname === 'localhost';
  }

  const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };

  async function serveStatic(request, response, pathname) {
    let relativePath = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    let filePath = path.resolve(distDir, relativePath);
    if (!filePath.startsWith(`${distDir}${path.sep}`) && filePath !== distDir) {
      writeJson(response, 403, { error: 'Forbidden' });
      return;
    }
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        throw new Error('Not a file');
      }
    } catch {
      filePath = path.join(distDir, 'index.html');
      if (!existsSync(filePath)) {
        writeJson(response, 404, {
          error: 'GUI assets are not built. Run npm run dev or npm run build.',
        });
        return;
      }
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
    });
    createReadStream(filePath).on('error', () => response.destroy()).pipe(response);
  }

  const server = http.createServer(async (request, response) => {
    if (!isLocalRequest(request)) {
      writeJson(response, 403, { error: 'Display Bridge only accepts localhost requests.' });
      return;
    }

    try {
      const base = new URL(`http://${request.headers.host}`);
      const url = new URL(request.url || '/', base);
      if (url.origin !== base.origin) throw new Error('Invalid request target.');
      if (request.method === 'POST' && !isAllowedMutation(request.headers, port)) {
        writeJson(response, 403, { error: 'Use the local Display Bridge page to perform this action.' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/wireless/pair') {
        writeJson(response, 200, await pairWirelessDevice(await readJson(request)));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/wireless/discover') {
        writeJson(response, 200, await discoverWirelessDevices());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        await refreshReadiness();
        writeJson(response, 200, publicState());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/devices') {
        try {
          writeJson(response, 200, { devices: await listDevices(), error: null });
        } catch (error) {
          writeJson(response, 200, { devices: [], error: error.message });
        }
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/internet/status') {
        writeJson(response, 200, await internetStatus());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        clients.add(response);
        response.on('drain', () => {
          if (pendingClients.delete(response)) writeStatusEvent(response, `data: ${JSON.stringify(publicState())}\n\n`);
        });
        response.on('close', () => { clients.delete(response); pendingClients.delete(response); });
        writeStatusEvent(response, `data: ${JSON.stringify(publicState())}\n\n`);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/stream/start') {
        const body = await readJson(request);
        writeJson(response, 202, await startStream(body));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/stream/stop') {
        writeJson(response, 202, stopStream());
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        writeJson(response, 404, { error: 'Unknown API route.' });
        return;
      }
      await serveStatic(request, response, url.pathname);
    } catch (error) {
      writeJson(response, 400, { error: error.message });
    }
  });

  const heartbeat = setInterval(() => {
    for (const response of clients) {
      if (!response.destroyed && !response.writableEnded && !response.writableNeedDrain) response.write(': heartbeat\n\n');
    }
  }, 15000);
  heartbeat.unref();

  async function listen() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
    port = server.address().port;
    appendLog('gui', 'Local control service ready at http://' + host + ':' + port);
    return port;
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    stopStream();
    for (const response of clients) response.end();
    clients.clear();
    pendingClients.clear();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections();
    });
  }

  return { server, listen, shutdown, publicState };
}
