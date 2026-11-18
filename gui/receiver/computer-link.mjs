import { channelToken, directoryMessage, nonce, publicIdentity, receiverAddress } from './computers-common.mjs';

const storageKey = 'dskcpy.computer-directory-link.v1';

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
  function load() {
    try { return JSON.parse(localStorage.getItem(storageKey)); } catch { return null; }
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
    const current = job = { id: value.id, origin: event.origin, action: value.action, binding: value.binding };
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
      const link = load();
      if (!link || link.origin !== current.origin || !channelToken(current.binding) || link.binding !== current.binding
          || link.fingerprint !== value.fingerprint) { send(current, 'result', { phase: 'pairing-required' }); return; }
      const info = await remembered.inspect();
      let phase = info.phase;
      if (current.cancelled) phase = 'cancelled';
      else if (info.computer?.fingerprint !== link.fingerprint) phase = 'pairing-required';
      else if (info.paired && info.pairingId !== link.pairingId) phase = 'pairing-required';
      else if (current.action === 'forget' && ['reachable', 'pairing-required', 'paused'].includes(phase)) {
        phase = await remembered.forgetComputer() ? 'forgotten' : 'request-failed';
        if (phase === 'forgotten') {
          try { localStorage.removeItem(storageKey); } catch { /* The host credential was already revoked. */ }
        }
      } else if (current.action === 'request' && phase === 'reachable') {
        phase = await remembered.requestConnection({ owner: current.id, onWaiting: () => send(current, 'waiting') });
      }
      send(current, 'result', { phase });
    } finally { completed = current.id; job = null; }
  });
}
