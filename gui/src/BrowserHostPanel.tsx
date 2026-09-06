import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Globe2, Link2, Monitor, RefreshCw, Square, Usb, Wifi } from 'lucide-react';
import type { BridgeStatus, StreamConfig } from './types';
import { fetchStatus, stopStream } from './api';

const modes = [
  { id: 'usb', label: 'USB cable', detail: 'Android phone connected by cable', icon: Usb },
  { id: 'wifi', label: 'Same Wi-Fi', detail: 'Both devices on the same network', icon: Wifi },
  { id: 'ip', label: 'Direct IP', detail: 'Use a private network address', icon: Link2 },
  { id: 'internet', label: 'Internet / VPN', detail: 'Devices on different networks', icon: Globe2 },
  { id: 'local', label: 'This computer', detail: 'Try it here before connecting a phone', icon: Monitor },
];
const setupGuide = 'https://github.com/subtlesayak/dskcpy/blob/master/doc/browser-receiver.md';

export default function BrowserHostPanel({ status, config, online, onStatus }: {
  status: BridgeStatus; config: StreamConfig; online: boolean; onStatus: (status: BridgeStatus) => void;
}) {
  const [key, setKey] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const [transport, setTransport] = useState('local');
  const keyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const invitationHeading = useRef<HTMLHeadingElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const browser = status.browser;
  const active = Boolean(browser?.waiting || browser?.connected);
  // Recover the active mode after returning from another dashboard tab.
  const mode = active ? browser!.mode : transport;
  const remote = ['wifi', 'ip', 'internet'].includes(mode);
  const needsSetup = remote && !browser?.remoteAvailable;
  const readiness = status.readiness?.transports.browser;
  const adbCheck = status.readiness?.checks.find((check) => check.id === 'adb');
  const blockedReason = !online ? 'The desktop service is offline. Start dskcpy, then reload this page.'
    : status.stopping ? 'Wait for the current stream to stop.'
      : status.running && !browser?.connected ? 'Stop the current Android stream before creating a browser link.'
        : !status.readiness ? 'Checking whether this computer can stream…'
          : !readiness ? 'Restart the desktop service to load browser support, then reload this page.'
            : !readiness.ready ? readiness.message
              : mode === 'usb' && adbCheck && !adbCheck.ready ? adbCheck.message
                : needsSetup ? 'Set up a secure link, or choose USB cable or This computer.' : '';

  useEffect(() => {
    if (browser?.connected) { setKey(''); setMessage(''); setCopied(''); clearTimeout(keyTimer.current); }
  }, [browser?.connected]);
  useEffect(() => { if (key && browser?.waiting) invitationHeading.current?.focus(); }, [key, browser?.waiting]);
  useEffect(() => {
    if (!active && !busy && restoreFocus.current) { createButton.current?.focus(); restoreFocus.current = false; }
  }, [active, busy]);
  useEffect(() => () => clearTimeout(keyTimer.current), []);

  async function invite() {
    if (busy || active || blockedReason) return;
    setBusy(true); setError(''); setMessage(''); setCopied(''); setKey('');
    clearTimeout(keyTimer.current);
    try {
      const response = await fetch('/api/browser/invite', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...config,
          browserTransport: mode, browserSerial: config.connection === 'usb' ? config.serial : undefined }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not create a link. Try again.');
      // The mutation response is authoritative; do not wait for the SSE/poll refresh.
      onStatus(result.status ?? await fetchStatus());
      setKey(result.key); setUrl(result.url);
      keyTimer.current = setTimeout(() => {
        setKey(''); setCopied(''); setMessage('The connection code expired. Create a new link and code to try again.');
      }, Math.max(0, Date.parse(result.expiresAt) - Date.now()));
      setMessage('Link and code ready. Follow step 3 to start streaming.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a link. Try again.'); }
    finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true); setError(''); restoreFocus.current = true;
    try {
      onStatus(await stopStream()); clearTimeout(keyTimer.current); setKey(''); setCopied('');
      setMessage('Browser session ended. You can create another link.');
    } catch { restoreFocus.current = false; setError('Could not stop the session. Check the desktop service and try again.'); }
    finally { setBusy(false); }
  }
  async function copy(value: string, kind: 'link' | 'code') {
    try {
      await navigator.clipboard.writeText(value); setCopied(kind);
      setMessage(kind === 'link' ? 'Link copied. Open it on the device where you want to watch.' : 'Code copied. Paste it into the receiver page, then select Connect.');
    } catch { setMessage(`Copy is unavailable. Select the ${kind} in its field and copy it manually.`); }
  }

  return <section className="panel browser-host-panel" aria-labelledby="browser-title">
    <div className="panel-header">
      <div><p className="eyebrow">Browser receiver · no app to install</p><h2 id="browser-title">Watch this computer in a browser</h2></div>
      <span className="live-indicator"><Globe2 size={16} aria-hidden="true" />{browser?.connected ? 'Connected' : browser?.waiting ? 'Waiting for browser' : 'Experimental'}</span>
    </div>
    <p className="browser-intro">Choose a connection, then open the link on the device where you want to watch.</p>

    <fieldset className="browser-mode-picker" disabled={active || busy}>
      <legend><span className="browser-step-number" aria-hidden="true">1</span>Choose how to connect</legend>
      <div className="browser-mode-grid">
        {modes.map(({ id, label, detail, icon: Icon }) => <label className="browser-mode" key={id}>
          <input type="radio" name="browser-connection" value={id} checked={mode === id} onChange={() => {
            setTransport(id); setError(''); setMessage(''); setCopied('');
          }} />
          <Icon size={20} aria-hidden="true" />
          <span><strong>{label}</strong><small>{detail}</small></span>
        </label>)}
      </div>
    </fieldset>

    <div className="browser-step">
      <h3><span className="browser-step-number" aria-hidden="true">2</span>{active ? 'Connection prepared' : 'Create a link and code'}</h3>
      {mode === 'local' ? <p>Try it in another browser tab on this computer. This link will not work on a phone unless you choose USB cable.</p>
        : mode === 'usb' ? <p>Connect your Android phone by USB. Enable USB debugging and allow this computer on the phone. No dskcpy app is needed.</p>
          : needsSetup ? <div className="browser-setup-needed">
            <strong>One-time setup needed</strong>
            <p>{mode === 'internet' ? 'Connect both devices through a private VPN, such as Tailscale. Then set up a secure browser link on this computer.'
              : 'This computer needs a secure browser link before another device can connect. A plain IP address is not enough.'}</p>
            <p>No secure link is configured yet. USB cable and This computer do not need this setup.</p>
            <a href={setupGuide} target="_blank" rel="noreferrer">Read the secure-link setup guide <ExternalLink size={14} aria-hidden="true" /></a>
          </div>
            : <p>{mode === 'internet' ? 'Keep the private VPN connected on both devices. Your configured secure link will appear below.'
              : 'Keep both devices connected to the private network. Your configured secure link will appear below.'}</p>}
      {!active ? <>
        <div className="browser-actions">
          <button ref={createButton} className="stream-button browser-create" type="button" disabled={busy || Boolean(blockedReason)}
            aria-busy={busy} aria-describedby="browser-create-hint" onClick={invite}>
            {busy ? <RefreshCw size={18} className="spinning" aria-hidden="true" /> : <Link2 size={18} aria-hidden="true" />}
            {busy ? 'Creating link…' : 'Create link and code'}
          </button>
        </div>
        <p id="browser-create-hint" className="action-note">{blockedReason || 'Your screen is shared only after the connection code is entered in the receiver.'}</p>
      </> : <p className="browser-ready"><Check size={16} aria-hidden="true" />{browser?.connected ? 'Your browser is connected.' : 'Link created. Your screen is not being shared yet.'}</p>}
    </div>

    {key && browser?.waiting && <div className="browser-step browser-invitation">
      <h3 ref={invitationHeading} tabIndex={-1}><span className="browser-step-number" aria-hidden="true">3</span>{mode === 'local' ? 'Open the link in another tab' : 'Open the link on your receiving device'}</h3>
      <p>{mode === 'usb' ? 'On the connected Android phone, open this link in Chrome or Edge. Keep the USB cable connected.'
        : mode === 'local' ? 'Open the receiver below, paste the connection code, then select Connect.'
          : 'Send the link to your phone, tablet, or other computer. Open it in Chrome or Edge, paste the code, then select Connect.'}</p>
      <div className="browser-copy-field">
        <label htmlFor="browser-link">Receiver link</label>
        <div><input id="browser-link" value={url} readOnly spellCheck={false} autoComplete="off" />
          <button className="secondary-button" type="button" onClick={() => copy(url, 'link')}><Copy size={16} aria-hidden="true" />{copied === 'link' ? 'Link copied' : 'Copy link'}</button></div>
      </div>
      <div className="browser-copy-field">
        <label htmlFor="browser-code">Connection code</label>
        <div><input id="browser-code" value={key} readOnly autoComplete="off" spellCheck={false} aria-describedby="browser-code-help" />
          <button className="secondary-button" type="button" onClick={() => copy(key, 'code')}><Copy size={16} aria-hidden="true" />{copied === 'code' ? 'Code copied' : 'Copy code'}</button></div>
      </div>
      <p id="browser-code-help" className="action-note">One use · expires five minutes after creation. Share only with someone you trust: this code lets them view and control your computer.</p>
      {mode === 'local' && <a className="secondary-button browser-open" href={url} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />Open browser receiver</a>}
    </div>}
    {browser?.waiting && !key && <p className="inline-error">A link is waiting, but its code is no longer available here. Cancel this link and create a new one.</p>}
    {active && <div className="browser-actions">
      <button className="secondary-button" type="button" onClick={stop} disabled={busy}><Square size={16} aria-hidden="true" />{busy ? 'Stopping…' : browser?.waiting ? 'Cancel link' : 'Stop browser stream'}</button>
    </div>}
    <p role="status" className="action-note browser-feedback">{browser?.connected ? 'Streaming to your browser. Stop here or select Disconnect in the receiver to end sharing.' : message}</p>
    {error && <p className="inline-error" role="alert">{error}</p>}

    <details className="wireless-setup browser-details">
      <summary>Compatibility and advanced setup</summary>
      <p>Chrome and Edge are the initial test targets. Safari and iPhone still need device testing. USB browser mode is Android-only. Video, optional audio, and touch input use your <a href="#performance">Performance settings</a>.</p>
      <p>Wi-Fi, direct IP, and Internet/VPN require trusted HTTPS. For Tailscale Serve, configure <code>DSKCPY_VIEWER_ORIGIN</code> with receiver port <code>27180</code>. Never expose control port <code>27183</code> or use Funnel. No network access is enabled automatically.</p>
      <p><a href={setupGuide} target="_blank" rel="noreferrer">Read the browser receiver setup guide</a></p>
    </details>
  </section>;
}
