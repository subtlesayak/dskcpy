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
  h.text('a'); h.emit('compositionstart'); h.text('aに', { isComposing: true });
  h.field.value = 'a日本'; h.emit('compositionend', { data: '日本' });
  h.text('a日本', { inputType: 'insertFromComposition' });
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

// A small native-editor model checks resulting text, not just emitted packets.
// It intentionally starts with unrelated host text: the preview is a fragment,
// never a readback of the active Mac window.
function editor() {
  const listeners = new Map(), documentListeners = new Map(), packets = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let value = 'host:', anchor = value.length, focus = value.length;
  const bounds = () => [0, ...Array.from(segmenter.segment(value), x => x.index + x.segment.length)];
  const replace = text => { const start = Math.min(anchor, focus), end = Math.max(anchor, focus);
    value = value.slice(0, start) + text + value.slice(end); anchor = focus = start + text.length; };
  const field = { value: '', selectionStart: 0, selectionEnd: 0, selectionDirection: 'forward',
    ownerDocument: { activeElement: null, addEventListener(type, fn) { documentListeners.set(type, fn); } },
    focus() { this.ownerDocument.activeElement = this; },
    setSelectionRange(start, end, direction = 'forward') { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
    addEventListener(type, fn) { listeners.set(type, fn); } };
  const input = createBrowserKeyboard({ field, canSend: () => true, send(bytes) {
    const p = Buffer.from(bytes); packets.push(p);
    if (p[0] === 9) return replace(p.subarray(3).toString('utf8'));
    if (p[0] !== 8 || p[1] !== 0) return;
    const usage = p.readUInt16BE(2), shift = !!(p[4] & 2);
    const left = Math.min(anchor, focus), right = Math.max(anchor, focus);
    if (usage === 79 || usage === 80) {
      const target = !shift && left !== right ? (usage === 79 ? right : left)
        : usage === 79 ? (bounds().find(x => x > focus) ?? focus) : (bounds().filter(x => x < focus).at(-1) ?? focus);
      focus = target; if (!shift) anchor = target;
    } else if (usage === 42 || usage === 76) {
      if (left === right) { if (usage === 42) anchor = bounds().filter(x => x < focus).at(-1) ?? focus;
        else focus = bounds().find(x => x > focus) ?? focus; }
      replace('');
    } else if (usage === 40) replace('\n');
  } });
  const emit = (type, event = {}) => { const e = { preventDefault() { this.prevented = true; }, ...event }; listeners.get(type)?.(e); return e; };
  input.setEnabled(true);
  return { field, input, packets, emit, host: () => value,
    select(start, end = start, direction = 'forward') { field.setSelectionRange(start, end, direction); documentListeners.get('selectionchange')?.(); },
    change(text, start = text.length, end = start, event = {}) { field.value = text; field.setSelectionRange(start, end); emit('input', event); },
    append(text) { const a = field.selectionStart, b = field.selectionEnd;
      this.change(field.value.slice(0, a) + text + field.value.slice(b), a + text.length); },
    key(code, key = code, extra = {}) { emit('keydown', {code, key, ...extra}); emit('keyup', {code, key, ...extra}); },
  };
}

test('retained typing preview sends only new text; paste and both deletion paths stay in sync', () => {
  const e = editor(); for (const c of 'hello') e.append(c);
  assert.equal(e.field.value, 'hello'); assert.equal(e.host(), 'host:hello');
  assert.deepEqual(e.packets.filter(p => p[0] === 9).map(p => p.subarray(3).toString()), [...'hello']);
  e.emit('beforeinput', { inputType: 'deleteContentBackward' });
  assert.equal(e.field.value, 'hell'); assert.equal(e.host(), 'host:hell');
  e.key('Backspace'); assert.equal(e.field.value, 'hel'); assert.equal(e.host(), 'host:hel');
  e.append(' café 😊'); assert.equal(e.field.value, 'hel café 😊'); assert.equal(e.host(), 'host:hel café 😊');
  e.key('ArrowLeft'); e.key('Delete');
  assert.equal(e.field.value, 'hel café '); assert.equal(e.host(), 'host:hel café ');
  e.emit('beforeinput', { inputType: 'insertLineBreak' }); e.append('next');
  assert.equal(e.field.value, 'hel café \nnext'); assert.equal(e.host(), 'host:hel café \nnext');
  e.key('Enter'); assert.equal(e.host(), 'host:' + e.field.value);
});

test('preview selection edits, same-text replacements and autocorrection never resend earlier text', () => {
  const e = editor(); e.append('helo world'); e.select(0,4); e.change('hello world',5);
  assert.equal(e.host(), 'host:hello world'); assert.equal(e.field.value, 'hello world');
  e.select(6,11,'backward'); e.append('Mac'); assert.equal(e.host(), 'host:hello Mac');
  e.select(0,5); e.change('hello Mac',5); // Same value, browser selection collapsed.
  e.append('!'); assert.equal(e.host(), 'host:hello! Mac');
  e.select(6); e.key('ArrowLeft', 'ArrowLeft', {shiftKey:true}); e.append('?');
  assert.equal(e.host(), 'host:hello? Mac');
});

test('retained IME commits and uncancelable mobile edits are applied exactly once', () => {
  const e = editor(); e.append('a'); e.emit('compositionstart');
  e.change('aに',2,2,{isComposing:true}); assert.equal(e.host(),'host:a');
  e.field.value='a日本'; e.field.setSelectionRange(3,3); e.emit('compositionend',{data:'日本'});
  e.change('a日本',3,3,{inputType:'insertFromComposition'});
  assert.equal(e.field.value,'a日本'); assert.equal(e.host(),'host:a日本');
  assert.equal(e.emit('beforeinput',{inputType:'deleteContentBackward',cancelable:false}).prevented,undefined);
  e.change('a日'); assert.equal(e.host(),'host:a日');
  e.append('👨‍👩‍👧‍👦'); e.emit('beforeinput',{inputType:'deleteContentBackward'});
  assert.equal(e.field.value,'a日'); assert.equal(e.host(),'host:a日');
});

test('long typing retains a bounded recent preview without truncating host text; closing clears locally only', () => {
  const e=editor(); let expected='';
  for(let i=0;i<1200;i++){const c=i%2?'é':'😊'; expected+=c; e.append(c);}
  assert.equal(e.host(),'host:'+expected); assert.ok(e.field.value.length<=384);
  assert.ok(expected.endsWith(e.field.value));
  const host=e.host(); e.input.setEnabled(false); assert.equal(e.field.value,''); assert.equal(e.host(),host);
});

test('suggestion commit after transient IME focus loss replaces the existing word once', () => {
  const e=editor(); e.append('hel');
  e.emit('blur'); e.input.release(); // Both field and window focus can change during native IME UI.
  e.field.focus();
  e.emit('compositionstart');
  e.change('hello',5,5,{isComposing:true});
  e.emit('compositionend',{data:'hello'});
  e.change('hello',5,5,{inputType:'insertReplacementText'});
  assert.equal(e.field.value,'hello'); assert.equal(e.host(),'host:hello');
  assert.equal(e.host().includes('helhello'),false);
});


test('leaving the typing context clears its preview and a transient blur releases held keys', () => {
  const e=editor(); e.append('local');
  e.emit('keydown',{code:'ShiftLeft',key:'Shift',shiftKey:true});
  e.emit('blur'); assert.deepEqual([...e.packets.at(-1)],[8,2,0,0,0]);
  assert.equal(e.field.value,'local');
  e.input.setEnabled(false); assert.equal(e.field.value,''); assert.equal(e.host(),'host:local');
});


test('Gboard-style composing word replacement uses balanced deletes without synthetic Shift selection', () => {
  const e=editor(); for(const c of 'germ') e.append(c);
  e.input.release(); e.field.focus(); e.emit('compositionstart');
  e.change('German',6,6,{isComposing:true}); e.emit('compositionend',{data:'German'});
  e.change('German',6,6,{inputType:'insertReplacementText'});
  assert.equal(e.host(),'host:German'); assert.equal(e.field.value,'German');
  assert.equal(e.packets.some(p=>p[0]===8&&(p[4]&2)),false);
  const deletes=e.packets.filter(p=>p[0]===8&&p.readUInt16BE(2)===42);
  assert.deepEqual(deletes.map(p=>p[1]),[0,1,0,1,0,1,0,1]);
});
