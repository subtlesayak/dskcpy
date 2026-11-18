const computerStorageKey = 'dskcpy.paired-computer.v1';
const validIdentity = identity => /^[a-f0-9]{64}$/.test(identity?.fingerprint || '')
  && /^[A-Za-z0-9_-]{122}$/.test(identity?.publicKey || '');
const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 60
  && !/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(name);

export function rememberedBrowser({ connectApproved, document = globalThis.document, location = globalThis.location,
  fetch = globalThis.fetch, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout,
  storage = () => globalThis.localStorage, confirm = message => globalThis.confirm(message), canRequest = () => true, canClaim = () => true }) {
  const $ = id => document.getElementById(id);
  const reconnect = $('remembered-reconnect'), cancel = $('remembered-cancel');
  const availability = $('paired-availability'), name = $('paired-name'), manage = $('paired-manage');
  const nameField = $('paired-name-input'), forget = $('paired-forget'), managementStatus = $('paired-management-status');
  let known = false, available = false, busy = false, timer, connectionAttempt, statusVersion = 0;
  let computer, pairingId, identityChanged = false, forgetting = false, phase = 'offline';
  try {
    const saved = JSON.parse(storage()?.getItem(computerStorageKey));
    if (validIdentity(saved) && validName(saved.name)) computer = { fingerprint: saved.fingerprint, publicKey: saved.publicKey, name: saved.name };
  } catch { /* Browser storage is optional. */ }
  function saveComputer() {
    try {
      const target = storage();
      if (!target) return false;
      if (computer) target.setItem(computerStorageKey, JSON.stringify(computer));
      else target.removeItem(computerStorageKey);
      return true;
    } catch { return false; }
  }
  function renderComputer(text) {
    $('remembered-join').hidden = !known && !computer;
    if (name) name.textContent = computer?.name || location.hostname || 'This computer';
    if (availability && availability.textContent !== text) availability.textContent = text;
    if (manage) manage.hidden = !computer;
    reconnect.hidden = !known || identityChanged;
    reconnect.disabled = !available || Boolean(connectionAttempt);
    if (forget) forget.disabled = forgetting || Boolean(connectionAttempt);
  }
  async function request(route, body = {}) {
    const response = await fetch(`/stream/${route}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'The host could not finish this request.'), { status: response.status });
    return result;
  }
  async function status() {
    if (location.protocol !== 'https:' || forgetting) return false;
    const mine = ++statusVersion;
    clearTimeout(timer);
    try {
      const result = await request('remember/status');
      if (mine !== statusVersion) return false;
      known = result.status === 'approved';
      pairingId = known && typeof result.pairingId === 'string' && /^[a-f0-9]{32}$/.test(result.pairingId) ? result.pairingId : undefined;
      const verified = known && validIdentity(result.hostIdentity);
      identityChanged = Boolean(computer && known && (!verified || computer.fingerprint !== result.hostIdentity.fingerprint
        || computer.publicKey !== result.hostIdentity.publicKey));
      if (verified && !computer) {
        const hostname = location.hostname;
        const { fingerprint, publicKey } = result.hostIdentity;
        computer = { fingerprint, publicKey, name: validName(hostname) ? hostname : 'This computer' };
        saveComputer();
      }
      available = known && !identityChanged && result.streamApproval === true && !result.paused && !result.busy;
      phase = identityChanged ? 'changed' : !known ? 'pairing-required' : result.streamApproval !== true ? 'update-required'
        : result.paused ? 'paused' : result.busy ? 'busy' : 'reachable';
      renderComputer(identityChanged ? 'Computer identity changed. Forget this entry before pairing again.'
        : !known ? 'Pairing required. Ask the host for a new invitation.'
          : result.streamApproval !== true ? 'Update the computer to request a new stream.'
            : result.paused ? 'Connection requests are paused on the computer.'
              : result.busy ? 'Computer is busy. Check again when the other session ends.' : 'Reachable');
      $('remember-status').textContent = result.status === 'pending' ? 'Waiting for pairing approval on the computer. Keep this session open.'
        : known ? result.paused ? 'Saved. Requests are paused on the computer.' : 'Paired. Return to this address to request a new stream.'
        : 'Ask the computer to pair this browser. Use only a device you own.';
      if (result.status === 'pending') { clearTimeout(timer); timer = setTimeout(status, 2000); }
      return known;
    } catch {
      if (mine === statusVersion) {
        known = false; available = false; phase = 'offline';
        renderComputer('Computer is unreachable. Check its connection and try again.');
      }
      return false;
    }
  }
  $('paired-refresh')?.addEventListener('click', () => { void status(); });
  manage?.addEventListener('toggle', () => { if (manage.open) nameField.value = computer?.name || ''; });
  $('paired-rename')?.addEventListener('submit', event => {
    event.preventDefault();
    if (!computer) return;
    const value = nameField.value.normalize('NFC').trim();
    if (!validName(value)) {
      nameField.setAttribute('aria-invalid', 'true');
      managementStatus.textContent = 'Enter a computer name of 1–60 characters.';
      nameField.focus();
      return;
    }
    nameField.removeAttribute('aria-invalid');
    computer.name = value;
    name.textContent = value;
    managementStatus.textContent = saveComputer() ? 'Computer name saved.' : 'Name changed for this visit. Browser storage is unavailable.';
  });
  async function forgetComputer() {
    if (!computer || identityChanged || forgetting || connectionAttempt) return false;
    forgetting = true; if (forget) forget.disabled = true; reconnect.disabled = true;
    statusVersion++; clearTimeout(timer);
    try {
      await request('trusted/forget');
      computer = null; pairingId = undefined; known = false; available = false; identityChanged = false; phase = 'pairing-required';
      saveComputer(); renderComputer('');
      $('session-key')?.focus();
      return true;
    } catch { return false; }
    finally { forgetting = false; if (forget) forget.disabled = false; reconnect.disabled = !available; }
  }
  forget?.addEventListener('click', async () => {
    if (!computer || forgetting || connectionAttempt || !confirm('Forget this computer? You will need a new invitation to pair again.')) return;
    if (identityChanged) {
      // A replacement at this address cannot revoke the old installation's access.
      computer = null; saveComputer(); await status(); return;
    }
    if (!await forgetComputer()) managementStatus.textContent = 'Could not forget the computer. Check its connection and try again.';
  });
  $('remember-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    busy = true; $('remember-submit').disabled = true;
    try { await request('remember', { name: $('device-name').value }); await status(); }
    catch (error) { $('remember-status').textContent = error.message; }
    finally { busy = false; $('remember-submit').disabled = false; }
  });
  async function cancelConnection(attempt) {
    attempt.cancelled = true;
    if (!attempt.id || attempt.cancelSent) return;
    attempt.cancelSent = true;
    try { await request('trusted/cancel', { id: attempt.id }); } catch { /* The request expires if the host is unreachable. */ }
  }
  function cancelRequest(owner) {
    if (!connectionAttempt || (owner && connectionAttempt.owner !== owner)) return false;
    $('remembered-connection-status').textContent = 'Connection request cancelled.';
    $('remembered-cancel').hidden = true;
    void cancelConnection(connectionAttempt);
    return true;
  }
  cancel.addEventListener('click', () => { cancelRequest(); });
  async function requestConnection({ owner, onWaiting = () => {} } = {}) {
    if (connectionAttempt || forgetting || !canRequest()) return 'busy';
    if (!available || location.protocol !== 'https:') return phase;
    const attempt = connectionAttempt = { cancelled: false, owner };
    const feedback = $('remembered-connection-status');
    reconnect.disabled = true;
    if (forget) forget.disabled = true;
    $('remembered-cancel').hidden = false;
    feedback.textContent = 'Sending connection request…';
    try {
      const pending = await request('trusted/connect', { action: 'request' });
      if (!/^[a-f0-9]{32}$/.test(pending.id || '') || !Number.isSafeInteger(pending.expiresAt)) throw Error('Update the host to request a new stream.');
      attempt.id = pending.id;
      if (attempt.cancelled) { await cancelConnection(attempt); return 'cancelled'; }
      feedback.textContent = 'Waiting for host approval';
      onWaiting();
      const deadline = Math.min(Date.now() + 120000, pending.expiresAt);
      while (!attempt.cancelled && Date.now() < deadline) {
        if (owner && !canClaim()) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
        const result = await request('trusted/status', { id: attempt.id });
        if (attempt.cancelled) return 'cancelled';
        if (/^[A-Za-z0-9_-]{32}$/.test(result.key || '')) {
          if (connectApproved(result.key)) return 'approved';
          await cancelConnection(attempt);
          feedback.textContent = 'Return to this page and request a new stream.';
          return 'focus-required';
        }
        if (!['pending', 'claiming'].includes(result.status)) {
          feedback.textContent = result.status === 'denied' ? 'The host denied the request.' : 'Request ended. Try again when ready.';
          return result.status === 'denied' ? 'denied' : 'ended';
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!attempt.cancelled) feedback.textContent = 'The request expired. Try again when ready.';
      return attempt.cancelled ? 'cancelled' : 'expired';
    } catch (error) {
      if (!attempt.cancelled) { feedback.textContent = error.message; if ([403, 409].includes(error.status)) void status(); }
      if (attempt.cancelled) return 'cancelled';
      return error.status === 409 ? 'busy' : error.status === 403 ? 'pairing-required' : 'request-failed';
    }
    finally {
      connectionAttempt = null;
      reconnect.disabled = !available;
      if (forget) forget.disabled = false;
      $('remembered-cancel').hidden = true;
    }
  }
  reconnect.addEventListener('click', () => requestConnection());
  return { status, requestConnection, cancelRequest, forgetComputer,
    async inspect() {
      await status();
      return { phase, pairingId, paired: known && !identityChanged, computer: computer && { ...computer } };
    },
    authenticated(viewOnly) { $('remember-device').hidden = viewOnly || location.protocol !== 'https:'; if (!viewOnly) void status(); },
  };
}
