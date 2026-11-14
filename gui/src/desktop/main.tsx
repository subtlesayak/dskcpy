import TrustedDevicesPanel, { type DeviceAction, type DeviceAPI, type TrustedDevices } from '../TrustedDevicesPanel';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import { ArrowRight, Check, Copy, Monitor, ShieldCheck, Square, Wifi, Usb } from 'lucide-react';
import './style.css';

type Phase = 'usb-tool' | 'usb-device' | 'usb-authorize' | 'usb-select' | 'checking' | 'installation' | 'screen-permission' | 'control-permission' | 'network' | 'route-conflict' | 'private-link' | 'ready' | 'preparing' | 'inviting' | 'sharing' | 'error';
type Snapshot = { phase: Phase; connection?: 'internet' | 'usb';
  usb?: { available: boolean; error: boolean; selected: string | null; devices: { id: string; name: string; state: 'ready' | 'unauthorized' | 'offline' }[] }; permissions: { screen: boolean; control: boolean }; route: { connected: boolean; ready: boolean; conflict: boolean };
  startup?: { available: boolean; requested: boolean; enabled: boolean; requiresApproval: boolean; error: string | null };
  features: { keyboard: boolean; clipboard?: boolean }; clipboardAllowed?: boolean; error: string | null; invitation: { joinUrl: string; expiresAt: number; openedOnPhone?: boolean } | null; canStop: boolean };
type HostAPI = { setClipboardAllowed?(allowed: boolean): Promise<Snapshot>; setConnection?(connection: 'internet' | 'usb'): Promise<Snapshot>; selectUsbDevice?(id: string): Promise<Snapshot>; trustedList?(): Promise<TrustedDevices>; trustedAction?(action: DeviceAction, id?: string): Promise<TrustedDevices>; snapshot(): Promise<Snapshot>; start(): Promise<Snapshot>; stop(): Promise<Snapshot>; refresh(): Promise<Snapshot>;
  screenPermission(): Promise<void>; controlPermission(): Promise<void>; privateSetup(): Promise<Snapshot>; tailscale(): Promise<void>;
  copyInvitation(): Promise<boolean>; setOpenAtLogin(enabled: boolean): Promise<unknown>; onChange(callback: (snapshot: Snapshot) => void): () => void };
