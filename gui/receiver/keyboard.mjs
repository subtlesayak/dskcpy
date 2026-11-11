const special = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
  BracketLeft: 47, BracketRight: 48, Backslash: 49, Semicolon: 51, Quote: 52,
  Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  Home: 74, PageUp: 75, Delete: 76, End: 77, PageDown: 78,
  ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81, ArrowUp: 82,
  NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86,
  NumpadAdd: 87, NumpadEnter: 88, Numpad0: 98, NumpadDecimal: 99,
  IntlBackslash: 100, NumpadEqual: 103,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
  ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
};
export function keyboardUsage(code = '') {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3) - 61;
  if (/^Digit[0-9]$/.test(code)) return code[5] === '0' ? 39 : 29 + Number(code[5]);
  if (/^Numpad[1-9]$/.test(code)) return 88 + Number(code[6]);
  if (/^F([1-9]|1[0-9]|20)$/.test(code)) { const n = Number(code.slice(1)); return n <= 12 ? 57 + n : 91 + n; }
  return special[code] || 0;
}
export function keyPacket(action, usage = 0, modifiers = 0) {
  const result = new Uint8Array(5); result[0] = 8; result[1] = action;
  new DataView(result.buffer).setUint16(2, usage); result[4] = modifiers; return result;
}
export function textPacket(text) {
  const bytes = new TextEncoder().encode(text);
  if (!bytes.length || bytes.length > 512 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('Unsupported text');
  const result = new Uint8Array(3 + bytes.length); result[0] = 9;
  new DataView(result.buffer).setUint16(1, bytes.length); result.set(bytes, 3); return result;
}
function modifiers(event) {
  return (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
}

// Original browser input adapter. Only the explicitly focused typing field
// receives keys; nothing is read from the clipboard or saved to browser storage.
export function createBrowserKeyboard({ field, send, canSend, onError = () => {} }) {
  const down = new Map();
  let armed = false, composing = false, committedComposition = '';
  const allowed = () => armed && canSend();
  function release() {
    if (down.size) send(keyPacket(2));
    down.clear(); composing = false; committedComposition = ''; field.value = '';
  }
  function commit(value) {
    field.value = '';
    if (!allowed() || !value) return;
    if (value.length > 512) { onError('Send up to 512 characters at a time.'); return; }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) { onError('This text contains unsupported control characters.'); return; }
    try {
      let part = '', size = 0;
      for (const character of value) {
        const next = new TextEncoder().encode(character).length;
        if (size + next > 512) { send(textPacket(part)); part = ''; size = 0; }
        part += character; size += next;
      }
      if (part) send(textPacket(part));
    } catch { onError('This text contains unsupported control characters.'); }
  }
  field.addEventListener('keydown', (event) => {
    if (!allowed() || composing || event.isComposing || event.key === 'Process'
        || event.getModifierState?.('AltGraph')) return;
    const usage = keyboardUsage(event.code);
    // Printable/IME text is committed by input, preserving the receiving layout.
    if (event.key?.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    if (!usage) return;
    event.preventDefault(); down.set(event.code, usage);
    send(keyPacket(0, usage, modifiers(event)));
  });
  field.addEventListener('keyup', (event) => {
    const usage = down.get(event.code);
    if (!usage) return;
    event.preventDefault();
    if (!allowed()) { release(); return; }
    down.delete(event.code); send(keyPacket(1, usage, modifiers(event)));
  });
  field.addEventListener('compositionstart', () => { composing = true; committedComposition = ''; });
  field.addEventListener('compositionend', (event) => {
    composing = false; committedComposition = event.data || field.value;
    commit(field.value || event.data || '');
  });
  field.addEventListener('input', (event) => {
    if (composing || event.isComposing) return;
    const value = field.value;
    if (committedComposition && ['insertFromComposition', 'insertCompositionText'].includes(event.inputType)
        && value === committedComposition) { field.value = ''; committedComposition = ''; return; }
    committedComposition = ''; commit(value);
  });
  field.addEventListener('beforeinput', (event) => {
    if (!allowed() || composing || event.isComposing) return;
    const usage = event.inputType === 'deleteContentBackward' ? 42
      : ['insertLineBreak', 'insertParagraph'].includes(event.inputType) ? 40 : 0;
    if (usage) { event.preventDefault(); send(keyPacket(0, usage)); send(keyPacket(1, usage)); }
  });
  field.addEventListener('blur', release);
  return { release, setEnabled(value) { if (!value) release(); armed = value; if (armed) field.focus(); } };
}
