import type { BridgeStatus, NativeStartupAttempt } from './types';

const phases: Record<string, string> = {
  'host-check': 'Connection attempt started',
  'install-start': 'Preparing the phone app', 'install-ready': 'Phone app prepared',
  'launch-start': 'Opening the phone app', 'launch-ready': 'Phone accepted the launch request',
  'socket-wait': 'Waiting for the phone connection', 'socket-ready': 'Phone connection opened',
  'transport-ready': 'Phone startup information received',
};
const titles = {
  starting: 'Phone connection in progress', connected: 'Phone connection established',
  failed: 'Phone connection did not finish', stopped: 'Phone connection stopped',
  ended: 'Phone connection ended', unreported: 'Phone connection details unavailable',
};
const failures: Record<string, string> = {
  'host-check-failed': 'Review the setup checks in Connect, then try again.',
  'install-failed': 'Check the selected phone and the app component in Device, then try again from Connect.',
  'launch-failed': 'Unlock the selected phone and open dskcpy, then try again from Connect.',
  'socket-failed': 'Keep the phone unlocked with dskcpy open, then try again from Connect.',
  'control-failed': 'The phone opened a connection, but its controls did not connect. Reopen dskcpy on the phone and try again from Connect.',
  'metadata-failed': 'The phone opened a connection but could not finish starting. Reopen dskcpy on the phone and try again from Connect.',
  'connection-ended': 'Check dskcpy on the selected phone, then try again from Connect.',
};
function guidance(value: NativeStartupAttempt) {
  if (value.status === 'failed') return failures[value.failure || ''] || failures['connection-ended'];
  if (value.status === 'starting') return 'Keep the selected phone unlocked with dskcpy open.';
  if (value.status === 'connected') return 'If the phone picture is missing, check the recent log below.';
  if (value.status === 'unreported') return 'This host did not report phone connection steps. Review the recent log below and the current status in Connect.';
  return 'These steps remain available during automatic reconnection. Starting a new connection clears earlier attempts.';
}
function clock(at: string) {
  const value = new Date(at);
  return Number.isNaN(value.getTime()) ? 'Time unavailable' : new Intl.DateTimeFormat(undefined,
    { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(value);
}
function Steps({ value }: { value: NativeStartupAttempt }) {
  return <ol className="startup-steps" aria-label="Observed phone connection steps">
    {value.events.map(event => <li key={event.phase}><span>{phases[event.phase] || 'Connection step'}</span>
      <time dateTime={event.at}><bdi>{clock(event.at)}</bdi></time></li>)}
  </ol>;
}
export default function NativeStartupPanel({ history }: { history: BridgeStatus['nativeStartup'] }) {
  const current = history?.current;
  const announcement = current ? current.status === 'failed' ? guidance(current)
    : current.status === 'starting' ? phases[current.phase] || titles.starting : titles[current.status] : '';
  return <>
    <p className="sr-only" role="status">{announcement}</p>
    {current && <section className="startup-history" aria-labelledby="startup-title">
      <div className="startup-heading"><h3 id="startup-title">Phone connection steps</h3>
        <dl><dt>Attempt</dt><dd><bdi>{new Intl.NumberFormat().format(current.attempt)}</bdi></dd></dl></div>
      <p className="startup-result"><strong>{titles[current.status]}</strong></p>
      <p className="startup-guidance">{guidance(current)} <a href="#connection">Go to Connect</a></p>
      {current.failure === 'install-failed' && <p className="startup-guidance"><a href="#device">Review Device setup</a></p>}
      <p className="startup-guidance">Reported steps stay available when the recent log fills up. Times show when this computer received each step.</p>
      <Steps value={current} />
      {history.previous.length > 0 && <details><summary>Earlier attempts</summary>
        <ol className="startup-previous" start={history.previous[0].attempt} aria-label="Earlier phone connection attempts">
          {history.previous.map(value => <li key={value.attempt}><p><strong>{titles[value.status]}</strong></p>
            <p className="startup-guidance">{guidance(value)}</p><Steps value={value} /></li>)}
        </ol>
      </details>}
    </section>}
  </>;
}