declare global { interface Window { dskcpyHost?: HostAPI } }
const copy: Record<Phase, { title: string; description: string; action?: string }> = {
  'usb-tool': { title: 'The USB component is unavailable', description: 'Install a fresh copy of dskcpy Host with its USB tools, then open it again. You can also choose Private network.' },
  'usb-device': { title: 'Connect your Android phone', description: 'Use a USB data cable and unlock the phone. Turn on Developer options → USB debugging, then select Check again. If it is still missing, try another cable or USB port. Windows may need the phone maker’s USB driver.' },
  'usb-authorize': { title: 'Allow this computer on your phone', description: 'Unlock the phone and accept its Allow USB debugging prompt. If no prompt appears, reconnect the cable. Then select Check again.' },
  'usb-select': { title: 'Choose the phone to connect', description: 'Select the phone you want to share with below. If your previous phone disconnected, choose it again after reconnecting.' },
  checking: { title: 'Let’s get your computer ready', description: 'Checking the app’s streaming components…' },
  installation: { title: 'The app installation is incomplete', description: 'A required streaming component is missing or could not load. Install a fresh copy of dskcpy Host, then open it again.' },
  'screen-permission': { title: 'Allow your screen to be shared', description: 'Allow dskcpy Host when macOS asks. If System Settings opens, turn it on under Screen & System Audio Recording. If asked to quit, reopen dskcpy afterward.', action: 'Allow screen sharing' },
  'control-permission': { title: 'Allow remote mouse and keyboard', description: 'In System Settings → Accessibility, turn on dskcpy Host. This lets your connected device control this computer.', action: 'Open control permissions' },
  network: { title: 'Connect your devices privately', description: 'Open Tailscale on both devices. Sign in or accept a device share so your receiving device can reach this computer. Return here when both are connected.', action: 'Get Tailscale' },
  'route-conflict': { title: 'This private address is already in use', description: 'Another app uses the connection address dskcpy needs. Its settings have been kept. Ask the person who set up Tailscale to choose a dedicated address for dskcpy.' },
  'private-link': { title: 'Set up your private connection', description: 'Do this once to let your connected Tailscale devices reach dskcpy. You choose when screen sharing starts.', action: 'Set up connection' },
  ready: { title: 'Your computer, wherever you are', description: 'Start sharing, then send the link or scan the QR on your other device. Keep this computer awake and connected.', action: 'Start sharing' },
  preparing: { title: 'Preparing your connection…', description: 'Waiting for your other device to connect. Use Cancel invitation below to stop.' },
  inviting: { title: 'Open this on your other device', description: 'Keep Tailscale connected there. Scan this QR with its camera, or send the private link.' },
  sharing: { title: 'Your screen is being shared', description: 'The connected device can see your whole screen, hear desktop audio and use mouse and keyboard. Stop sharing to end its access.' },
  error: { title: 'Let’s get you connected', description: 'Sharing could not start. Check your setup and try again.', action: 'Try again' },
};
function App() {
  const api = window.dskcpyHost;
  const deviceAPI = useRef<DeviceAPI | null>(api?.trustedList && api?.trustedAction ? { list: api.trustedList, action: api.trustedAction } : null);
  const [state, setState] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState(''); const [qr, setQr] = useState('');
  const [pending, setPending] = useState(false); const [stopping, setStopping] = useState(false);
  const operation = useRef(0); const heading = useRef<HTMLHeadingElement>(null);
  const phase = state?.phase || 'checking';
  const usb = state?.connection === 'usb';
  useEffect(() => { heading.current?.focus(); }, [phase]);
  useEffect(() => {
    if (!api) { setNotice('Open the installed dskcpy Host app to share this computer.'); return; }
    let live = true;
    api.snapshot().then(value => { if (live) setState(value); }).catch(() => setNotice('Reopen dskcpy to finish loading.'));
    const unsubscribe = api.onChange(value => { if (live) setState(value); });
    return () => { live = false; unsubscribe(); };
  }, [api]);
  useEffect(() => {
    let live = true; setQr(''); setNotice('');
    if (state?.invitation && !usb) QRCode.toDataURL(state.invitation.joinUrl, { width: 256, margin: 2, errorCorrectionLevel: 'M' })
      .then(value => { if (live) setQr(value); }).catch(() => { if (live) setNotice('Use Copy private link to connect.'); });
    return () => { live = false; };
  }, [state?.invitation?.joinUrl, usb]);
  async function run(action: ((generation: number) => Promise<unknown>) | undefined) {
    if (!action || pending || stopping) return; const generation = ++operation.current; setPending(true); setNotice('');
    try { await action(generation); } catch { if (generation === operation.current) setNotice('That step could not finish. Check your setup and try again.'); }
    finally { if (generation === operation.current) setPending(false); }
  }
  async function stopSharing() {
    if (!api || stopping) return; ++operation.current; setPending(false); setStopping(true); setNotice('');
    try { await api.stop(); } catch { setNotice('Sharing could not be stopped. Try Stop sharing again.'); }
    finally { setStopping(false); }
  }
  async function primary() {
    if (!api) return;
    const actions: Partial<Record<Phase, () => Promise<unknown>>> = {
      'screen-permission': api.screenPermission, 'control-permission': api.controlPermission,
      network: api.tailscale, 'private-link': api.privateSetup, ready: api.start, error: api.start,
    };
    await run(actions[phase]);
  }
  const content = usb && phase === 'ready' ? { title: 'Share with your USB phone', description: 'Start sharing opens the phone browser with access to view your whole screen, hear desktop audio and control this computer. Keep the phone unlocked and connected. No QR or account is needed.', action: 'Start sharing' }
    : usb && phase === 'inviting' ? { title: 'Continue on your phone', description: state?.invitation?.openedOnPhone ? 'The receiver opened on your phone. Choose a browser if Android asks. Keep the cable connected.' : 'The USB connection is ready, but the phone browser did not open. Copy the USB link and paste it into the browser on that connected phone.' }
    : copy[phase]; const setup = !['ready', 'preparing', 'inviting', 'sharing'].includes(phase);
  return <div className="host-app">
    <header><span className="brand"><Monitor aria-hidden="true" size={22} /> dskcpy</span>
      {(phase === 'inviting' || phase === 'preparing') && state?.canStop
        ? <button className="secondary" disabled={stopping} onClick={stopSharing}>Cancel invitation</button>
        : <span className="private-badge"><ShieldCheck aria-hidden="true" size={16} /> Private sharing</span>}</header>
    <main>
      {api?.setConnection && state && <fieldset className="connection-choice" disabled={state.canStop || pending || stopping}>
        <legend>How will you connect?</legend>
        <label><input type="radio" name="connection" value="usb" checked={usb} onChange={() => run(() => api.setConnection!('usb'))} /><Usb size={18} aria-hidden="true" /><span>USB cable <small>Android phone · no account</small></span></label>
        <label><input type="radio" name="connection" value="internet" checked={!usb} onChange={() => run(() => api.setConnection!('internet'))} /><Wifi size={18} aria-hidden="true" /><span>Private network <small>Tailscale · different networks</small></span></label>
      </fieldset>}
      {phase !== 'inviting' && <div className={`hero-icon ${phase === 'sharing' ? 'is-sharing' : ''}`}><Monitor aria-hidden="true" size={34} /></div>}
      <p className="eyebrow">{setup ? 'SET UP YOUR COMPUTER' : phase === 'sharing' ? 'CONNECTED' : 'BROWSER RECEIVER · NO APP NEEDED'}</p>
      <h1 ref={heading} tabIndex={-1}>{content.title}</h1>
      <p className="description">{state?.error || (phase === 'sharing' && !state?.features.keyboard
        ? 'The connected device can see your whole screen, hear desktop audio and use the mouse. Stop sharing to end its access.' : content.description)}</p>
      {setup && state && <ol className="setup-list" aria-label="Setup progress">
        {[['Screen access', state.permissions.screen], ['Mouse and keyboard', state.permissions.control], [usb ? 'USB phone' : 'Private connection', usb ? Boolean(state.usb?.selected) : state.route.ready]].map(([label, done], i) =>
          <li key={String(label)}><span className={done ? 'step done' : 'step'}>{done ? <Check aria-hidden="true" size={15} /> : i + 1}</span><span>{label}{done && <span className="sr-only">: ready</span>}</span></li>)}
      </ol>}
      {usb && !state?.canStop && !!state?.usb?.devices.length && <fieldset className="usb-phones" disabled={pending || stopping}>
        <legend>Connected phones</legend>
        {state.usb.devices.map((device, index) => <label key={device.id}><input type="radio" name="usb-phone" checked={state.usb?.selected === device.id} disabled={device.state !== 'ready'} onChange={() => run(() => api!.selectUsbDevice!(device.id))} />
          <span><bdi>{device.name}</bdi> · {index + 1}<small>{device.state === 'ready' ? 'USB debugging allowed' : device.state === 'unauthorized' ? 'Allow USB debugging on this phone' : 'Unlock and reconnect this phone'}</small></span></label>)}
      </fieldset>}
      {phase === 'inviting' && <section className="invitation" aria-label="Connection invitation">
        {!usb && (qr ? <img className="qr" src={qr} width="256" height="256" alt="Scan with your other device’s camera to connect. You can also copy the private link below." /> : <p>Preparing QR…</p>)}
        <button className="primary" disabled={pending || stopping} onClick={() => run(async generation => {
          const copied = await api?.copyInvitation(); if (generation !== operation.current) return; setNotice(copied ? (usb ? 'USB link copied. Paste it only into the browser on the connected phone.' : 'Private link copied. Send it only to the person you want to connect.') : 'This invitation expired. Stop and start sharing for a new link.');
        })}><Copy size={18} aria-hidden="true" />{usb ? 'Copy USB link' : 'Copy private link'}</button>
        <p className="hint">One use. Expires after five minutes. Anyone using this invitation can view and control this computer.</p>
        {!state?.features.keyboard && <p className="hint">Keyboard entry is not available on this host yet.</p>}
      </section>}
      {phase === 'sharing' && <div className="sharing-card"><Check size={22} aria-hidden="true" /><span>Sharing stays on when you close this window. Use dskcpy in the menu bar or system tray to stop.</span></div>}
      {phase === 'ready' && state?.features.clipboard && api?.setClipboardAllowed && <div className="clipboard-permission">
        <label><input type="checkbox" checked={state.clipboardAllowed === true} onChange={event => { const allowed = event.currentTarget.checked; void run(() => api.setClipboardAllowed!(allowed)); }} disabled={pending || stopping} aria-describedby="host-clipboard-help" /> Allow text clipboard for this invitation</label>
        <p id="host-clipboard-help" className="hint">The receiver can explicitly read or replace your text clipboard and paste into the active app. This turns off when sharing ends.</p>
      </div>}
      {['inviting', 'sharing'].includes(phase) && state?.clipboardAllowed && <p className="hint">Text clipboard tools are allowed for this invitation. Stop sharing to end clipboard access.</p>}
      <div className="actions">
        {content.action && <button className="primary" disabled={!api || pending || stopping} onClick={primary}>{content.action}<ArrowRight aria-hidden="true" size={19} /></button>}
        {state?.canStop && !['inviting', 'preparing'].includes(phase) && <button className="stop" disabled={stopping} onClick={stopSharing}><Square size={16} aria-hidden="true" />Stop sharing</button>}
        {setup && <button className="secondary" disabled={!api || pending || stopping} onClick={() => run(api?.refresh)}>Check again</button>}
      </div>
      {!usb && deviceAPI.current && <TrustedDevicesPanel api={deviceAPI.current} />}
      <p className="notice" role="status">{notice}</p>
      {['ready', 'sharing'].includes(phase) && state?.startup && <details className="startup-settings">
        <summary>Startup</summary>
        <label><input type="checkbox" checked={state.startup.requested} disabled={!api || pending || stopping || !state.startup.available}
          aria-describedby="startup-note" onChange={event => {
            const enabled = event.currentTarget.checked;
            void run(async () => { await api?.setOpenAtLogin(enabled); });
          }} /><span>Open dskcpy when I sign in</span></label>
        <p id="startup-note" className="hint" role="status">{!state.startup.available ? 'Available after installing the packaged app. On a Mac, keep it in Applications.'
          : state.startup.error || (state.startup.requiresApproval || (state.startup.requested && !state.startup.enabled)
            ? 'Allow dskcpy in your system’s login or startup settings to finish setup.'
            : 'The app opens in the menu bar or system tray. Approved remembered devices may reconnect when access is enabled.')}</p>
      </details>}
    </main>
    <footer>{usb ? <Usb size={16} aria-hidden="true" /> : <Wifi size={16} aria-hidden="true" />}<span>{usb ? 'USB browser sharing works with an authorized Android data connection. iPhone and iPad use the private network option.' : 'For remote access, both devices need Tailscale access to this computer.'}</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
