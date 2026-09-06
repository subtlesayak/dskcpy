export type ConnectionMode = 'usb' | 'wifi' | 'ip' | 'internet' | 'browser';
export interface InternetStatus {
  ready: boolean;
  message: string;
  peers: { address: string; name: string; online: boolean; route: 'direct' | 'unknown'; account: 'same' | 'different' | 'unknown' }[];
}
export type Encoder =
  | 'auto'
  | 'h264_nvenc'
  | 'h264_amf'
  | 'h264_qsv'
  | 'h264_mf'
  | 'h264_videotoolbox'
  | 'libx264';

export interface Device {
  serial: string;
  state: string;
  model: string;
  product: string;
  transport: 'USB' | 'Wi-Fi';
  authorized: boolean;
}

export interface StreamConfig {
  autoReconnect?: boolean;
  connection: ConnectionMode;
  serial?: string;
  address: string;
  maxSize: number;
  maxFps: number;
  bitRateMbps: number;
  encoder: Encoder;
}

export interface LogEntry {
  at: string;
  source: string;
  message: string;
}

export interface WirelessService {
  name: string;
  kind: 'pairing' | 'connect' | 'legacy';
  address: string;
}

export interface BridgeStatus {
  browser?: { waiting: boolean; connected: boolean; url: string | null; remote: boolean; remoteAvailable: boolean; mode: string; expiresAt: string | null };
  reconnecting: boolean;
  reconnectAttempt: number;
  reconnectLimit: number;
  nextRetryAt: string | null;
  readiness: {
    checks: { id: string; label: string; ready: boolean; message: string }[];
    transports: Record<ConnectionMode, { ready: boolean; message: string; required: string[] }>;
    checkedAt: string;
  } | null;
  running: boolean;
  stopping: boolean;
  config: StreamConfig | null;
  pid: number | null;
  encoder: string | null;
  latencyMs: number | null;
  command: string | null;
  startedAt: string | null;
  lastExitCode: number | null;
  error: string | null;
  logs: LogEntry[];
  hostPlatform: string;
  reverseDisplaySupported: boolean;
  binaryAvailable: boolean;
}
