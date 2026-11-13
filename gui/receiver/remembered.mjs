export function rememberedBrowser({ reconnect, document = globalThis.document, location = globalThis.location,
  fetch = globalThis.fetch, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout }) {
  const $ = id => document.getElementById(id);
  let known = false, busy = false, timer;
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
      $('remember-status').textContent = result.status === 'pending' ? 'Waiting for approval on the Mac. Keep this session open.'
        : known ? result.paused ? 'Saved. Access is paused on the Mac.' : 'Saved. Return to this same address in this browser to reconnect for up to 90 days.'
        : 'Pair once, then ask the Mac to remember this browser. Use only a device you own.';
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
  $('remembered-reconnect').addEventListener('click', reconnect);
  return { status,
    authenticated(viewOnly) { $('remember-device').hidden = viewOnly || location.protocol !== 'https:'; if (!viewOnly) void status(); },
    async ticket() {
      if (!await status()) return null;
      const result = await request('trusted/connect');
      return result.key;
    },
  };
}
