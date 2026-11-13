import { useEffect, useState } from 'react';

export type TrustedDevices = { available: boolean; paused: boolean; storageError?: boolean;
  pending: { id: string; name: string; expiresAt: number }[];
  devices: { id: string; name: string; expiresAt: number }[] };
export type DeviceAction = 'approve' | 'reject' | 'revoke' | 'pause' | 'resume';
export type DeviceAPI = { list(): Promise<TrustedDevices>; action(action: DeviceAction, id?: string): Promise<TrustedDevices> };
async function request(body?: unknown): Promise<TrustedDevices> {
  const response = await fetch('/api/browser/trusted', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Could not update remembered devices.');
  return value;
}
const localAPI: DeviceAPI = { list: () => request(), action: (action, id) => request({ action, id }) };
export default function TrustedDevicesPanel({ api = localAPI }: { api?: DeviceAPI }) {
  const [state, setState] = useState<TrustedDevices | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await api.list(); if (live) { setState(value); setError(''); } }
      catch { if (live) setError('Remembered devices could not be checked.'); }
      if (live) timer = setTimeout(poll, 3000);
    };
    void poll(); return () => { live = false; clearTimeout(timer); };
  }, [api]);
  async function action(action: DeviceAction, id?: string) {
    if (busy) return; setBusy(true); setError('');
    try { setState(await api.action(action, id)); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not update access.'); }
    finally { setBusy(false); }
  }
  if (!state?.available && !state?.storageError) return null;
  return <section className="remembered-devices" aria-labelledby="remembered-title">
    <h2 id="remembered-title">Remembered devices</h2>
    <p>Approve your own browser once so it can reconnect without a new code for 90 days. Access includes the entire desktop, audio, mouse and keyboard while this host is running. Keep the Mac awake and its private connection on.</p>
    {state?.storageError && <p role="alert">Device storage needs attention. Remembered access is blocked.</p>}
    {state?.pending.map(device => <div key={device.id} className="remembered-device-request">
      <strong>{device.name}</strong><p>Allow this browser to reconnect and control the entire desktop for 90 days?</p>
      <button type="button" disabled={busy} onClick={() => action('approve', device.id)}>Allow remembered access</button>{' '}
      <button type="button" disabled={busy} onClick={() => action('reject', device.id)}>Reject</button>
    </div>)}
    {state?.devices.length === 0 && <p>No remembered devices. Connect through a private invitation, then choose Options → Remember this browser on your receiving device.</p>}
    {Boolean(state?.devices.length) && <>
      <p role="status">{state?.paused ? 'Remembered access is paused.' : 'Approved browsers may reconnect while this host is running.'}</p>
      <button type="button" disabled={busy} onClick={() => action(state?.paused ? 'resume' : 'pause')}>{state?.paused ? 'Enable remembered access' : 'Pause remembered access'}</button>
      <ul>{state?.devices.map(device => <li key={device.id}><strong>{device.name}</strong> · expires {new Date(device.expiresAt).toLocaleDateString()} {' '}
        <button type="button" disabled={busy} aria-label={`Revoke ${device.name}`} onClick={() => action('revoke', device.id)}>Revoke</button></li>)}</ul>
    </>}
    <p>Stop sharing pauses remembered access too. Enable it here when you want approved devices to reconnect.</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
