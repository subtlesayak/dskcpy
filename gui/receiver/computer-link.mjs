import { channelToken, directoryMessage, nonce, pairedAppIntent, pairedComputersKey, proveComputer, publicIdentity, readPairedComputers, receiverAddress } from './computers-common.mjs';

const storageKey = 'dskcpy.computer-directory-link.v1';

function readRemoteLink() {
  try { return JSON.parse(localStorage.getItem(storageKey)); } catch { return null; }
}

function readLink(origin, binding, fingerprint) {
  if (origin === location.origin) {
    const entry = readPairedComputers().find(item => item.origin === origin && item.binding === binding
      && item.fingerprint === fingerprint && /^[a-f0-9]{32}$/.test(item.pairingId || ''));
    if (entry) return entry;
  }
  return readRemoteLink();
}

export function saveComputerInPairedApp(remembered) {
  const panel = document.getElementById('directory-stream');
  if (!panel) return;
  const save = panel.querySelector('.directory-save'), feedback = panel.querySelector('.directory-feedback');
  panel.querySelector('.directory-origin').hidden = true;
  panel.hidden = false;
  save.addEventListener('click', async () => {
    if (save.disabled) return;
    save.disabled = true; feedback.textContent = '';
    try {
      const { computer, pairingId, paired } = await remembered.inspect();
      if (!paired || !pairingId || !publicIdentity(computer)) {
        feedback.textContent = 'Request pairing and wait for the host to approve it first.';
        return;
      }
      if (await proveComputer(location.origin, computer) !== 'reachable') {
        feedback.textContent = 'Could not verify this computer. Check its connection and try again.';
        return;
      }
      const computers = readPairedComputers();
      const existing = computers.find(item => item.fingerprint === computer.fingerprint);
      if (!existing && computers.length >= 16) {
        feedback.textContent = 'Forget a computer from the paired list before adding another.';
        return;
      }
      const entry = { ...computer, name: existing?.name || computer.name, origin: location.origin,
        binding: nonce(), pairingId };
      localStorage.setItem(pairedComputersKey, JSON.stringify([...computers.filter(item => item !== existing), entry]));
      feedback.textContent = 'Saved to paired computers in this app.';
    } catch {
      feedback.textContent = 'Could not save this computer. Check the connection and try again.';
    } finally { save.disabled = false; }
  });
}

export async function requestFromPairedApp(remembered) {
  let intent;
  try {
    const saved = sessionStorage.getItem(pairedAppIntent);
    sessionStorage.removeItem(pairedAppIntent);
    intent = JSON.parse(saved);
  } catch { /* The receiver still offers its normal Connect controls. */ }
  const info = await remembered.inspect();
  const link = readLink(location.origin, intent?.binding, intent?.fingerprint);
  if (!Number.isSafeInteger(intent?.expiresAt) || intent.expiresAt <= Date.now()
      || !channelToken(intent.binding) || !link || link.origin !== location.origin
      || link.binding !== intent.binding || link.fingerprint !== intent.fingerprint
      || info.phase !== 'reachable' || !info.pairingId || info.pairingId !== link.pairingId
      || info.computer?.fingerprint !== link.fingerprint) return;
  await remembered.requestConnection({ owner: 'paired-app' });
}

export function linkComputerDirectory(remembered) {
  const opener = window.opener;
  if (!opener || location.protocol !== 'https:') return;
  const panels = ['directory-join', 'directory-stream'].map(id => document.getElementById(id)).filter(Boolean);
  if (!panels.length) return;
  let job, completed;
  function send(message, action, detail = {}) {
    opener.postMessage({ scope: directoryMessage, id: message.id, action, ...detail }, message.origin);
  }
  function store(value) {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); return true; } catch { return false; }
  }
  async function save() {
    const current = job;
    if (!current || current.action !== 'add' || current.saving) return;
    current.saving = true;
    const info = await remembered.inspect();
    current.saving = false;
    if (job !== current) return;
    const feedback = text => panels.forEach(panel => { panel.querySelector('.directory-feedback').textContent = text; });
    if (!info.paired || !info.pairingId || !publicIdentity(info.computer)) {
      feedback('Connect first, then open Options → Remember this browser and get pairing approved.'); return;
    }
    if (current.fingerprint && info.computer.fingerprint !== current.fingerprint) {
      send(current, 'result', { phase: 'changed' });
      feedback('This address belongs to a different computer.');
      completed = current.id; job = null; return;
    }
    const binding = nonce();
    if (!store({ origin: current.origin, binding, pairingId: info.pairingId, fingerprint: info.computer.fingerprint })) {
      feedback('Browser storage is unavailable. Open this receiver directly to connect.'); return;
    }
    send(current, 'saved', { computer: info.computer, binding });
    feedback('Computer sent to your paired list. You can return to that tab.');
    panels.forEach(panel => { panel.querySelector('.directory-save').hidden = true; });
    completed = current.id;
    job = null;
  }
  for (const panel of panels) panel.querySelector('.directory-save').addEventListener('click', () => { void save(); });

  window.addEventListener('message', async event => {
    const value = event.data;
    if (event.source !== opener || !receiverAddress(event.origin) || value?.scope !== directoryMessage || !channelToken(value.id) || value.id === completed) return;
    if (value.action === 'cancel') {
      if (job?.id === value.id && job.origin === event.origin && job.action === 'request' && value.binding === job.binding) {
        job.cancelled = true;
        remembered.cancelRequest(job.id);
      }
      return;
    }
    if (!['add', 'request', 'status', 'forget'].includes(value.action)) return;
    if (job) {
      if (job.id === value.id && job.origin === event.origin) send(job, 'ready');
      return;
    }
    const current = job = { id: value.id, origin: event.origin, action: value.action, binding: value.binding,
      fingerprint: channelToken(value.fingerprint) ? value.fingerprint : null };
    send(current, 'ready');
    if (current.action === 'add') {
      for (const panel of panels) {
        panel.hidden = false;
        panel.querySelector('.directory-save').hidden = false;
        panel.querySelector('.directory-origin').textContent = `Add this computer to the paired list at ${current.origin}.`;
      }
      return;
    }
    try {
      const link = readLink(current.origin, current.binding, value.fingerprint);
      if (!link || link.origin !== current.origin || !channelToken(current.binding) || link.binding !== current.binding
          || link.fingerprint !== value.fingerprint) { send(current, 'result', { phase: 'pairing-required' }); return; }
      const info = await remembered.inspect();
      let phase = info.phase;
      if (current.cancelled) phase = await remembered.cancelPendingRequest(info.requestId) ? 'cancelled' : 'cancel-unconfirmed';
      else if (info.computer?.fingerprint !== link.fingerprint) phase = 'pairing-required';
      else if (info.paired && info.pairingId !== link.pairingId) phase = 'pairing-required';
      else if (current.action === 'forget' && ['reachable', 'pairing-required', 'paused'].includes(phase)) {
        phase = await remembered.forgetComputer() ? 'forgotten' : 'request-failed';
        if (phase === 'forgotten') {
          const remote = readRemoteLink();
          if (remote?.origin === current.origin && remote.binding === current.binding) {
            try { localStorage.removeItem(storageKey); } catch { /* The host credential was already revoked. */ }
          }
        }
      } else if (current.action === 'request' && phase === 'reachable') {
        phase = await remembered.requestConnection({ owner: current.id, onWaiting: () => send(current, 'waiting') });
      }
      send(current, 'result', { phase });
    } finally { completed = current.id; job = null; }
  });
}
