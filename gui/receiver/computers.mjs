import { channelToken, computerName, directoryMessage, nonce, proveComputer, publicIdentity, receiverAddress } from './computers-common.mjs';

const $ = id => document.getElementById(id);
const storageKey = 'dskcpy.paired-computers.v1';
const list = $('paired-computers'), feedback = $('directory-status'), dialog = $('edit-computer');
const addressInput = $('computer-url'), addError = $('add-error'), editInput = $('edit-value'), editError = $('edit-error');
const checkButton = $('check-computers'), cancelButton = $('cancel-directory-request');
const labels = {
  reachable: 'Reachable', offline: 'Unreachable', unavailable: 'Identity unavailable', changed: 'Computer identity changed',
  'pairing-required': 'Pairing required', busy: 'Computer is busy', paused: 'Requests are paused on the computer',
  'update-required': 'Update the computer to request a stream', denied: 'The computer denied the request',
  expired: 'The request expired', ended: 'The request ended', cancelled: 'Connection request cancelled',
  'cancel-unconfirmed': 'Request cancelled in this browser. The host did not confirm; its pending request will expire.',
  'focus-required': 'Return to the receiver tab and request a new stream', 'request-failed': 'The computer could not finish the request',
  approved: 'Approved. Continue in the receiver tab', forgotten: 'Computer forgotten',
};
const availability = new Set(['reachable', 'offline', 'unavailable', 'changed', 'pairing-required', 'busy', 'paused', 'update-required']);
const statusById = new Map();
let computers = [], active, edit, checking = false;

try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (Array.isArray(saved)) computers = saved.slice(0, 16).filter(item => publicIdentity(item) && computerName(item.name)
    && receiverAddress(item.origin)?.origin === item.origin && (item.binding === null || channelToken(item.binding)));
} catch { /* This visit can still add computers if browser storage is unavailable. */ }

function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify(computers)); return true; } catch { return false; }
}
const say = text => { if (feedback.textContent !== text) feedback.textContent = text; };
const get = id => computers.find(item => item.fingerprint === id);
const current = item => get(item.fingerprint) === item;
function element(tag, text) {
  const item = document.createElement(tag);
  item.textContent = text;
  return item;
}
function action(label, row, key, click) {
  const button = element('button', label);
  button.type = 'button'; button.dataset.action = key;
  button.setAttribute('aria-label', `${label} for ${row.name}`);
  button.disabled = Boolean(active);
  button.addEventListener('click', click);
  return button;
}
function render() {
  const previous = document.activeElement;
  const focusedId = previous?.closest('li')?.dataset.fingerprint;
  const lastAction = previous?.dataset.action;
  list.replaceChildren();
  $('empty-computers').hidden = computers.length > 0;
  checkButton.hidden = !computers.length;
  checkButton.disabled = checking || Boolean(active);
  for (const computer of computers) {
    const phase = statusById.get(computer.fingerprint);
    const li = document.createElement('li'); li.dataset.fingerprint = computer.fingerprint;
    const status = element('p', computer.binding ? labels[phase] || 'Checking reachability…' : 'Pairing required');
    status.className = 'subtle';
    const controls = document.createElement('div'); controls.className = 'paired-actions';
    const pair = !computer.binding || phase === 'pairing-required';
    controls.append(
      action(pair ? 'Pair again' : 'Request to connect', computer, 'request', () => {
        if (pair) void openReceiver(new URL(computer.origin), 'add');
        else void openReceiver(new URL(computer.origin), 'request', computer);
      }),
      action('Rename', computer, 'rename', event => showEdit(computer, 'name', event.currentTarget)),
      action('Change address', computer, 'address', event => showEdit(computer, 'address', event.currentTarget)),
      action('Forget', computer, 'forget', () => { void forget(computer); }),
    );
    if (computer.binding) controls.append(action('Check status', computer, 'status', () => { void openReceiver(new URL(computer.origin), 'status', computer); }));
    li.append(element('h2', computer.name), status, controls); list.append(li);
    if (li.dataset.fingerprint === focusedId && lastAction) li.querySelector(`[data-action="${lastAction}"]`)?.focus();
  }
}

