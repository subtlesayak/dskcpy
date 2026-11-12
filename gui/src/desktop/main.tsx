import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import { ArrowRight, Check, Copy, Monitor, ShieldCheck, Square, Wifi } from 'lucide-react';
import './style.css';

type Phase = 'checking' | 'installation' | 'screen-permission' | 'control-permission' | 'network' | 'route-conflict' | 'private-link' | 'ready' | 'preparing' | 'inviting' | 'sharing' | 'error';
type Snapshot = { phase: Phase; permissions: { screen: boolean; control: boolean }; route: { connected: boolean; ready: boolean; conflict: boolean };
  features: { keyboard: boolean }; error: string | null; invitation: { joinUrl: string; expiresAt: number } | null; canStop: boolean };
type HostAPI = { snapshot(): Promise<Snapshot>; start(): Promise<Snapshot>; stop(): Promise<Snapshot>; refresh(): Promise<Snapshot>;
  screenPermission(): Promise<void>; controlPermission(): Promise<void>; privateSetup(): Promise<Snapshot>; tailscale(): Promise<void>;
  copyInvitation(): Promise<boolean>; onChange(callback: (snapshot: Snapshot) => void): () => void };
declare global { interface Window { dskcpyHost?: HostAPI } }
const copy: Record<Phase, { title: string; description: string; action?: string }> = {
  checking: { title: 'Let’s get your computer ready', description: 'Checking the app’s streaming components…' },
  installation: { title: 'The app installation is incomplete', description: 'A required streaming component is missing or could not load. Install a fresh copy of dskcpy Host, then open it again.' },
  'screen-permission': { title: 'Allow your screen to be shared', description: 'Allow dskcpy Host when macOS asks. If System Settings opens, turn it on under Screen & System Audio Recording. If asked to quit, reopen dskcpy afterward.', action: 'Allow screen sharing' },
  'control-permission': { title: 'Allow remote mouse and keyboard', description: 'In System Settings → Accessibility, turn on dskcpy Host. This lets your connected device control this computer.', action: 'Open control permissions' },
  network: { title: 'Connect your devices privately', description: 'Open Tailscale on both devices. Sign in or accept a device share so your receiving device can reach this computer. Return here when both are connected.', action: 'Get Tailscale' },
  'route-conflict': { title: 'This private address is already in use', description: 'Another app uses the connection address dskcpy needs. Its settings have been kept. Ask the person who set up Tailscale to choose a dedicated address for dskcpy.' },
  'private-link': { title: 'Set up your private connection', description: 'Do this once to let your connected Tailscale devices reach dskcpy. You choose when screen sharing starts.', action: 'Set up connection' },
  ready: { title: 'Your computer, wherever you are', description: 'Start sharing, then send the link or scan the QR on your other device. Keep this computer awake and connected.', action: 'Start sharing' },
  preparing: { title: 'Preparing your invitation…', description: 'Your screen is not being shared yet.' },
  inviting: { title: 'Open this on your other device', description: 'Keep Tailscale connected there. Scan this QR with its camera, or send the private link.' },
  sharing: { title: 'Your screen is being shared', description: 'The connected device can see your whole screen, hear desktop audio and use mouse and keyboard. Stop sharing to end its access.' },
  error: { title: 'Let’s get you connected', description: 'Sharing could not start. Check your setup and try again.', action: 'Try again' },
};
function App() {
  const api = window.dskcpyHost;
  const [state, setState] = useState<Snapshot | null>(null);
  const [notice, setNotice] = useState(''); const [qr, setQr] = useState('');
  const [pending, setPending] = useState(false); const heading = useRef<HTMLHeadingElement>(null);
  const phase = state?.phase || 'checking';
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
    if (state?.invitation) QRCode.toDataURL(state.invitation.joinUrl, { width: 256, margin: 2, errorCorrectionLevel: 'M' })
      .then(value => { if (live) setQr(value); }).catch(() => { if (live) setNotice('Use Copy private link to connect.'); });
    return () => { live = false; };
  }, [state?.invitation?.joinUrl]);
  async function run(action: (() => Promise<unknown>) | undefined) {
    if (!action || pending) return; setPending(true); setNotice('');
    try { await action(); } catch { setNotice('That step could not finish. Check your setup and try again.'); }
    finally { setPending(false); }
  }
  async function primary() {
    if (!api) return;
    const actions: Partial<Record<Phase, () => Promise<unknown>>> = {
      'screen-permission': api.screenPermission, 'control-permission': api.controlPermission,
      network: api.tailscale, 'private-link': api.privateSetup, ready: api.start, error: api.start,
    };
    await run(actions[phase]);
  }
  const content = copy[phase]; const setup = !['ready', 'preparing', 'inviting', 'sharing'].includes(phase);
  return <div className="host-app">
    <header><span className="brand"><Monitor aria-hidden="true" size={22} /> dskcpy</span>
      {(phase === 'inviting' || phase === 'preparing') && state?.canStop
        ? <button className="secondary" disabled={pending} onClick={() => run(api?.stop)}>Cancel invitation</button>
        : <span className="private-badge"><ShieldCheck aria-hidden="true" size={16} /> Private sharing</span>}</header>
    <main>
      {phase !== 'inviting' && <div className={`hero-icon ${phase === 'sharing' ? 'is-sharing' : ''}`}><Monitor aria-hidden="true" size={34} /></div>}
      <p className="eyebrow">{setup ? 'SET UP YOUR COMPUTER' : phase === 'sharing' ? 'CONNECTED' : 'BROWSER RECEIVER · NO APP NEEDED'}</p>
      <h1 ref={heading} tabIndex={-1}>{content.title}</h1>
      <p className="description">{state?.error || (phase === 'sharing' && !state?.features.keyboard
        ? 'The connected device can see your whole screen, hear desktop audio and use the mouse. Stop sharing to end its access.' : content.description)}</p>
      {setup && state && <ol className="setup-list" aria-label="Setup progress">
        {[['Screen access', state.permissions.screen], ['Mouse and keyboard', state.permissions.control], ['Private connection', state.route.ready]].map(([label, done], i) =>
          <li key={String(label)}><span className={done ? 'step done' : 'step'}>{done ? <Check aria-hidden="true" size={15} /> : i + 1}</span><span>{label}{done && <span className="sr-only">: ready</span>}</span></li>)}
      </ol>}
      {phase === 'inviting' && <section className="invitation" aria-label="Connection invitation">
        {qr ? <img className="qr" src={qr} width="256" height="256" alt="Scan with your other device’s camera to connect. You can also copy the private link below." /> : <p>Preparing QR…</p>}
        <button className="primary" disabled={pending} onClick={() => run(async () => {
          const copied = await api?.copyInvitation(); setNotice(copied ? 'Private link copied. Send it only to the person you want to connect.' : 'This invitation expired. Stop and start sharing for a new link.');
        })}><Copy size={18} aria-hidden="true" />Copy private link</button>
        <p className="hint">One use. Expires after five minutes. Anyone using this invitation can view and control this computer.</p>
        {!state?.features.keyboard && <p className="hint">Keyboard entry is not available on this host yet.</p>}
      </section>}
      {phase === 'sharing' && <div className="sharing-card"><Check size={22} aria-hidden="true" /><span>Sharing stays on when you close this window. Use dskcpy in the menu bar or system tray to stop.</span></div>}
      <div className="actions">
        {content.action && <button className="primary" disabled={!api || pending} onClick={primary}>{content.action}<ArrowRight aria-hidden="true" size={19} /></button>}
        {state?.canStop && !['inviting', 'preparing'].includes(phase) && <button className="stop" disabled={pending} onClick={() => run(api?.stop)}><Square size={16} aria-hidden="true" />Stop sharing</button>}
        {setup && <button className="secondary" disabled={!api || pending} onClick={() => run(api?.refresh)}>Check again</button>}
      </div>
      <p className="notice" role="status">{notice}</p>
    </main>
    <footer><Wifi size={16} aria-hidden="true" /><span>For remote access, both devices need Tailscale access to this computer.</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
