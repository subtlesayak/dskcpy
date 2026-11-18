export function rememberedBrowser({ connectApproved, document = globalThis.document, location = globalThis.location,
  fetch = globalThis.fetch, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  const $ = id => document.getElementById(id);
  let known = false, busy = false, timer, connectionAttempt;
  async function request(route, body = {}) {
    const response = await fetch(`/stream/${route}`, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'The host could not finish this request.'), { status: response.status });
    return result;
  }
  async function status() {
    if (location.protocol !== 'https:') return false;
    try {
      const result = await request('remember/status');
      known = result.status === 'approved';
      $('remembered-join').hidden = !known;
      if (!connectionAttempt) $('remembered-reconnect').disabled = result.streamApproval !== true || result.paused === true;
      if (known && result.streamApproval !== true) $('remembered-connection-status').textContent = 'Update the computer to request a new stream.';
      else if (known && result.paused === true) $('remembered-connection-status').textContent = 'Connection requests are paused on the computer.';
      $('remember-status').textContent = result.status === 'pending' ? 'Waiting for pairing approval on the computer. Keep this session open.'
        : known ? result.paused ? 'Saved. Requests are paused on the computer.' : 'Paired. Return to this address to request a new stream.'
        : 'Ask the computer to pair this browser. Use only a device you own.';
      if (result.status === 'pending') { clearTimeout(timer); timer = setTimeout(status, 2000); }
      return known;
    } catch { return false; }
  }
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
  $('remembered-cancel').addEventListener('click', () => {
    if (!connectionAttempt) return;
    $('remembered-connection-status').textContent = 'Connection request cancelled.';
    $('remembered-cancel').hidden = true;
    void cancelConnection(connectionAttempt);
  });
  $('remembered-reconnect').addEventListener('click', async () => {
    if (connectionAttempt || !known || location.protocol !== 'https:') return;
    const attempt = connectionAttempt = { cancelled: false };
    const feedback = $('remembered-connection-status');
    $('remembered-reconnect').disabled = true;
    $('remembered-cancel').hidden = false;
    feedback.textContent = 'Sending connection request…';
    try {
      const pending = await request('trusted/connect', { action: 'request' });
      if (!/^[a-f0-9]{32}$/.test(pending.id || '') || !Number.isSafeInteger(pending.expiresAt)) throw Error('Update the host to request a new stream.');
      attempt.id = pending.id;
      if (attempt.cancelled) { await cancelConnection(attempt); return; }
      feedback.textContent = 'Waiting for host approval';
      const deadline = Math.min(Date.now() + 120000, pending.expiresAt);
      while (!attempt.cancelled && Date.now() < deadline) {
        const result = await request('trusted/status', { id: attempt.id });
        if (attempt.cancelled) return;
        if (/^[A-Za-z0-9_-]{32}$/.test(result.key || '')) {
          if (connectApproved(result.key)) return;
          await cancelConnection(attempt);
          feedback.textContent = 'Return to this page and request a new stream.';
          return;
        }
        if (!['pending', 'claiming'].includes(result.status)) {
          feedback.textContent = result.status === 'denied' ? 'The host denied the request.' : 'Request ended. Try again when ready.';
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!attempt.cancelled) feedback.textContent = 'The request expired. Try again when ready.';
    } catch (error) { if (!attempt.cancelled) feedback.textContent = error.message; }
    finally {
      connectionAttempt = null;
      $('remembered-reconnect').disabled = false;
      $('remembered-cancel').hidden = true;
    }
  });
  return { status,
    authenticated(viewOnly) { $('remember-device').hidden = viewOnly || location.protocol !== 'https:'; if (!viewOnly) void status(); },
  };
}