async function reachability(computer) {
  try { return await proveComputer(computer.origin, computer); } catch { return 'offline'; }
}
async function checkReachability(announce = false) {
  if (checking || active) return;
  checking = true; checkButton.disabled = true;
  await Promise.all(computers.map(async computer => {
    const origin = computer.origin, oldPhase = statusById.get(computer.fingerprint);
    const phase = await reachability(computer);
    if (current(computer) && computer.origin === origin && statusById.get(computer.fingerprint) === oldPhase
        && (phase !== 'reachable' || !['busy', 'paused', 'pairing-required', 'update-required'].includes(oldPhase)))
      statusById.set(computer.fingerprint, phase);
  }));
  checking = false; render();
  if (announce && !active) say('Reachability checked. Open a computer to check whether it can accept requests.');
}
function showEdit(computer, property, trigger) {
  edit = { computer, property, trigger };
  const rename = property === 'name';
  $('edit-title').textContent = rename ? 'Rename computer' : 'Change computer address';
  $('edit-label').textContent = rename ? 'Computer name' : 'New HTTPS address';
  editInput.type = rename ? 'text' : 'url'; editInput.maxLength = rename ? 60 : 512;
  editInput.value = rename ? computer.name : computer.origin;
  editInput.removeAttribute('aria-invalid'); editError.textContent = '';
  dialog.showModal(); editInput.focus();
}
$('cancel-edit').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { const previous = edit; edit = null; previous?.trigger?.focus(); });
$('edit-computer-form').addEventListener('submit', async event => {
  event.preventDefault();
  const change = edit;
  if (!change) return;
  const { computer, property } = change;
  const value = editInput.value.normalize('NFC').trim();
  const invalid = text => { editInput.setAttribute('aria-invalid', 'true'); editError.textContent = text; editInput.focus(); };
  if (property === 'name') {
    if (!computerName(value)) { invalid('Enter a computer name of 1–60 characters.'); return; }
    computer.name = value;
  } else {
    const address = receiverAddress(value);
    if (!address) { invalid('Enter the computer’s HTTPS address.'); return; }
    if (address.origin === computer.origin) { dialog.close(); return; }
    editError.textContent = 'Verifying the new address…';
    const phase = await reachability({ ...computer, origin: address.origin });
    if (edit !== change || !current(computer)) return;
    if (phase !== 'reachable') { invalid(phase === 'changed' ? 'This address belongs to a different computer.' : 'Could not verify the new address.'); return; }
    computer.origin = address.origin; computer.binding = null;
    statusById.set(computer.fingerprint, 'pairing-required');
  }
  const persisted = persist();
  dialog.close(); render();
  list.querySelector(`[data-fingerprint="${computer.fingerprint}"] [data-action="${property === 'name' ? 'rename' : 'address'}"]`)?.focus();
  say(persisted ? (property === 'name' ? 'Name saved.' : 'Address verified. Pair again at the new address.') : 'Changed for this visit. Browser storage is unavailable.');
});

function remove(computer) {
  computers = computers.filter(item => item !== computer);
  statusById.delete(computer.fingerprint);
  persist();
}
async function forget(computer) {
  if (!computer.binding || ['offline', 'unavailable', 'changed'].includes(statusById.get(computer.fingerprint))) {
    if (!window.confirm(`Remove ${computer.name} from this list? You can revoke any old pairing on the computer.`)) return;
    remove(computer); render(); addressInput.focus(); say('Computer removed from this list.'); return;
  }
  if (window.confirm(`Forget ${computer.name} and revoke this browser’s pairing?`))
    await openReceiver(new URL(computer.origin), 'forget', computer);
}

