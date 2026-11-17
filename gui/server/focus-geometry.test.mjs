import test from 'node:test';
import assert from 'node:assert/strict';
import { focusGeometry } from '../receiver/protocol.mjs';
test('focus geometry is a fixed bounded shape without text or identity fields', () => {
  const value = { kind: 'caret', x: 0, y: 65534, width: 1, height: 1 };
  assert.deepEqual(focusGeometry(value), value); assert.notEqual(focusGeometry(value), value);
  for (const invalid of [null, [], {}, { ...value, kind: 'private title' }, { ...value, text: 'private' },
    { ...value, x: -1 }, { ...value, y: NaN }, { ...value, width: 0 }, { ...value, height: 2 },
    { ...value, x: 1.5 }, { ...value, x: Infinity }, { ...value, width: 65536 }]) assert.equal(focusGeometry(invalid), null);
});
