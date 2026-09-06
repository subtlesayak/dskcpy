import { isOverlayIp } from './internet.mjs';

const VALID_CONNECTIONS = new Set(['usb', 'wifi', 'ip', 'internet', 'browser']);
const VALID_ENCODERS = new Set([
  'auto',
  'h264_nvenc',
  'h264_amf',
  'h264_qsv',
  'h264_mf',
  'libx264',
  'h264_videotoolbox',
]);

export function validateHostEncoder(encoder, platform) {
  if (platform === 'darwin' && !['auto', 'h264_videotoolbox'].includes(encoder)) {
    throw new Error('The experimental Mac host requires Auto or Apple VideoToolbox.');
  }
  if (platform !== 'darwin' && encoder === 'h264_videotoolbox') {
    throw new Error('Apple VideoToolbox requires the experimental macOS host.');
  }
}

function numberInRange(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? Math.round(number)
    : fallback;
}

export function validateIpEndpoint(value) {
  if (typeof value !== 'string' || value.length > 64) {
    return false;
  }
  const match = value.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/);
  if (!match) {
    return false;
  }
  if (match[1].split('.').some((part) => Number(part) > 255)) {
    return false;
  }
  return !match[2] || (Number(match[2]) >= 1 && Number(match[2]) <= 65535);
}

export function sanitizeStreamConfig(input = {}) {
  const connection = VALID_CONNECTIONS.has(input.connection)
    ? input.connection
    : 'usb';
  const encoder = VALID_ENCODERS.has(input.encoder) ? input.encoder : 'auto';
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  const serial = typeof input.serial === 'string' ? input.serial.trim() : '';
  if (serial && (!/^[A-Za-z0-9._:-]{1,256}$/.test(serial) || serial.startsWith('-'))) {
    throw new Error('Invalid device identifier. Refresh devices and select the phone again.');
  }
  const wirelessSerial = serial.includes(':') || serial.includes('adb-tls-connect');
  if (serial && !['ip', 'internet'].includes(connection) && (connection === 'wifi') !== wirelessSerial) {
    throw new Error('The selected device does not match the connection method.');
  }

  if (connection === 'ip' && !validateIpEndpoint(address)) {
    throw new Error('Enter a valid IPv4 address, optionally followed by a port.');
  }
  if (connection === 'internet' && !isOverlayIp(address)) {
    throw new Error('Enter the phone’s Tailscale IPv4 address (100.x.x.x), without a port.');
  }

  return {
    connection,
    address,
    ...(serial && !['ip', 'internet'].includes(connection) ? { serial } : {}),
    maxSize: numberInRange(input.maxSize, 1920, 640, 3840),
    maxFps: numberInRange(input.maxFps, 60, 15, 240),
    bitRateMbps: numberInRange(input.bitRateMbps, 12, 2, 64),
    encoder,
    autoReconnect: input.autoReconnect === true && !['internet', 'browser'].includes(connection),
  };
}

export function sanitizePairingConfig(input = {}) {
  const address = typeof input.address === 'string' ? input.address.trim() : '';
  const pairingCode = typeof input.pairingCode === 'string' ? input.pairingCode.trim() : '';
  if (!validateIpEndpoint(address) || !address.includes(':')) {
    throw new Error('Enter the IP address and port from Pair device with pairing code.');
  }
  if (!/^\d{6}$/.test(pairingCode)) {
    throw new Error('Enter the six-digit pairing code shown on the phone.');
  }
  return { address, pairingCode };
}

export function isAllowedMutation(headers, port) {
  if (!headers['content-type']?.toLowerCase().startsWith('application/json')) {
    return false;
  }
  if (!headers.origin) {
    return true; // Local CLI clients do not send Origin.
  }
  try {
    const origin = new URL(headers.origin);
    return origin.protocol === 'http:'
      && ['127.0.0.1', 'localhost'].includes(origin.hostname)
      && [String(port), '5173'].includes(origin.port);
  } catch {
    return false;
  }
}

export function buildScrcpyArgs(config, bridgePort) {
  if (['internet', 'browser'].includes(config.connection) && (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535)) {
    throw new Error('Authenticate the private Internet connection before starting capture.');
  }
  const args = [
    '--reverse-display',
    '--verbosity=debug',
    '--port=27184:27199',
    ['internet', 'browser'].includes(config.connection) ? `--reverse-socket=${bridgePort}`
      : config.serial && config.connection !== 'ip' ? `--serial=${config.serial}`
      : config.connection === 'wifi' ? '--select-tcpip'
      : `--connection=${config.connection === 'ip' ? `ip:${config.address}` : config.connection}`,
    `--max-size=${config.maxSize}`,
    `--max-fps=${config.maxFps}`,
    `--video-bit-rate=${config.bitRateMbps}M`,
  ];
  if (config.encoder !== 'auto') {
    args.push(`--video-encoder=${config.encoder}`);
  }
  return args;
}

export function formatCommand(binaryName, args) {
  return [binaryName, ...args].join(' ');
}

export function parseAdbDevices(output) {
  const devices = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('List of devices attached') || line.startsWith('*')) {
      continue;
    }

    const [serial, state, ...fields] = line.split(/\s+/);
    if (!serial || !state) {
      continue;
    }
    const details = Object.fromEntries(
      fields
        .map((field) => field.split(/:(.*)/s))
        .filter(([key, value]) => key && value !== undefined),
    );
    devices.push({
      serial,
      state,
      model: (details.model || 'Android device').replaceAll('_', ' '),
      product: details.product || '',
      transport: serial.includes(':') || serial.includes('adb-tls-connect') ? 'Wi-Fi' : 'USB',
      authorized: state === 'device',
    });
  }
  return devices;
}
