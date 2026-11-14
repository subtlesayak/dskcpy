export const CLIPBOARD_MAX = 4096;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export function clipboardText(text, empty = false) {
  if (typeof text !== 'string' || text.length > CLIPBOARD_MAX || (!empty && !text.length) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error('Use plain text within 4 KB.');
  const bytes = encoder.encode(text);
  if (bytes.length > CLIPBOARD_MAX || decoder.decode(bytes) !== text) throw Error('Use plain text within 4 KB.');
  return bytes;
}
export function clipboardRequest(op, id, text = '') {
  if (![0,1,2].includes(op) || !Number.isInteger(id) || id < 1 || id > 0xffffffff || (op === 0 && text !== '')) throw Error('Invalid clipboard request.');
  const bytes = clipboardText(text, op === 0), packet = new Uint8Array(8 + bytes.length), view = new DataView(packet.buffer);
  packet[0] = 10; packet[1] = op; view.setUint32(2, id); view.setUint16(6, bytes.length); packet.set(bytes, 8); return packet;
}
export function readClipboardRequest(bytes) {
  if (bytes.length < 8 || bytes.length > CLIPBOARD_MAX + 8) throw Error('Invalid clipboard request.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), op = bytes[1], id = view.getUint32(2), length = view.getUint16(6);
  if (bytes[0] !== 10 || ![0,1,2].includes(op) || !id || length !== bytes.length - 8 || (op === 0 && length)) throw Error('Invalid clipboard request.');
  const text = decoder.decode(bytes.subarray(8)); clipboardText(text, op === 0); return { op, id, text };
}
export function readClipboardReply(bytes) {
  if (bytes.length < 8 || bytes.length > CLIPBOARD_MAX + 8) throw Error('Invalid clipboard reply.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), op = bytes[0], status = bytes[1], id = view.getUint32(2), length = view.getUint16(6);
  if (![0,1,2].includes(op) || status > 4 || !id || length !== bytes.length - 8 || ((op !== 0 || status !== 0) && length)) throw Error('Invalid clipboard reply.');
  const text = decoder.decode(bytes.subarray(8)); clipboardText(text, true); return { op, id, status, ...(op === 0 && status === 0 ? { text } : {}) };
}
export const cancelClipboardPacket = () => new Uint8Array([10,3,0,0,0,0,0,0]);

// No listeners read either clipboard automatically. The caller supplies the
// browser API only to the two local buttons; remote actions are separate.
export function createBrowserClipboard({ section, field, toggle, status, buttons, canUse, send, control, localClipboard, timeoutMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let supported = false, enabled = false, pending = null, sequence = 0, epoch = 0, localBusy = false;
  const say = message => { status.textContent = message; };
  function paint() {
    const available = supported && canUse();
    if (!available && enabled) { reset(); return; }
    toggle.disabled = !available; toggle.checked = enabled;
    field.disabled = !available || !enabled || Boolean(pending) || localBusy;
    for (const button of Object.values(buttons)) button.disabled = field.disabled;
  }
  function reset(notify = true) {
    ++epoch; if (pending) clearTimer(pending.timer); pending = null; localBusy = false;
    if (enabled && notify) control('clipboard-disable');
    enabled = false; field.value = ''; toggle.checked = false; say(''); paint();
  }
  function result(message) {
    if (!pending || message.id !== pending.id || message.op !== pending.op) return;
    if (!Number.isInteger(message.status) || message.status < 0 || message.status > 6) throw Error('Invalid clipboard response.');
    if (message.status === 0 && message.op === 0) clipboardText(message.text, true);
    clearTimer(pending.timer); pending = null;
    if (!enabled || !canUse()) { reset(); return; }
    if (message.status === 0) {
      if (message.op === 0) { field.value = message.text; say(message.text ? 'Computer text is ready. Copy it to this device when you choose.' : 'The computer’s text clipboard is empty.'); }
      else say(message.op === 2 ? 'Text copied and Paste sent. Check the active computer app.' : 'Text copied to the computer clipboard.');
    } else {
      if (message.op === 0) field.value = '';
      if (message.status === 6) field.value = '';
      say(['', 'Clipboard unavailable. Choose plain text and try again.', 'Use text smaller than 4 KB.',
        'Text was copied, but Paste could not finish. Check the computer before retrying.',
        'Clipboard access is blocked. Check the host permission and resume input.',
        'A clipboard action is already in progress. Wait, then try again.',
        'Clipboard request timed out. Check the computer before retrying.'][message.status]);
    }
    paint();
  }
  function request(op) {
    if (!enabled || !canUse() || pending || localBusy) return;
    let packet;
    try { packet = clipboardRequest(op, ++sequence, op === 0 ? '' : field.value); }
    catch { say('Enter plain text within 4 KB before copying or pasting.'); field.focus(); return; }
    const record = { id: sequence, op };
    record.timer = setTimer(() => { if (pending === record) { pending = null; field.value = ''; say('Clipboard request timed out. Check the computer before retrying.'); paint(); } }, timeoutMs);
    pending = record; paint(); say(op === 0 ? 'Reading computer clipboard…' : 'Sending text…');
    if (!send(packet)) { reset(); say('Reconnect, then enable clipboard tools to try again.'); }
  }
  toggle.addEventListener('change', () => {
    if (!toggle.checked) { reset(); return; }
    if (!supported || !canUse() || control('clipboard-enable') === false) { reset(); return; }
    enabled = true; say('Clipboard tools enabled. Nothing transfers until you choose an action.'); paint();
  });
  buttons.read.addEventListener('click', () => request(0));
  buttons.copyHost.addEventListener('click', () => request(1));
  buttons.pasteHost.addEventListener('click', () => request(2));
  buttons.readLocal.addEventListener('click', async () => {
    if (!enabled || !canUse() || pending || localBusy) return; const mine = epoch; localBusy = true; paint();
    try {
      if (!localClipboard?.readText) throw Error('Unavailable');
      const text = await localClipboard.readText();
      if (mine !== epoch || !enabled || !canUse()) return;
      clipboardText(text, true); field.value = text; say(text ? 'Device text is ready. Choose Copy or Paste on computer to send it.' : 'This device’s text clipboard is empty.');
    } catch { if (mine === epoch) say('Paste text manually into the field, then choose a computer action.'); }
    finally { if (mine === epoch) { localBusy = false; paint(); } }
  });
  buttons.copyLocal.addEventListener('click', async () => {
    if (!enabled || !canUse() || pending || localBusy) return; const mine = epoch; localBusy = true; paint();
    try {
      clipboardText(field.value);
      if (!localClipboard?.writeText) throw Error('Unavailable');
      await localClipboard.writeText(field.value);
      if (mine === epoch && enabled && canUse()) say('Text copied to this device.');
    } catch { if (mine === epoch) say('Read or enter text, then copy it. You can also select the text and copy manually.'); }
    finally { if (mine === epoch) { localBusy = false; paint(); } }
  });
  section.addEventListener('toggle', () => { if (!section.open) reset(); });
  return { reset, result, refresh: paint, setSupported(value) { reset(false); supported = value === true; section.hidden = !supported; paint(); },
    isActive: () => enabled };
}
