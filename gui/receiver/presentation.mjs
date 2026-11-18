import { controllerJoinUrl } from './protocol.mjs';

// Presentation UI holds a controller invitation only in memory. Nothing is
// placed over the desktop picture; sharing/copying requires a separate action.
export function createPresentationUI({ document, window, navigator, location, canCreate, releaseInput, onRole, onPlaybackChange, onEnd }) {
  const $ = id => document.getElementById(id);
  if (!['presentation-entry', 'presentation-setup', 'presentation-open', 'presentation-create', 'presentation-method'].every(id => $(id))) return null;
  const dialog = $('presentation-setup');
  let capable = false, role = false, reserved = false, pending = false, link = null, version = 0, expires;
  const help = {
    'app-cast': 'Prepare Samsung Internet for the picture and a different browser app for the controller. Samsung documents App Cast, but this dskcpy device combination still needs testing. Use Smart View → App Cast after connecting the controller.',
    'display-browser': 'Open the desktop receiver in the display’s browser. Open the controller link on your phone. Both browsers need access to this host’s private connection.',
    mirror: 'Full phone mirroring can show your controller, keyboard, notifications and other apps on the display. It does not provide a private, separate phone controller. Use an app-only cast or another display browser for that separation.',
  };
  function paint() {
    $('presentation-entry').hidden = !capable;
    $('presentation-end').hidden = !role;
    $('presentation-create').disabled = pending || reserved || !canCreate();
    $('presentation-copy').disabled = !link;
    $('presentation-share').disabled = !link;
    $('presentation-share').hidden = typeof navigator.share !== 'function';
    const appCast = role && $('presentation-method').value === 'app-cast';
    $('presentation-background-setting').hidden = !appCast;
    $('presentation-background-help').hidden = !appCast;
    if (!appCast && $('presentation-background').checked) { $('presentation-background').checked = false; onPlaybackChange(); }
  }
  function clearLink() {
    clearTimeout(expires); link = null; $('presentation-private-link').value = '';
    $('presentation-link-actions').hidden = true; $('presentation-copy-fallback').hidden = true;
  }
  function setRole(value) {
    role = value; onRole(value); paint();
  }
  function open() {
    if (!capable) return;
    releaseInput(); paint();
    if (typeof dialog.showModal !== 'function') { $('presentation-controller-status').textContent = 'This browser cannot open the display setup. Use a current browser.'; return; }
    if (!dialog.open) dialog.showModal();
  }
  $('presentation-open').addEventListener('click', open);
  $('presentation-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const trigger = $('presentation-open');
    (trigger.getClientRects().length ? trigger : $('more')).focus();
  });
  $('presentation-method').addEventListener('change', () => {
    $('presentation-method-help').textContent = help[$('presentation-method').value] || '';
    $('presentation-method').removeAttribute('aria-invalid'); paint();
  });
  $('presentation-background').addEventListener('change', onPlaybackChange);
  $('presentation-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!help[$('presentation-method').value]) {
      $('presentation-method').setAttribute('aria-invalid', 'true'); $('presentation-error').textContent = 'Choose the display connection first.'; $('presentation-method').focus(); return;
    }
    if (pending || reserved || !canCreate()) return;
    pending = true; const mine = version; $('presentation-error').textContent = ''; paint();
    try {
      const response = await window.fetch('/stream/controller/invite', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create' }), signal: AbortSignal.timeout(5000) });
      const result = await response.json();
      if (mine !== version) return;
      if (!response.ok) throw Error(result.error || 'Could not create the controller link.');
      clearLink(); link = controllerJoinUrl(`${location.protocol}//${location.host}/`, result.key);
      setRole(true); $('presentation-link-actions').hidden = false;
      $('presentation-link-status').textContent = 'Controller link ready. Open it in the other browser within five minutes.';
      expires = setTimeout(() => { clearLink(); $('presentation-link-status').textContent = 'That controller link expired. Create another when ready.'; paint(); }, Math.max(0, Math.min(300000, Date.parse(result.expiresAt) - Date.now())));
    } catch (error) { if (mine === version) $('presentation-error').textContent = error.message || 'Could not create the controller link. Check the connection.'; }
    finally { if (mine === version) { pending = false; paint(); } }
  });
  $('presentation-copy').addEventListener('click', async () => {
    if (!link) return; const mine = version, current = link;
    try {
      if (!navigator.clipboard?.writeText) throw Error('Copy unavailable');
      await navigator.clipboard.writeText(current);
      if (mine === version && link === current) $('presentation-link-status').textContent = 'Link copied. Paste it into a different browser app on your phone.';
    } catch {
      if (mine !== version || link !== current) return;
      $('presentation-private-link').value = current; $('presentation-copy-fallback').hidden = false;
      $('presentation-private-link').focus(); $('presentation-private-link').select?.();
      $('presentation-link-status').textContent = 'Copy the hidden link below, or use Share controller link.';
    }
  });
  $('presentation-share').addEventListener('click', async () => {
    if (!link || typeof navigator.share !== 'function') return;
    try { await navigator.share({ title: 'dskcpy phone controller', text: 'Open this controller link in a different browser app on your phone.', url: link }); }
    catch { $('presentation-link-status').textContent = 'Link not shared. Try Copy controller link.'; }
  });
  $('presentation-end').addEventListener('click', async () => {
    releaseInput();
    if (!role || !window.confirm('End presentation?\nThis ends the desktop picture and its audio. The phone controller stays connected so it can stop the session.')) return;
    const mine = version;
    try {
      const response = await window.fetch('/stream/presentation/end', { method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw Error('Could not end presentation');
      if (mine === version) onEnd();
    } catch { if (mine === version) $('presentation-controller-status').textContent = 'Could not end the presentation. Check the connection and try again.'; }
  });
  return {
    available(value) { capable = value === true; paint(); },
    role: setRole,
    state(message) {
      if (!capable || typeof message.controllerConnected !== 'boolean' || typeof message.controllerActive !== 'boolean'
          || typeof message.controllerAuthorized !== 'boolean') throw Error('Unexpected presentation state.');
      reserved = message.controllerAuthorized;
      if (reserved) clearLink();
      const text = message.controllerConnected ? message.controllerActive ? 'Phone controller connected' : 'Phone controller connected · input paused'
        : reserved ? 'Controller away · it can reconnect for up to five minutes' : 'No phone controller connected';
      if ($('presentation-controller-status').textContent !== text) $('presentation-controller-status').textContent = text;
      paint();
    },
    get backgroundPlayback() { return role && $('presentation-method').value === 'app-cast' && $('presentation-background').checked; },
    reset() {
      version++; capable = role = reserved = pending = false; clearLink();
      $('presentation-background').checked = false; $('presentation-method').value = '';
      $('presentation-link-status').textContent = $('presentation-error').textContent = '';
      if (dialog.open) dialog.close(); onRole(false); paint();
    },
  };
}
