import { keyboardUsage, keyPacket } from './keyboard.mjs';

// Fixed key codes, not recorded keystrokes, text snippets, scripts or macros.
export const SHORTCUT_KEYS = Object.freeze([
  ...['Tab', 'Enter', 'Escape', 'Backspace', 'Delete', 'Space', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'],
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 20 }, (_, i) => `F${i + 1}`),
  ...['Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Backquote', 'Comma', 'Period', 'Slash', 'CapsLock',
    'NumLock', 'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract', 'NumpadAdd', 'NumpadEnter', 'NumpadDecimal', 'IntlBackslash', 'NumpadEqual'],
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
]);
const codes = new Set(SHORTCUT_KEYS);
const storageKey = 'dskcpy.shortcuts.v1';
const defaults = () => ['Tab', 'Enter', 'Escape', 'Backspace', 'Home', 'End'].map(code => ({ code, modifiers: 0 }));
export function shortcutBinding(code, modifiers) {
  if (!codes.has(code) || !keyboardUsage(code) || !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 15) return null;
  return { code, modifiers };
}
export function shortcutKeyLabel(code) {
  if (!codes.has(code)) return '';
  const names = { PageUp: 'Page Up', PageDown: 'Page Down', Minus: '−', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: String.fromCharCode(92), Semicolon: ';', Quote: String.fromCharCode(39), Backquote: String.fromCharCode(96), Comma: ',', Period: '.', Slash: '/',
    CapsLock: 'Caps Lock', NumLock: 'Num Lock / Clear', IntlBackslash: 'ISO extra key', NumpadDivide: 'Keypad /', NumpadMultiply: 'Keypad *',
    NumpadSubtract: 'Keypad −', NumpadAdd: 'Keypad +', NumpadEnter: 'Keypad Enter', NumpadDecimal: 'Keypad decimal', NumpadEqual: 'Keypad =' };
  if (/^Numpad\d$/.test(code)) return `Keypad ${code.at(-1)}`;
  return names[code] || code.replace(/^Key|^Digit/, '').replace(/^Arrow/, '');
}
export function shortcutLabel(binding) {
  const b = shortcutBinding(binding?.code, binding?.modifiers);
  if (!b) return '';
  const name = shortcutKeyLabel(b.code);
  return [...['Ctrl', 'Shift', 'Alt', 'Meta'].filter((_, i) => b.modifiers & (1 << i)), name].join(' + ');
}
export function createKeyboardShortcuts({ send, canSend, storage = () => null }) {
  let bindings = defaults();
  try {
    const raw = storage()?.getItem(storageKey);
    if (typeof raw === 'string' && raw.length <= 2048) {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && Array.isArray(parsed.bindings) && parsed.bindings.length === 6) {
        const checked = parsed.bindings.map(b => shortcutBinding(b?.code, b?.modifiers));
        if (checked.every(Boolean)) bindings = checked;
      }
    }
  } catch { /* Private mode or invalid local preferences: use defaults. */ }
  const validIndex = index => Number.isInteger(index) && index >= 0 && index < 6;
  function save() {
    try {
      const store = storage(); if (!store) return false;
      store.setItem(storageKey, JSON.stringify({ version: 1, bindings })); return true;
    } catch { return false; }
  }
  return {
    bindings: () => bindings.map(b => ({ ...b })),
    configure(index, code, modifiers) {
      const binding = shortcutBinding(code, modifiers);
      if (!validIndex(index) || !binding) return { ok: false, saved: false };
      bindings[index] = binding; return { ok: true, saved: save() };
    },
    reset() { bindings = defaults(); return { ok: true, saved: save() }; },
    tap(index) {
      if (!validIndex(index) || !canSend()) return false;
      const b = bindings[index], usage = keyboardUsage(b.code);
      let pressed = false;
      try {
        if (send(keyPacket(0, usage, b.modifiers)) === false) return false;
        pressed = true;
        if (send(keyPacket(1, usage, 0)) === false) throw Error('Key release was not accepted');
        return true;
      } catch {
        // Best effort only. Socket/native lifecycle cleanup remains responsible
        // when the transport itself is gone; never queue/replay a shortcut.
        if (pressed) { try { send(keyPacket(2)); } catch {} }
        return false;
      }
    },
  };
}
