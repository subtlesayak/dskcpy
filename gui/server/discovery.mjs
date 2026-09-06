import { isIP } from 'node:net';

// ADB already owns mDNS discovery. Read its cache without adding a scanner,
// probing unrelated hosts, or guessing the separate pairing/connect ports.
export function parseMdnsServices(output) {
  const services = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\S{1,256})\s+(_adb(?:-tls-(?:pairing|connect))?\._tcp)\.?\s+(\S+)$/);
    if (!match) continue;
    const [, name, type, endpoint] = match;
    const parts = endpoint.match(/^([^:]+):(\d{1,5})$/);
    if (!parts || isIP(parts[1]) !== 4) continue;
    const [a, b] = parts[1].split('.').map(Number);
    const local = a === 10 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254);
    const port = Number(parts[2]);
    if (!local || port < 1 || port > 65535) continue;
    const kind = type === '_adb-tls-pairing._tcp' ? 'pairing'
      : type === '_adb-tls-connect._tcp' ? 'connect' : 'legacy';
    const address = `${parts[1]}:${port}`;
    const key = `${kind}:${address}`;
    if (!services.has(key)) services.set(key, { name, kind, address });
    if (services.size >= 64) break;
  }
  return [...services.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.address.localeCompare(b.address));
}
