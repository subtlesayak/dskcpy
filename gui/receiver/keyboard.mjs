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

// Only the explicit typing field receives keys. Its recent preview stays local;
// nothing is read from the clipboard or saved to browser storage.
export function createBrowserKeyboard({ field, send, canSend, onError = () => {} }) {
  const down = new Map();
  let armed = false, composing = false, preview = '', remoteAnchor = 0, remoteFocus = 0;
  const allowed = () => armed && canSend();
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const parts = value => segmenter ? Array.from(segmenter.segment(value), item => item.segment) : Array.from(value);
  const boundaries = value => { const list = [0]; for (const part of parts(value)) list.push(list.at(-1) + part.length); return list; };
  function paint(anchor = remoteAnchor, focus = remoteFocus) {
    field.value = preview;
    field.setSelectionRange?.(Math.min(anchor, focus), Math.max(anchor, focus), anchor > focus ? 'backward' : 'forward');
  }
  function clearPreview() { preview = ''; remoteAnchor = remoteFocus = 0; paint(); }
  function releaseKeys() {
    if (down.size) send(keyPacket(2));
    down.clear();
  }
  function release() { releaseKeys(); composing = false; }
  function clearContext() { release(); clearPreview(); }
  function selection() {
    const start = Number.isInteger(field.selectionStart) ? Math.min(field.selectionStart, preview.length) : preview.length;
    const end = Number.isInteger(field.selectionEnd) ? Math.min(field.selectionEnd, preview.length) : preview.length;
    return field.selectionDirection === 'backward' ? [end, start] : [start, end];
  }
  function stroke(usage, count = 1, mask = 0) {
    if (!count) return;
    for (let i = 0; i < count; i++) {
      send(keyPacket(0, usage, mask)); send(keyPacket(1, usage));
    }
  }
  function rank(offset) { return parts(preview.slice(0, offset)).length; }
  function selectRemote(anchor, focus) {
    if (anchor === remoteAnchor && focus === remoteFocus) return;
    if (remoteAnchor !== remoteFocus) {
      const left = Math.min(remoteAnchor, remoteFocus), right = Math.max(remoteAnchor, remoteFocus);
      const collapseRight = Math.abs(rank(anchor) - rank(right)) < Math.abs(rank(anchor) - rank(left));
      stroke(collapseRight ? 79 : 80); remoteAnchor = remoteFocus = collapseRight ? right : left;
    }
    const move = rank(anchor) - rank(remoteFocus);
    stroke(move < 0 ? 80 : 79, Math.abs(move)); remoteAnchor = remoteFocus = anchor;
    const extend = rank(focus) - rank(anchor);
    stroke(extend < 0 ? 80 : 79, Math.abs(extend), 2); remoteFocus = focus;
  }
  function syncSelection() {
    if (!allowed() || composing) return;
    selectRemote(...selection());
  }
  function trimPreview() {
    if (preview.length <= 384 || remoteAnchor !== remoteFocus || remoteFocus !== preview.length) return;
    const cut = boundaries(preview).find(offset => offset >= preview.length - 256);
    preview = preview.slice(cut); remoteAnchor -= cut; remoteFocus -= cut; paint();
  }
  function insertText(value) {
    let part = '', size = 0;
    for (const character of value) {
      const next = new TextEncoder().encode(character).length;
      if (size + next > 512) { send(textPacket(part)); part = ''; size = 0; }
      part += character; size += next;
    }
    if (part) send(textPacket(part));
  }
  function changed() {
    if (!allowed()) { clearPreview(); return; }
    const value = field.value;
    if (value === preview) return;
    if (value.length > 512 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
      paint(); onError('Send up to 512 characters without unsupported control characters at a time.'); return;
    }
    // Diff the retained local preview, not the full Mac field. Only the new
    // edit crosses the wire; repeated composition/input notifications are no-ops.
    const old = parts(preview), next = parts(value);
    let prefix = 0, suffix = 0;
    while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
    while (suffix < old.length - prefix && suffix < next.length - prefix
        && old[old.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
    const start = old.slice(0, prefix).join('').length;
    const end = preview.length - old.slice(old.length - suffix).join('').length;
    const inserted = next.slice(prefix, next.length - suffix).join('');
    const target = [field.selectionStart, field.selectionEnd, field.selectionDirection];
    // Replace from the end of the changed range with balanced Backspaces.
    // Native IME completion must not depend on synthetic Shift selection.
    selectRemote(end, end);
    stroke(42, parts(preview.slice(start, end)).length);
    insertText(inserted);
    preview = value; remoteAnchor = remoteFocus = start + inserted.length;
    if (Number.isInteger(target[0]) && Number.isInteger(target[1])) {
      field.setSelectionRange?.(target[0], target[1], target[2]);
    }
    trimPreview();
  }
  function editPreview(usage) {
    const [anchor, focus] = selection();
    let start = Math.min(anchor, focus), end = Math.max(anchor, focus);
    if (start === end && usage === 42) start = boundaries(preview).filter(offset => offset < start).at(-1) ?? start;
    if (start === end && usage === 76) end = boundaries(preview).find(offset => offset > end) ?? end;
    const value = usage === 40 ? '\n' : '';
    if (usage === 40) {
      selectRemote(end, end); stroke(42, parts(preview.slice(start, end)).length); stroke(40);
      preview = preview.slice(0, start) + value + preview.slice(end);
      remoteAnchor = remoteFocus = start + 1; paint(); trimPreview(); return;
    }
    if (start === end && !value) { selectRemote(start, start); stroke(usage); return; }
    field.value = preview.slice(0, start) + value + preview.slice(end);
    field.setSelectionRange?.(start + value.length, start + value.length);
    changed();
  }
  function movePreview(code, shifted) {
    const left = Math.min(remoteAnchor, remoteFocus), right = Math.max(remoteAnchor, remoteFocus);
    if (!shifted && left !== right) remoteAnchor = remoteFocus = code === 'ArrowLeft' ? left : right;
    else {
      const positions = boundaries(preview), current = remoteFocus;
      const target = code === 'ArrowLeft' ? positions.filter(offset => offset < current).at(-1) : positions.find(offset => offset > current);
      // Beyond our local fragment, the Mac may have more text. Start a new
      // preview at that remote caret rather than guessing the Mac's content.
      if (target === undefined) { clearPreview(); return; }
      remoteFocus = target; if (!shifted) remoteAnchor = target;
    }
    paint();
  }
  field.addEventListener('keydown', event => {
    if (!allowed() || composing || event.isComposing || event.key === 'Process'
        || event.getModifierState?.('AltGraph')) return;
    const usage = keyboardUsage(event.code);
    if (event.key?.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    if (!usage) return;
    event.preventDefault();
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if (plain && [40,42,76].includes(usage)) { editPreview(usage); return; }
    else if (plain && ['ArrowLeft','ArrowRight'].includes(event.code)) { syncSelection(); movePreview(event.code, event.shiftKey); }
    else if (usage < 224) clearPreview();
    down.set(event.code, usage); send(keyPacket(0, usage, modifiers(event)));
  });
  field.addEventListener('keyup', event => {
    const usage = down.get(event.code); if (!usage) return;
    event.preventDefault();
    if (!allowed()) { release(); return; }
    down.delete(event.code); send(keyPacket(1, usage, modifiers(event)));
  });
  field.addEventListener('compositionstart', () => { composing = true; });
  field.addEventListener('compositionend', event => {
    composing = false;
    if (!field.value && event.data && !preview) field.value = event.data;
    changed();
  });
  field.addEventListener('input', event => { if (!composing && !event.isComposing) changed(); });
  field.addEventListener('beforeinput', event => {
    if (!allowed() || composing || event.isComposing) return;
    // Some mobile/IME edits cannot be canceled. Let the browser perform them
    // and translate the resulting input diff instead of deleting twice.
    if (event.cancelable === false) return;
    const usage = event.inputType === 'deleteContentBackward' ? 42 : event.inputType === 'deleteContentForward' ? 76
      : ['insertLineBreak','insertParagraph'].includes(event.inputType) ? 40 : 0;
    if (usage) { event.preventDefault(); editPreview(usage); }
  });
  // A native IME suggestion can briefly blur/refocus the field before its
  // replacement arrives. Releasing held keys must not forget the text already
  // sent, or the completed word would be appended after its existing prefix.
  field.addEventListener('blur', releaseKeys);
  const leaveTyping = event => { if (event.target && event.target !== field) clearContext(); };
  field.ownerDocument?.addEventListener('pointerdown', leaveTyping);
  field.ownerDocument?.addEventListener('focusin', leaveTyping);
  return { release, setEnabled(value) { if (!value) clearContext(); armed = value; if (armed) field.focus(); } };
}
