import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyboardShortcuts, shortcutBinding, shortcutLabel, SHORTCUT_KEYS } from '../receiver/shortcuts.mjs';
import { validBrowserInput } from './browser-protocol.mjs';
function fixture(raw) {
  const data = new Map(raw ? [['dskcpy.shortcuts.v1', raw]] : []), packets = [];
  let allowed = true;
  const options = { send: p => packets.push(Buffer.from(p)), canSend: () => allowed,
    storage: () => ({ getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) }) };
  return { keys: createKeyboardShortcuts(options), packets, data, options, deny: () => allowed = false };
}
test('configured shortcut is an explicit balanced key pair within the existing wire whitelist', () => {
  const f = fixture(); assert.deepEqual(f.keys.configure(0, 'KeyS', 11), { ok: true, saved: true });
  assert.equal(f.packets.length, 0, 'configuration does not execute');
  assert.equal(f.keys.tap(0), true);
  assert.deepEqual(f.packets.map(p => [...p]), [[8, 0, 0, 22, 11], [8, 1, 0, 22, 0]]);
  for (const code of SHORTCUT_KEYS) {
    assert.ok(shortcutBinding(code, 15)); f.keys.configure(1, code, 15); f.keys.tap(1);
  }
  assert.ok(f.packets.every(p => validBrowserInput(p, 640, 480, { keyboard: true })));
  assert.ok(f.packets.every(p => !validBrowserInput(p, 640, 480, { keyboard: false })));
  assert.equal(shortcutLabel({ code: 'KeyS', modifiers: 11 }), 'Ctrl + Shift + Meta + S');
  f.deny(); const count = f.packets.length; assert.equal(f.keys.tap(0), false); assert.equal(f.packets.length, count);
});
test('only six validated single-key bindings persist; invalid and oversized data falls back atomically', () => {
  const f = fixture(); f.keys.configure(2, 'F20', 8);
  const restored = createKeyboardShortcuts(f.options); assert.equal(restored.bindings()[2].code, 'F20');
  const copy = restored.bindings(); copy[2].code = 'LaunchMail'; assert.equal(restored.bindings()[2].code, 'F20');
  for (const raw of ['invalid', 'x'.repeat(2049), JSON.stringify({ version: 1, bindings: [{ code: 'KeyA', modifiers: 0 }] }),
    JSON.stringify({ version: 1, bindings: [...f.keys.bindings().slice(0, 5), { code: 'ControlLeft', modifiers: 0 }] }),
    JSON.stringify({ version: 2, bindings: f.keys.bindings() })]) {
    assert.equal(fixture(raw).keys.bindings()[2].code, 'Escape');
  }
  assert.ok([...f.data.values()].every(s => s.length <= 2048));
  assert.equal(restored.reset().saved, true); assert.equal(f.packets.length, 0);
});
test('invalid slot/key/mask changes are rejected and unavailable storage keeps an in-page configuration', () => {
  const f = fixture();
  for (const args of [[-1, 'KeyA', 0], [6, 'KeyA', 0], [NaN, 'KeyA', 0], [0, 'F21', 0], [0, 'KeyA', 256], [0, 'KeyA', -1], [0, 'KeyA', 1.5], [0, '<script>', 0]])
    assert.equal(f.keys.configure(...args).ok, false);
  for (const i of [-1, 6, NaN, '0']) assert.equal(f.keys.tap(i), false);
  assert.equal(f.packets.length, 0);
  const keys = createKeyboardShortcuts({ ...f.options, storage: () => { throw Error('Denied'); } });
  assert.deepEqual(keys.configure(0, 'Tab', 2), { ok: true, saved: false }); assert.equal(keys.tap(0), true);
});
test('failed transport never queues a chord; a failed key-up attempts release-all', () => {
  const packets = [];
  const keys = createKeyboardShortcuts({ canSend: () => true, send(p) { packets.push([...p]); if (p[1] === 1) return false; } });
  assert.equal(keys.tap(0), false); assert.deepEqual(packets.map(p => p[1]), [0, 1, 2]);
  const denied = createKeyboardShortcuts({ canSend: () => true, send: () => false }); assert.equal(denied.tap(0), false);
  const throwing = createKeyboardShortcuts({ canSend: () => true, send() { throw Error('Gone'); } }); assert.equal(throwing.tap(0), false);
});
