import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserKeyboard, keyboardUsage, keyPacket, textPacket } from '../receiver/keyboard.mjs';
import { validBrowserInput } from './browser-protocol.mjs';

function keyboard() {
  const listeners = new Map(), packets = [], errors = [];
  let allowed = true;
  const field = { value: '', focus() {}, addEventListener(type, fn) { listeners.set(type, fn); } };
  const input = createBrowserKeyboard({ field, send: (bytes) => packets.push(Buffer.from(bytes)),
    canSend: () => allowed, onError: (message) => errors.push(message) });
  const emit = (type, event = {}) => { const e = { preventDefault() { this.prevented = true; }, ...event }; listeners.get(type)?.(e); return e; };
  return { field, input, packets, errors, emit, deny() { allowed = false; }, text(value, event = {}) { field.value = value; emit('input', event); } };
}

test('keyboard wire layout is bounded and requires explicit host capability', () => {
  assert.equal(keyboardUsage('KeyA'), 4); assert.equal(keyboardUsage('Digit0'), 39);
  assert.equal(keyboardUsage('F20'), 111); assert.equal(keyboardUsage('MetaRight'), 231);
  assert.equal(keyboardUsage('LaunchMail'), 0);
  const key = Buffer.from(keyPacket(0, 4, 8));
  assert.equal(validBrowserInput(key, 640, 480), false);
  assert.equal(validBrowserInput(key, 640, 480, { keyboard: true }), true);
  assert.equal(validBrowserInput(Buffer.from([8, 2, 0, 0, 1]), 640, 480, { keyboard: true }), false);
  const text = Buffer.from(textPacket('नमस्ते 👋'));
  assert.equal(validBrowserInput(text, 640, 480, { keyboard: true }), true);
  for (const bytes of [[9, 0, 1, 0], [9, 0, 2, 0xc0, 0x80], [9, 0, 3, 0xed, 0xa0, 0x80], [9, 0, 1, 0x1b]])
    assert.equal(validBrowserInput(Buffer.from(bytes), 640, 480, { keyboard: true }), false);
});

test('modifier release order, repeats and changed key text retain matching key-up usages', () => {
  const h = keyboard(); h.input.setEnabled(true);
  h.emit('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true });
  h.emit('keydown', { code: 'KeyA', key: 'a', ctrlKey: true });
  h.emit('keydown', { code: 'KeyA', key: 'a', ctrlKey: true, repeat: true });
  h.emit('keyup', { code: 'ControlLeft', key: 'Control' });
  h.emit('keyup', { code: 'KeyA', key: 'q' });
  assert.deepEqual(h.packets.map((p) => [p[1], p.readUInt16BE(2)]), [[0,224], [0,4], [0,4], [1,224], [1,4]]);
  h.emit('keyup', { code: 'KeyA', key: 'a' }); assert.equal(h.packets.length, 5);
});

test('unarmed, denied or unfocused input never becomes a global keyboard listener', () => {
  const h = keyboard(); h.text('private'); assert.equal(h.packets.length, 0);
  h.input.setEnabled(true); h.emit('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' });
  h.emit('blur'); assert.deepEqual([...h.packets.at(-1)], [8, 2, 0, 0, 0]);
  h.deny(); h.text('blocked'); h.emit('keydown', { code: 'Enter', key: 'Enter' });
  assert.equal(h.packets.length, 2); assert.equal(h.field.value, '');
});

test('printable and composed Unicode commits once without forwarding intermediate composition', () => {
  const h = keyboard(); h.input.setEnabled(true);
  assert.equal(h.emit('keydown', { code: 'KeyA', key: 'a' }).prevented, undefined);
  h.text('a'); h.emit('compositionstart'); h.text('に', { isComposing: true });
  h.field.value = '日本'; h.emit('compositionend', { data: '日本' });
  h.text('日本', { inputType: 'insertFromComposition' });
  assert.deepEqual(h.packets.map((p) => p.subarray(3).toString('utf8')), ['a', '日本']);
  h.emit('beforeinput', { inputType: 'deleteContentBackward' });
  assert.deepEqual(h.packets.slice(-2).map((p) => [p[1], p.readUInt16BE(2)]), [[0,42], [1,42]]);
});

test('large Unicode commits split only at codepoint boundaries; invalid and oversized input is rejected atomically', () => {
  const h = keyboard(); h.input.setEnabled(true); const text = '👋'.repeat(200); h.text(text);
  assert.equal(h.packets.length, 2);
  assert.equal(h.packets.map((p) => new TextDecoder('utf8', { fatal: true }).decode(p.subarray(3))).join(''), text);
  assert.ok(h.packets.every((p) => p.length <= 515));
  h.text('x'.repeat(512) + '\x00'); h.text('x'.repeat(511) + '\x1b');
  assert.equal(h.packets.length, 2); assert.equal(h.errors.length, 2);
});