function stop(job, message) {
  if (active !== job) return;
  clearInterval(job.timer); active = null; cancelButton.hidden = true;
  render(); say(message);
  if (job.computer) list.querySelector(`[data-fingerprint="${job.computer.fingerprint}"] [data-action="${job.action}"]`)?.focus();
}
function message(job, action) {
  job.popup.postMessage({ scope: directoryMessage, id: job.id, action, binding: job.computer?.binding,
    fingerprint: job.computer?.fingerprint }, job.origin);
}
async function openReceiver(url, action, computer) {
  if (active) return;
  const popup = window.open(action === 'add' ? url.href : 'about:blank', '_blank');
  if (!popup) { say('Allow pop-ups for this page to open the receiver.'); return; }
  const job = active = { id: nonce(), action, origin: url.origin, popup, computer };
  render();
  cancelButton.hidden = action !== 'request';
  if (action === 'request') cancelButton.focus();
  say(action === 'add' ? 'Open the receiver tab and choose Save to paired computers after pairing.' : 'Verifying the computer…');
  if (computer) {
    const phase = await reachability(computer);
    if (active !== job) return;
    if (phase !== 'reachable' || popup.closed || job.cancelled) {
      popup.close();
      if (phase !== 'reachable') statusById.set(computer.fingerprint, phase);
      stop(job, job.cancelled ? labels.cancelled : phase !== 'reachable' ? labels[phase] : 'The receiver tab closed.'); return;
    }
    job.navigated = true;
    popup.location.replace(`${url.origin}/#directory-access`);
  }
  const start = Date.now();
  job.lastResponseAt = start;
  const tick = () => {
    if (popup.closed) { stop(job, 'The receiver tab closed. Any pending request will expire.'); return; }
    if (Date.now() - job.lastResponseAt > 10000) {
      if (action === 'request') message(job, 'cancel');
      stop(job, job.cancelled ? 'The receiver did not confirm cancellation. Check its tab; pending requests expire.'
        : 'The receiver stopped responding. Check its tab; any pending request will expire.'); return;
    }
    // Re-announce the same nonce/binding so a reloaded receiver can rejoin the
    // pending intent. Its handler deduplicates an active or completed job; this
    // neither approves a stream nor repeats an already consumed host grant.
    message(job, action);
    if (job.ready && job.cancelled) message(job, 'cancel');
  };
  job.timer = setInterval(tick, 350); tick();
}

window.addEventListener('message', async event => {
  const job = active, value = event.data;
  if (!job || event.source !== job.popup || event.origin !== job.origin || value?.scope !== directoryMessage || value.id !== job.id) return;
  job.lastResponseAt = Date.now();
  if (value.action === 'ready') { job.ready = true; if (job.cancelled) message(job, 'cancel'); return; }
  if (value.action === 'waiting' && job.action === 'request' && !job.cancelled) { say('Waiting for host approval'); return; }
  if (value.action === 'saved' && job.action === 'add' && !job.saving) {
    const saved = value.computer;
    if (!publicIdentity(saved) || !computerName(saved.name) || !channelToken(value.binding)) return;
    job.saving = true;
    const entry = { fingerprint: saved.fingerprint, publicKey: saved.publicKey, origin: job.origin,
      binding: value.binding, name: get(saved.fingerprint)?.name || saved.name };
    const phase = await reachability(entry);
    if (active !== job) return;
    if (phase !== 'reachable') { stop(job, 'Could not verify the computer’s identity.'); return; }
    computers = computers.filter(item => item.fingerprint !== entry.fingerprint);
    computers.push(entry); statusById.set(entry.fingerprint, phase);
    stop(job, persist() ? `${entry.name} added.` : `${entry.name} added for this visit. Browser storage is unavailable.`);
    return;
  }
  if (value.action !== 'result' || !job.computer || !Object.hasOwn(labels, value.phase)) return;
  if (availability.has(value.phase)) statusById.set(job.computer.fingerprint, value.phase);
  if (job.action === 'forget' && value.phase === 'forgotten') remove(job.computer);
  if (job.action === 'status' || (job.action === 'forget' && value.phase === 'forgotten')) job.popup.close();
  stop(job, labels[value.phase]);
});

$('add-computer').addEventListener('submit', event => {
  event.preventDefault();
  if (active) { addError.textContent = 'Finish the open receiver action first.'; return; }
  const url = receiverAddress(addressInput.value, true);
  if (!url) { addressInput.setAttribute('aria-invalid', 'true'); addError.textContent = 'Enter a dskcpy HTTPS receiver address or invitation link.'; addressInput.focus(); return; }
  if (computers.length >= 16 && !computers.some(item => item.origin === url.origin)) { addError.textContent = 'Forget a computer before adding another.'; return; }
  addressInput.removeAttribute('aria-invalid'); addError.textContent = ''; addressInput.value = '';
  void openReceiver(url, 'add');
});
checkButton.addEventListener('click', () => { void checkReachability(true); });
cancelButton.addEventListener('click', () => {
  const job = active;
  if (job?.action !== 'request') return;
  job.cancelled = true;
  if (!job.navigated) { job.popup.close(); stop(job, labels.cancelled); return; }
  if (job.ready) message(job, 'cancel');
  say('Cancelling connection request…');
});

render();
void checkReachability();
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/computers/computers-sw.mjs', { scope: '/computers/' }).catch(() => {});
