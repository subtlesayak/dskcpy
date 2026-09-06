import { useEffect, useRef, useState } from 'react';
import { Copy, Globe2, Square } from 'lucide-react';
import type { BridgeStatus, StreamConfig } from './types';
import { stopStream } from './api';

export default function BrowserHostPanel({ status, config, online }: {
  status: BridgeStatus; config: StreamConfig; online: boolean;
}) {
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [transport, setTransport] = useState('local');
  const keyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const browser = status.browser;
  const active = browser?.waiting || browser?.connected;
  useEffect(() => { if (browser?.connected) { setKey(''); setMessage(''); } }, [browser?.connected]);
  useEffect(() => () => clearTimeout(keyTimer.current), []);
  async function invite() {
    setBusy(true); setError(''); setMessage(''); setKey('');
    try {
      const response = await fetch('/api/browser/invite', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config,
          browserTransport: transport, browserSerial: config.connection === 'usb' ? config.serial : undefined }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not create a browser session.');
      setKey(result.key); setUrl(result.url);
      clearTimeout(keyTimer.current);
      keyTimer.current = setTimeout(() => setKey(''), Math.max(0, Date.parse(result.expiresAt) - Date.now()));
      setMessage('Key created. Waiting for one browser to connect.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a browser session.'); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError('');
    try { await stopStream(); setKey(''); setMessage('Browser session ended.'); }
    catch { setError('Could not stop the session. Check the local service.'); }
    finally { setBusy(false); }
  }
  async function copyKey() {
    try { await navigator.clipboard.writeText(key); setMessage('Session key copied. Share it only with your receiver.'); }
    catch { setMessage('Copy is unavailable. Select the key and copy it manually.'); }
  }
  return <section className="panel browser-host-panel" aria-labelledby="browser-title">
    <div className="panel-header"><div><p className="eyebrow">No app installation</p><h2 id="browser-title">Browser receiver</h2></div>
      <span className="live-indicator"><Globe2 size={16} aria-hidden="true" />{browser?.connected ? 'Connected' : browser?.waiting ? 'Waiting' : 'Experimental'}</span></div>
    <p>Stream this computer to a browser with H.264 video, optional Opus audio, and touch input. Uses your Performance settings. Chrome and Edge are the initial test targets; Safari and iPhone need device verification.</p>
    <label className="browser-transport">Browser connection
      <select value={transport} disabled={Boolean(active) || busy} onChange={(event) => setTransport(event.target.value)}>
        <option value="local">Local test · this computer</option>
        <option value="usb">USB · Android browser</option>
        <option value="wifi">Wi-Fi · trusted HTTPS</option>
        <option value="ip">Direct IP · trusted HTTPS</option>
        <option value="internet">Internet / VPN · trusted HTTPS</option>
      </select>
    </label>
    <p className="action-note">{transport === 'usb' ? 'Connect an Android device by USB and authorize debugging. Open the shown localhost address in its browser; no dskcpy APK is needed.'
      : transport === 'local' ? 'Test the receiver on this computer without a certificate.'
        : browser?.remoteAvailable ? 'Your configured HTTPS address will be shown with the session key.'
          : 'Remote HTTPS is not configured yet. Expand setup below. Plain HTTP IP addresses cannot run the video decoder securely.'}</p>
    <details className="wireless-setup"><summary>Connect another device securely</summary>
      <p>USB uses an ADB reverse tunnel. For Wi-Fi or direct IP, configure a trusted HTTPS address and certificate. Internet/VPN can use Tailscale Serve with <code>DSKCPY_VIEWER_ORIGIN</code> and receiver port <code>27180</code>. Never expose control port 27183 or use Funnel.</p>
      <p>See <a href="https://github.com/subtlesayak/dskcpy/blob/master/doc/browser-receiver.md" target="_blank" rel="noreferrer">the browser receiver setup guide</a>. Nothing is exposed to your network automatically.</p>
    </details>
    {active && <p className="action-note">{browser?.remote ? 'Trusted HTTPS receiver configured.' : browser?.mode === 'usb' ? 'USB tunnel · open this address in the connected Android browser.' : 'Local test only · this address does not work on another device.'}</p>}
    {key && browser?.waiting && <div className="browser-invitation">
      <label>One-use key · expires in five minutes<input aria-label="Browser session key" value={key} readOnly autoComplete="off" spellCheck={false} /></label>
      <button className="secondary-button" type="button" onClick={copyKey}><Copy size={16} aria-hidden="true" />Copy key</button>
      <a className="secondary-button" href={url} target="_blank" rel="noreferrer">Open receiver</a>
      <p className="action-note">{url} · Paste the key in the receiver. Anyone with the key and access to this address can view and control your desktop during this session.</p>
    </div>}
    {browser?.waiting && !key && <p className="action-note">An invitation is open. Its key is not stored; cancel it and create another if you refreshed this page.</p>}
    <div className="browser-actions">
      <button className="secondary-button" type="button" disabled={busy || !online || Boolean(active) || status.running || !status.readiness?.transports.browser?.ready} aria-busy={busy} onClick={invite}>
        <Globe2 size={17} aria-hidden="true" />{busy ? 'Working…' : 'Create browser session'}
      </button>
      {active && <button className="secondary-button" type="button" onClick={stop} disabled={busy}><Square size={16} aria-hidden="true" />{browser?.waiting ? 'Cancel invitation' : 'Stop browser stream'}</button>}
    </div>
    <p role="status" className="action-note">{browser?.connected ? 'Browser connected. Stop here or disconnect in the receiver to end capture.' : message}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
