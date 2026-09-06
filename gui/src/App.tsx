import {
  Activity,
  Apple,
  Check,
  CircleAlert,
  Copy,
  Cpu,
  Gauge,
  Globe2,
  Hand,
  Laptop,
  Link2,
  MonitorSmartphone,
  MousePointer2,
  Play,
  Radio,
  RefreshCw,
  Square,
  TerminalSquare,
  Usb,
  Wifi,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BrowserHostPanel from './BrowserHostPanel';

import {
  fetchDevices,
  discoverWirelessDevices,
  fetchStatus,
  fetchInternetStatus,
  pairWirelessDevice,
  startStream,
  stopStream,
  subscribeToStatus,
} from './api';
import type {
  BridgeStatus,
  ConnectionMode,
  Device,
  Encoder,
  StreamConfig,
  InternetStatus,
  WirelessService,
} from './types';

const emptyStatus: BridgeStatus = {
  reconnecting: false,
  reconnectAttempt: 0,
  reconnectLimit: 3,
  nextRetryAt: null,
  readiness: null,
  running: false,
  stopping: false,
  config: null,
  pid: null,
  encoder: null,
  latencyMs: null,
  command: null,
  startedAt: null,
  lastExitCode: null,
  error: null,
  logs: [],
  hostPlatform: 'Unknown',
  reverseDisplaySupported: false,
  binaryAvailable: false,
};

const presets = {
  latency: { maxSize: 1920, maxFps: 60, bitRateMbps: 12 },
  balanced: { maxSize: 1920, maxFps: 60, bitRateMbps: 16 },
  quality: { maxSize: 2560, maxFps: 60, bitRateMbps: 24 },
};

const views = {
  connection: { label: 'Connect', title: 'Stream this computer to Android' },
  device: { label: 'Device', title: 'Your Android connections' },
  performance: { label: 'Performance', title: 'Tune your stream' },
  activity: { label: 'Activity', title: 'Connection and stream diagnostics' },
};
type ViewName = keyof typeof views;
function viewFromHash(): ViewName {
  const name = window.location.hash.slice(1);
  return Object.hasOwn(views, name) ? name as ViewName : 'connection';
}

const encoderNames: Record<Encoder, string> = {
  auto: 'Auto (hardware first)',
  h264_nvenc: 'NVIDIA NVENC',
  h264_amf: 'AMD AMF',
  h264_qsv: 'Intel Quick Sync',
  h264_mf: 'Media Foundation',
  libx264: 'Software x264',
  h264_videotoolbox: 'Apple VideoToolbox (experimental)',
};

function commandPreview(config: StreamConfig) {
  const connection = config.connection === 'ip'
    ? `ip:${config.address || '192.168.1.20:5555'}`
    : config.connection;
  const args = [
    'scrcpy',
    '--reverse-display',
    '--verbosity=debug',
    '--port=27184:27199',
    config.connection === 'internet' ? '--reverse-socket=<authenticated-local-port>'
      : config.serial && config.connection !== 'ip' ? `--serial=${config.serial}`
      : config.connection === 'wifi' ? '--select-tcpip' : `--connection=${connection}`,
    `--max-size=${config.maxSize}`,
    `--max-fps=${config.maxFps}`,
    `--video-bit-rate=${config.bitRateMbps}M`,
  ];
  if (config.encoder !== 'auto') {
    args.push(`--video-encoder=${config.encoder}`);
  }
  return args.join(' ');
}

function validInternetSecret(value: string) {
  const trimmed = value.trim();
  return /^[23456789A-HJ-NP-Z]{26}$/i.test(trimmed) || /^[a-fA-F0-9]{32}$/.test(trimmed)
    || /^[a-z]{3,8}(( [a-z]{3,8}){2}|( [a-z]{3,8}){11})$/.test(trimmed.toLowerCase().replace(/\s+/g, ' '));
}

function ConnectionButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`segment-button ${active ? 'active' : ''}`}
      type="button"
      aria-pressed={active}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function FeatureRow({
  icon,
  label,
  value,
  planned = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  planned?: boolean;
}) {
  return (
    <div className="feature-row">
      <span className="feature-label">{icon}{label}</span>
      <span className={planned ? 'feature-planned' : 'feature-live'}>{value}</span>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState(emptyStatus);
  const [serviceOnline, setServiceOnline] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'starting' | 'stopping' | null>(null);
  const [copied, setCopied] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState('');
  const deviceRequest = useRef<ReturnType<typeof fetchDevices> | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const ipInput = useRef<HTMLInputElement>(null);
  const [pairing, setPairing] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [wirelessServices, setWirelessServices] = useState<WirelessService[]>([]);
  const [discoveryMessage, setDiscoveryMessage] = useState('');
  const [discoveryError, setDiscoveryError] = useState('');
  const pairingDetails = useRef<HTMLDetailsElement>(null);
  const pairingCodeInput = useRef<HTMLInputElement>(null);
  const [pairAddress, setPairAddress] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairMessage, setPairMessage] = useState('');
  const [pairError, setPairError] = useState('');
  const [internet, setInternet] = useState<InternetStatus>({ ready: false, peers: [], message: 'Check your private network to begin.' });
  const [checkingInternet, setCheckingInternet] = useState(false);
  const [sessionKey, setSessionKey] = useState('');
  const internetRequest = useRef<ReturnType<typeof fetchInternetStatus> | null>(null);
  const [activeSection, setActiveSection] = useState(viewFromHash);
  const viewTitle = useRef<HTMLHeadingElement>(null);
  const [config, setConfig] = useState<StreamConfig>({
    connection: 'usb',
    address: '',
    maxSize: 1920,
    maxFps: 60,
    bitRateMbps: 12,
    encoder: 'auto',
    autoReconnect: false,
  });

  const refreshDevices = useCallback(async (feedback = false) => {
    if (feedback) {
      setRefreshing(true);
      setRefreshNote('Checking device connections…');
    }
    const pending = deviceRequest.current ?? fetchDevices();
    deviceRequest.current = pending;
    try {
      const result = await pending;
      setDevices(result.devices);
      setDeviceError(result.error);
      setServiceOnline(true);
      if (feedback) setRefreshNote(result.error ? 'Device check failed. See the error below.'
        : result.devices.length ? `Checked · ${result.devices.length} device connection${result.devices.length === 1 ? '' : 's'} found.`
          : 'Checked · No device found. Choose a connection method below.');
    } catch (error) {
      setDeviceError(error instanceof Error ? error.message : 'Native helper is offline');
      setServiceOnline(false);
      if (feedback) setRefreshNote('Device check failed · Local service is offline.');
    } finally {
      if (deviceRequest.current === pending) deviceRequest.current = null;
      if (feedback) setRefreshing(false);
    }
  }, []);

  const refreshInternet = useCallback(async () => {
    if (internetRequest.current) return;
    setCheckingInternet(true);
    const pending = fetchInternetStatus();
    internetRequest.current = pending;
    try { setInternet(await pending); }
    catch { setInternet({ ready: false, peers: [], message: 'Could not check the private network. Make sure the local service is running.' }); }
    finally { internetRequest.current = null; setCheckingInternet(false); }
  }, []);

  useEffect(() => {
    if (config.connection === 'internet') void refreshInternet();
  }, [config.connection, refreshInternet]);

  useEffect(() => {
    fetchStatus()
      .then((next) => {
        setStatus(next);
        if (next.config && next.config.connection !== 'browser') setConfig(next.config);
        setServiceOnline(true);
      })
      .catch(() => setServiceOnline(false));
    refreshDevices();
    const timer = window.setInterval(() => refreshDevices(), 3000);
    const readinessTimer = window.setInterval(() => {
      fetchStatus().then(setStatus).catch(() => setServiceOnline(false));
    }, 15000);
    const unsubscribe = subscribeToStatus(
      (next) => {
        setStatus(next);
        setServiceOnline(true);
      },
      () => setServiceOnline(false),
    );
    return () => {
      window.clearInterval(timer);
      window.clearInterval(readinessTimer);
      unsubscribe();
    };
  }, [refreshDevices]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  useEffect(() => {
    const changeView = () => setActiveSection(viewFromHash());
    window.addEventListener('hashchange', changeView);
    return () => window.removeEventListener('hashchange', changeView);
  }, []);

  useEffect(() => {
    document.title = `${views[activeSection].label} · dskcpy`;
    viewTitle.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [activeSection]);

  const selectedDevice = useMemo(() => {
    if (config.connection === 'internet') return undefined;
    if (config.connection === 'ip') {
      const address = config.address.trim();
      return devices.find((device) => device.serial === (address.includes(':') ? address : `${address}:5555`));
    }
    const expectedTransport = config.connection === 'usb' ? 'USB' : 'Wi-Fi';
    const matching = devices.filter((device) => device.transport === expectedTransport);
    if (config.serial) return matching.find((device) => device.serial === config.serial);
    return matching.find((device) => device.authorized && device.serial.includes('adb-tls-connect'))
      ?? matching.find((device) => device.authorized) ?? matching[0];
  }, [config.connection, config.address, config.serial, devices]);

  const macHost = status.hostPlatform === 'macOS';
  const availableEncoders = Object.entries(encoderNames).filter(([encoder]) => macHost
    ? ['auto', 'h264_videotoolbox'].includes(encoder) : encoder !== 'h264_videotoolbox');
  const effectiveEncoder = availableEncoders.some(([encoder]) => encoder === config.encoder) ? config.encoder : 'auto';
  const effectiveConfig = useMemo(() => ({ ...config, encoder: effectiveEncoder,
    serial: ['ip', 'internet'].includes(config.connection) ? undefined : selectedDevice?.serial }), [config, effectiveEncoder, selectedDevice]);
  const internetPeer = internet.peers.find((peer) => peer.address === config.address.trim());
  const preview = useMemo(() => commandPreview(effectiveConfig), [effectiveConfig]);
  const localReadiness = status.readiness?.transports[config.connection];
  const canStart = serviceOnline
    && !status.browser?.waiting
    && Boolean(localReadiness?.ready)
    && status.binaryAvailable
    && status.reverseDisplaySupported
    && (config.connection === 'internet' ? internet.ready && Boolean(internetPeer?.online) && validInternetSecret(sessionKey)
      : config.connection === 'ip' || Boolean(selectedDevice?.authorized));
  const connecting = status.running && status.latencyMs === null;
  const startHint = !serviceOnline ? 'Start the local service to enable streaming.'
    : !localReadiness ? 'Checking local components…'
      : !localReadiness.ready ? localReadiness.message
    : !status.binaryAvailable ? 'Build the reverse-display program before starting.'
      : !status.reverseDisplaySupported ? 'Streaming from this host platform is not available yet.'
        : config.connection === 'internet' ? (!internet.ready ? internet.message : !internetPeer?.online
          ? 'Select an online phone from your private network, then enter its temporary passphrase or key.'
          : 'Choose Passphrase or Alphanumeric key in the phone app, then start an Internet session. No USB or ADB is used. Generate a new secret for each connection.')
        : selectedDevice && !selectedDevice.authorized ? 'Unlock the phone and authorize debugging, or reconnect it if it is offline.'
          : config.connection === 'usb' && !selectedDevice ? 'Connect USB and approve USB debugging on the phone.'
            : config.connection === 'wifi' && !selectedDevice ? 'Enable Wireless debugging and pair below, or use Connect IP. No USB cable needed on Android 11+.'
              : config.connection === 'ip' ? 'Use the connection port from Wireless debugging, not the pairing port. Port 5555 only works if legacy TCP/IP is already enabled.'
                : 'Ready to stream. Your selected connection will be used.';

  function chooseConnection(connection: ConnectionMode) {
    setConfig((current) => ({ ...current, connection, serial: undefined,
      autoReconnect: connection === 'internet' ? false : current.autoReconnect,
      address: current.connection === 'internet' || connection === 'internet' ? '' : current.address }));
    setSessionKey('');
    setActionError(null);
    if (connection === 'ip') window.location.hash = 'connection';
  }

  function choosePreset(nextPreset: keyof typeof presets) {
    setConfig((current) => ({ ...current, ...presets[nextPreset] }));
  }

  async function toggleStream() {
    if ((busy && !(busy === 'starting' && status.running)) || status.stopping) return;
    if (!status.running && config.connection === 'ip' && !ipInput.current?.reportValidity()) return;
    setBusy(status.running ? 'stopping' : 'starting');
    setActionError(null);
    const key = sessionKey;
    if (!status.running) setSessionKey('');
    try {
      const next = status.running ? await stopStream() : await startStream(effectiveConfig, key);
      setStatus(next);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Could not update stream');
    } finally {
      setBusy(null);
    }
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(preview);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 5000);
    } catch {
      setActionError('Clipboard access was blocked. Select the generated command and copy it manually.');
    }
  }

  async function pairDevice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pairing) return;
    setPairing(true);
    setPairMessage('Pairing with the phone… Keep its pairing dialog open.');
    setPairError('');
    const code = pairCode;
    setPairCode('');
    try {
      const result = await pairWirelessDevice(pairAddress, code);
      setPairMessage(result.message);
      await refreshDevices();
    } catch (error) {
      setPairMessage('');
      setPairError(error instanceof Error ? error.message : 'Pairing failed. Try a new code.');
    } finally {
      setPairing(false);
    }
  }

  const latency = status.latencyMs;
  async function discoverDevices() {
    if (discovering) return;
    setDiscovering(true);
    setWirelessServices([]);
    setDiscoveryError('');
    setDiscoveryMessage('Checking advertised wireless devices…');
    try {
      const result = await discoverWirelessDevices();
      setWirelessServices(result.services);
      setDiscoveryMessage(result.message);
    } catch (error) {
      setDiscoveryMessage('');
      setDiscoveryError(error instanceof Error ? error.message : 'Discovery failed. Try manual IP entry.');
    } finally { setDiscovering(false); }
  }

  function useWirelessService(service: WirelessService) {
    if (service.kind === 'pairing') {
      setPairAddress(service.address);
      setPairCode('');
      setPairMessage('Enter the six-digit code from this phone’s pairing dialog.');
      setPairError('');
      if (pairingDetails.current) pairingDetails.current.open = true;
      pairingCodeInput.current?.focus();
    } else {
      setConfig((current) => ({ ...current, connection: 'ip', serial: undefined, address: service.address }));
      setActionError(null);
      setDiscoveryMessage(`Selected ${service.address}. Start streaming when ready.`);
    }
  }
  const preset = (Object.keys(presets) as (keyof typeof presets)[]).find((name) => {
    const value = presets[name];
    return value.maxSize === config.maxSize && value.maxFps === config.maxFps && value.bitRateMbps === config.bitRateMbps;
  });

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><MonitorSmartphone size={20} /> dskcpy</div>
        <div className={`service-status ${serviceOnline ? 'online' : 'offline'}`}>
          <span className="status-dot" />
          {serviceOnline ? 'Local service ready' : 'Local service offline'}
        </div>
      </header>

      <aside className="sidebar" aria-label="Main navigation">
        <a className={`nav-item ${activeSection === 'connection' ? 'active' : ''}`} href="#connection" aria-current={activeSection === 'connection' ? 'page' : undefined}><Link2 size={19} />Connect</a>
        <a className={`nav-item ${activeSection === 'device' ? 'active' : ''}`} href="#device" aria-current={activeSection === 'device' ? 'page' : undefined}><MonitorSmartphone size={19} />Device</a>
        <a className={`nav-item ${activeSection === 'performance' ? 'active' : ''}`} href="#performance" aria-current={activeSection === 'performance' ? 'page' : undefined}><Gauge size={19} />Performance</a>
        <a className={`nav-item ${activeSection === 'activity' ? 'active' : ''}`} href="#activity" aria-current={activeSection === 'activity' ? 'page' : undefined}><TerminalSquare size={19} />Activity</a>
        <div className="sidebar-spacer" />
        <div className="local-only"><Globe2 size={17} />Web UI<br /><span>localhost only</span></div>
      </aside>

      <main className="workspace">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{views[activeSection].label}</p>
              <h1 ref={viewTitle} tabIndex={-1}>{views[activeSection].title}</h1>
            </div>
            <button className="secondary-button refresh-button" type="button" onClick={() => refreshDevices(true)} disabled={refreshing} aria-busy={refreshing}>
              <RefreshCw size={17} className={refreshing ? 'spinning' : ''} aria-hidden="true" />
              {refreshing ? 'Checking…' : 'Refresh devices'}
            </button>
          </div>
          <p className="refresh-note" role="status">{refreshNote}</p>

        <section className="connection-section" id="connection" hidden={activeSection !== 'connection'} aria-label="Connection setup">
          <div className="connection-row">
            <div className="segments" aria-label="Connection method">
              <ConnectionButton active={config.connection === 'usb'} icon={<Usb size={18} />} label="USB" onClick={() => chooseConnection('usb')} />
              <ConnectionButton active={config.connection === 'wifi'} icon={<Wifi size={18} />} label="Wi-Fi" onClick={() => chooseConnection('wifi')} />
              <ConnectionButton active={config.connection === 'ip'} icon={<Link2 size={18} />} label="Connect IP" onClick={() => chooseConnection('ip')} />
              <ConnectionButton active={config.connection === 'internet'} icon={<Globe2 size={18} />} label="Internet" onClick={() => chooseConnection('internet')} />
            </div>
            <div className="host-platform" aria-label="Detected host platform">
              {status.hostPlatform === 'macOS' ? <Apple size={17} /> : <Laptop size={17} />}
              <span>{status.hostPlatform}</span>
              <span className={status.reverseDisplaySupported && !macHost ? 'supported' : 'planned'}>
                {macHost ? 'experimental' : status.reverseDisplaySupported ? 'supported' : 'backend planned'}
              </span>
            </div>
          </div>

          {config.connection === 'ip' && (
            <label className="ip-field">
              Device IP address
              <input
                ref={ipInput}
                value={config.address}
                onChange={(event) => setConfig((current) => ({ ...current, address: event.target.value }))}
                placeholder="192.168.1.20:5555"
                required
                maxLength={64}
                pattern="[0-9]{1,3}(\.[0-9]{1,3}){3}(:[0-9]{1,5})?"
                aria-describedby="ip-help"
                inputMode="text"
                autoComplete="off"
              />
              <span id="ip-help">Enter IP:port from the phone’s main Wireless debugging screen. The pairing dialog uses a different port.</span>
            </label>
          )}
          {config.connection === 'internet' && (
            <div className="internet-setup" aria-label="Internet connection setup">
              <div className="internet-heading"><h2>Mobile data · Private network</h2>
                <button className="secondary-button" type="button" onClick={refreshInternet} disabled={checkingInternet || !serviceOnline} aria-busy={checkingInternet}>
                  <RefreshCw size={16} className={checkingInternet ? 'spinning' : ''} aria-hidden="true" />{checkingInternet ? 'Checking…' : 'Check private network'}
                </button>
              </div>
              <p role="status">{checkingInternet ? 'Checking Tailscale on this computer…' : internet.message}</p>
              <p>On the phone, choose <strong>3-word passphrase</strong>, <strong>12-word passphrase</strong> or <strong>Alphanumeric key</strong>, then tap <strong>Start Internet session</strong>. Three words are easier to type but less secure; use only your own trusted devices.</p>
              <details className="wireless-setup">
              <summary>First-time setup and privacy</summary>
              <ol>
                <li>Install <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">Tailscale</a> on both devices and sign in to the same private network. This is an external service; account and device enrollment are your choice.</li>
                <li>On the phone, connect Tailscale over mobile data. Open the updated dskcpy app and tap <strong>Start Internet session</strong>.</li>
                <li>Select the phone below and enter its temporary passphrase or key. Use the phone’s Copy button if needed. Keep dskcpy open, then start streaming.</li>
              </ol>
              </details>
              <details className="wireless-setup" id="cross-account-setup">
                <summary>Connect across accounts</summary>
                <p>Use separate Tailscale logins without sharing passwords. Access requires an invitation; knowing an IP address or session key alone is not enough.</p>
                <ol>
                  <li><strong>Phone owner:</strong> open <a href="https://console.tailscale.com/admin/machines" target="_blank" rel="noreferrer">Tailscale devices</a>, choose the Android phone → Share, and send a single-use invitation to the computer owner. Share the <strong>phone</strong>, because this computer initiates the connection.</li>
                  <li><strong>Computer owner:</strong> accept the invitation using your own account. Keep Tailscale connected, then check the private network and select the phone below. Use the address listed on this computer; a shared phone’s address can differ from the one it displays.</li>
                  <li><strong>Both people:</strong> start a phone session and privately provide its <strong>12-word passphrase or alphanumeric key</strong> to the computer owner. Start streaming only with someone you trust: the phone can view the desktop and send touch input.</li>
                </ol>
                <p>Alternatively, <a href="https://tailscale.com/docs/features/sharing/how-to/invite-any-user" target="_blank" rel="noreferrer">invite the other account into one private network</a> and connect both devices to that network. Network policy must allow computer → phone on TCP 27182. No public port forwarding.</p>
                <div className="internet-help-actions">
                  <button className="secondary-button" type="button" onClick={refreshInternet} disabled={checkingInternet || !serviceOnline} aria-busy={checkingInternet}>
                    <RefreshCw size={16} className={checkingInternet ? 'spinning' : ''} aria-hidden="true" />{checkingInternet ? 'Checking…' : 'Check shared phones'}
                  </button>
                  <a href="https://tailscale.com/docs/features/sharing" target="_blank" rel="noreferrer">Sharing and revoking access ↗</a>
                </div>
              </details>
              <div className="pair-fields">
                <label>Private phone IP
                  <input value={config.address} list="internet-peers" onChange={(event) => { setConfig((current) => ({ ...current, address: event.target.value })); setSessionKey(''); }} placeholder="100.x.x.x" autoComplete="off" maxLength={15} aria-describedby="internet-note" />
                  <datalist id="internet-peers">{internet.peers.map((peer) => <option key={peer.address} value={peer.address}>{peer.name} · {peer.online ? 'Online' : 'Offline'}</option>)}</datalist>
                </label>
                <label>Passphrase or alphanumeric key
                  <input type="password" value={sessionKey} onChange={(event) => setSessionKey(event.target.value)} maxLength={160} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="3 or 12 words, or 26 characters" aria-describedby="internet-note" />
                </label>
              </div>
              {internet.ready && internet.peers.length === 0 && <p>No Android phones are visible. Connect the phone, or use “Connect across accounts” to set up an invitation, then check again.</p>}
              {internet.peers.map((peer) => <button key={peer.address} className="secondary-button internet-peer" type="button" disabled={!peer.online} aria-pressed={config.address === peer.address} onClick={() => { setConfig((current) => ({ ...current, address: peer.address })); setSessionKey(''); }}>
                {config.address === peer.address ? <Check size={16} aria-hidden="true" /> : <MonitorSmartphone size={16} aria-hidden="true" />}{peer.name} · {peer.address} · {peer.online ? 'Online' : 'Offline'}{peer.account === 'different' ? ' · Different account' : peer.account === 'same' ? ' · Same account' : ''}
              </button>)}
              {internetPeer?.account === 'different' && <p role="status">Selected phone belongs to another account. Network visibility does not confirm permission to stream: use a fresh 12-word passphrase or alphanumeric key and confirm both people agree.</p>}
              <p id="internet-note">VPN-encrypted video and touch; a single-use passphrase or key authorizes this session. Neither is saved in settings, URLs or logs. No public debugging port. Internet latency depends on the route; relay connections can be slower.</p>
              <p>Mobile data warning: 12 Mbps is approximately 90 MB per minute before network overhead. Lower bitrate or frame rate in <a href="#performance">Performance</a> if needed.</p>
            </div>
          )}
          {(config.connection === 'wifi' || config.connection === 'ip') && (
            <div className="wireless-discovery" aria-label="Wireless discovery">
              <button className="secondary-button" type="button" onClick={discoverDevices}
                disabled={discovering || !serviceOnline || pairing || status.running} aria-busy={discovering}>
                <RefreshCw size={16} className={discovering ? 'spinning' : ''} aria-hidden="true" />
                {discovering ? 'Discovering…' : 'Discover wireless devices'}
              </button>
              <p className="action-note" role="status">{discoveryMessage || 'Find phones advertising Wireless debugging on this Wi-Fi.'}</p>
              {discoveryError && <p className="inline-error" role="alert">{discoveryError}</p>}
              {wirelessServices.map((service) => <div className="device-row" key={`${service.kind}:${service.address}`}>
                <Wifi size={20} aria-hidden="true" />
                <div><strong>{service.kind === 'pairing' ? 'Pairing service' : service.kind === 'connect' ? 'Wireless connection' : 'Legacy ADB connection'}</strong>
                  <code>{service.address}</code><span>{service.name}</span></div>
                <button className="secondary-button" type="button" disabled={pairing || status.running}
                  onClick={() => useWirelessService(service)}>{service.kind === 'pairing' ? 'Use pairing address' : 'Use connection'}</button>
              </div>)}
            </div>
          )}
          {(config.connection === 'wifi' || config.connection === 'ip') && (
            <details className="wireless-setup" ref={pairingDetails}>
              <summary>Pair a phone without USB <span>Android 11+</span></summary>
              <p>On the phone: Settings → Developer options → Wireless debugging → Pair device with pairing code. Keep both devices on the same trusted Wi-Fi.</p>
              <form onSubmit={pairDevice}>
                <div className="pair-fields">
                  <label>Pairing IP and port
                    <input value={pairAddress} onChange={(event) => setPairAddress(event.target.value)} placeholder="192.168.1.20:37123" required maxLength={64} autoComplete="off" disabled={pairing} />
                  </label>
                  <label>Six-digit pairing code
                    <input ref={pairingCodeInput} type="password" inputMode="numeric" value={pairCode} onChange={(event) => setPairCode(event.target.value)} required pattern="[0-9]{6}" maxLength={6} autoComplete="off" disabled={pairing} />
                  </label>
                  <button className="secondary-button" type="submit" disabled={pairing || !serviceOnline} aria-busy={pairing}>
                    {pairing ? <RefreshCw size={16} className="spinning" aria-hidden="true" /> : <Wifi size={16} aria-hidden="true" />}
                    {pairing ? 'Pairing…' : 'Pair phone'}
                  </button>
                </div>
                <p className="action-note" role="status">{pairMessage}</p>
                {pairError && <p className="inline-error" role="alert">{pairError}</p>}
              </form>
              <p>After pairing, refresh devices. If auto-connect is unavailable, choose Connect IP and use the connection address from the main Wireless debugging screen.</p>
            </details>
          )}
          <label className="reconnect-option">
            <input type="checkbox" checked={Boolean(config.autoReconnect)}
              disabled={status.running || config.connection === 'internet'}
              onChange={(event) => setConfig((current) => ({ ...current, autoReconnect: event.target.checked }))} />
            Reconnect automatically after connection loss (up to 3 attempts)
          </label>
          {config.connection === 'internet' && <p className="action-note">Internet sessions require a new phone secret after disconnection. Reconnect manually.</p>}
        </section>

        {activeSection === 'device' && (
          <section className="device-inventory" aria-label="Available device connections">
            <p className="action-note">USB and wireless entries can represent the same phone. Choose the transport you want to use.</p>
            {devices.length ? devices.map((device) => (
              <div className="device-row" key={device.serial}>
                {device.transport === 'USB' ? <Usb size={22} aria-hidden="true" /> : <Wifi size={22} aria-hidden="true" />}
                <div><strong>{device.model}</strong><code>{device.serial}</code><span>{device.transport} · {device.authorized ? 'Authorized' : device.state}</span></div>
                <button className="secondary-button" type="button" aria-pressed={selectedDevice?.serial === device.serial} disabled={!device.authorized} onClick={() => {
                  setConfig((current) => ({ ...current, connection: device.transport === 'USB' ? 'usb' : 'wifi', serial: device.serial }));
                  setActionError(null);
                }}>{selectedDevice?.serial === device.serial ? <><Check size={16} aria-hidden="true" />Selected</> : `Use ${device.transport}`}</button>
              </div>
            )) : <div className="connection-recovery">No connections detected. <a className="secondary-button" href="#connection">Set up a connection</a></div>}
          </section>
        )}

        <div className="dashboard-grid" hidden={activeSection === 'activity'}>
          <section className="panel device-panel" id="device" aria-labelledby="device-title" hidden={(activeSection !== 'connection' && activeSection !== 'device') || (activeSection === 'connection' && Boolean(status.browser?.waiting || status.browser?.connected))}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Android target</p>
                <h2 id="device-title">{config.connection === 'internet' ? internetPeer?.name || 'Choose a private-network phone' : selectedDevice?.model || (config.connection === 'ip' && config.address ? 'Connect to this address' : 'No device detected')}</h2>
              </div>
              <span className={`badge ${selectedDevice?.authorized ? 'connected' : 'waiting'}`}>
                <span className="status-dot" />
                {config.connection === 'internet' ? status.running ? connecting ? 'Connecting' : 'Streaming' : 'Not streaming' : selectedDevice?.authorized ? 'Connected' : selectedDevice ? selectedDevice.state : 'Waiting'}
              </span>
            </div>

            {!selectedDevice && !['ip', 'internet'].includes(config.connection) && (
              <div className="connection-recovery">
                <span>{config.connection === 'wifi' ? 'Already paired? Enter the phone’s connection address.' : 'Prefer a cable-free connection?'}</span>
                <button className="secondary-button" type="button" onClick={() => chooseConnection('ip')}><Link2 size={16} aria-hidden="true" />Enter phone address</button>
              </div>
            )}

            <div className="device-summary">
              <div className="device-glyph"><MonitorSmartphone size={55} strokeWidth={1.4} /></div>
              <dl>
                <div><dt>Connection</dt><dd>{config.connection === 'internet' ? 'Internet via Tailscale' : config.connection === 'ip' ? 'Direct IP' : selectedDevice?.transport || '—'}</dd></div>
                <div><dt>Device</dt><dd>{selectedDevice?.serial || (['ip', 'internet'].includes(config.connection) && config.address.trim()) || 'Choose a device connection'}</dd></div>
                <div><dt>Input</dt><dd>{macHost ? 'Mouse + two-finger scroll' : 'Native touch injection'}</dd></div>
                <div><dt>Transport</dt><dd>{config.connection === 'internet' ? 'Private VPN · No ADB' : config.connection === 'usb' ? 'ADB over USB' : 'ADB over TCP/IP'}</dd></div>
              </dl>
            </div>

            {((config.connection !== 'internet' && deviceError) || actionError || status.error) && (
              <div className="inline-error" role="alert">
                <CircleAlert size={17} />
                <span>{actionError || status.error || deviceError}</span>
              </div>
            )}

            <button
              className={`stream-button ${status.running ? 'stop' : ''}`}
              type="button"
              disabled={(Boolean(busy) && !(busy === 'starting' && status.running)) || status.stopping || (!status.running && !canStart)}
              aria-busy={Boolean(busy) || status.stopping}
              aria-describedby="stream-hint"
              onClick={toggleStream}
            >
              {busy || status.stopping ? <RefreshCw size={18} className="spinning" aria-hidden="true" /> : status.running ? <Square size={18} fill="currentColor" aria-hidden="true" /> : <Play size={19} fill="currentColor" aria-hidden="true" />}
              {busy === 'stopping' || status.stopping ? 'Stopping…' : status.reconnecting ? 'Cancel reconnection' : connecting ? 'Cancel connection' : busy === 'starting' ? 'Starting…' : status.running ? 'Stop streaming' : status.error && status.lastExitCode !== null ? 'Reconnect' : 'Start streaming'}
            </button>
            <p id="stream-hint" className="action-note" role="status">{status.stopping ? 'Stopping the stream and releasing the connection…' : status.reconnecting ? `Reconnecting to the selected device · attempt ${status.reconnectAttempt} of ${status.reconnectLimit}. You can cancel at any time.` : connecting ? 'Connecting and waiting for the first decoded frames…' : status.running ? 'Streaming. Connection and quality changes apply the next time you start.' : startHint}</p>
            {macHost && <p className="action-note">Experimental Mac host: allow Screen &amp; System Audio Recording and Accessibility for the launching Terminal or dskcpy in System Settings → Privacy &amp; Security. Restart the launcher after granting access. To hear desktop audio, enable phone audio in dskcpy on Android.</p>}
            {status.readiness && (
              <ul className="readiness-checks" aria-label="Local component checks">
                {status.readiness.checks.filter((check) => localReadiness?.required.includes(check.id)).map((check) => (
                  <li key={check.id} data-ready={check.ready}>
                    <span aria-hidden="true">{check.ready ? '✓' : '!'}</span>
                    <span>{check.label}: {check.ready ? 'Ready' : check.message}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="command-box">
              <div className="command-label">Generated command <span className="copy-feedback" role="status">{copied ? 'Copied' : ''}</span></div>
              <code>{preview}</code>
              <button type="button" onClick={copyCommand} aria-label={copied ? 'Command copied' : 'Copy generated command'}>
                <span className={`copy-icon-stack ${copied ? 'copied' : ''}`} aria-hidden="true">
                  <Copy className="copy-icon" size={17} />
                  <Check className="check-icon" size={17} />
                </span>
              </button>
            </div>
          </section>

          <section className="panel performance-panel" id="performance" aria-labelledby="performance-title" hidden={activeSection !== 'performance'}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">Live pipeline</p>
                <h2 id="performance-title">Performance</h2>
              </div>
              <span className="live-indicator"><Radio size={15} />{status.stopping ? 'Stopping' : status.reconnecting ? 'Reconnecting' : connecting ? 'Connecting' : status.running ? 'Live' : 'Idle'}</span>
            </div>
            <p className="action-note">{status.running ? 'Changes apply to your next stream. Stop and restart from Connect to apply them.' : 'Choose a preset or adjust individual settings, then start from Connect.'} <a href="#connection">Go to Connect</a></p>

            <div className="preset-tabs" aria-label="Performance preset">
              {(['latency', 'balanced', 'quality'] as const).map((name) => (
                <button
                  key={name}
                  className={preset === name ? 'active' : ''}
                  type="button"
                  aria-pressed={preset === name}
                  onClick={() => choosePreset(name)}
                >
                  {name === 'latency' ? 'Low latency' : name[0].toUpperCase() + name.slice(1)}
                </button>
              ))}
            </div>
            <p className="action-note" role="status">{preset ? (preset === 'latency' ? 'Low latency' : preset[0].toUpperCase() + preset.slice(1)) : 'Custom'} settings · {config.maxSize}px cap · {config.maxFps} FPS · {config.bitRateMbps} Mbps</p>

            <div className="settings-grid">
              <label>Resolution cap
                <select value={config.maxSize} onChange={(event) => setConfig((current) => ({ ...current, maxSize: Number(event.target.value) }))}>
                  <option value={1280}>1280</option>
                  <option value={1600}>1600</option>
                  <option value={1920}>1920</option>
                  <option value={2560}>2560</option>
                </select>
              </label>
              <label>Frame rate
                <select value={config.maxFps} onChange={(event) => setConfig((current) => ({ ...current, maxFps: Number(event.target.value) }))}>
                  <option value={30}>30 FPS</option>
                  <option value={60}>60 FPS</option>
                  <option value={90}>90 FPS</option>
                  <option value={120}>120 FPS</option>
                </select>
              </label>
              <label>Bitrate
                <select value={config.bitRateMbps} onChange={(event) => setConfig((current) => ({ ...current, bitRateMbps: Number(event.target.value) }))}>
                  <option value={8}>8 Mbps</option>
                  <option value={12}>12 Mbps</option>
                  <option value={16}>16 Mbps</option>
                  <option value={24}>24 Mbps</option>
                  <option value={32}>32 Mbps</option>
                </select>
              </label>
              <label>Encoder
                <select value={effectiveEncoder} onChange={(event) => setConfig((current) => ({ ...current, encoder: event.target.value as Encoder }))}>
                  {availableEncoders.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>

            <div className="latency-card">
              <div>
                <span>{status.config?.connection === 'browser' ? 'Capture → browser decode' : macHost ? 'Encode → Android decode' : 'Capture → Android decode'}</span>
                <strong>{latency === null ? '—' : `${Math.round(latency)} ms`}</strong>
              </div>
              <p className="action-note">{latency === null ? status.running ? 'Waiting for the first decode acknowledgement…' : 'No measurement yet. Start a stream to receive real latency data.' : status.running ? 'Latest measured decode acknowledgement.' : 'Last measurement from the previous stream.'}</p>
              <small>{macHost ? 'Measured from encode submission to decode acknowledgement; excludes capture wait and physical display scan-out.' : 'This measures decode acknowledgement, not physical display scan-out.'}</small>
            </div>

            <div className="feature-list">
              <FeatureRow icon={<Hand size={16} />} label="Touch input" value={macHost ? 'Mouse + two-finger scroll' : 'Native'} />
              {macHost && <FeatureRow icon={<Laptop size={16} />} label="Mac audio to phone" value="Opus · experimental" planned />}
              <FeatureRow icon={<MousePointer2 size={16} />} label="Cursor" value="Visible" />
              <FeatureRow icon={<Cpu size={16} />} label="Encoder" value={status.encoder ? encoderNames[status.encoder as Encoder] || status.encoder : encoderNames[effectiveEncoder]} />
              <FeatureRow icon={<Activity size={16} />} label="Frame policy" value="Newest wins" />
              <FeatureRow icon={<Globe2 size={16} />} label="Remote web viewer" value="Experimental · Connect to set up" planned />
            </div>
          </section>
        </div>

        {activeSection === 'connection' && <BrowserHostPanel status={status} config={effectiveConfig} online={serviceOnline} onStatus={setStatus} />}

        <section className="panel activity-panel" id="activity" aria-labelledby="activity-title" hidden={activeSection !== 'activity'}>
          <div className="panel-header">
            <div>
              <p className="eyebrow">Diagnostics</p>
              <h2 id="activity-title">Activity</h2>
            </div>
            <span className="log-count">{status.logs.length} events</span>
          </div>
          <p className="action-note">{status.running ? 'Live stream diagnostics' : 'Stream idle'} · {status.error ? 'Last stream reported an error' : 'No current stream error'}. Showing the latest {Math.min(24, status.logs.length)} events. <a href="#connection">Go to Connect</a></p>
          <div className="log-view" role="log" aria-live="polite">
            {status.logs.length === 0 ? (
              <div className="empty-log">Connect a device and start streaming to see live diagnostics.</div>
            ) : status.logs.slice(-24).map((entry, index) => (
              <div className={`log-line ${entry.source}`} key={`${entry.at}-${index}`}>
                <time>{new Date(entry.at).toLocaleTimeString([], { hour12: false })}</time>
                <span>{entry.message}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
