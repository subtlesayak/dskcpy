import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelativeTrackpad } from '../receiver/trackpad.mjs';
function fixture() {
  const packets = []; let time = 0;
  const geometry = { width: 1920, height: 1080, cssWidth: 400, cssHeight: 225 };
  const pad = createRelativeTrackpad({ geometry: () => geometry, emit: p => packets.push(p), now: () => time });
  const event = (pointerId, clientX, clientY) => ({ pointerId, clientX, clientY });
  return { pad, packets, geometry, event, time: n => time = n };
}
test('relative movement follows displacement, not contact position, across clutching and geometry changes', () => {
  const { pad, packets, geometry, event } = fixture();
  pad.down(event(1, 10, 20)); pad.pointerMove(event(1, 50, 20)); pad.up(event(1));
  assert.equal(pad.position().x, 1919 * .6); assert.equal(packets.at(-1).type, 'hover');
  pad.down(event(2, 300, 200)); pad.pointerMove(event(2, 340, 200)); pad.up(event(2));
  assert.ok(Math.abs(pad.position().x - 1919 * .7) < .001);
  geometry.width = 1280; geometry.height = 720; geometry.cssWidth = 800;
  pad.move(80, 0); assert.ok(Math.abs(pad.position().x - 1279 * .8) < .001);
  pad.move(1e9, -1e9); assert.equal(pad.position().x, 1279); assert.equal(pad.position().y, 0);
  assert.ok(packets.every(p => p.type === 'hover'));
});
test('short tap clicks once; long holds, movement and cancelled contacts never click', () => {
  const { pad, packets, event, time } = fixture();
  pad.down(event(1, 40, 40)); pad.up(event(1)); assert.deepEqual(packets.map(p => p.type), ['down', 'up']);
  packets.length = 0; pad.down(event(1, 40, 40)); time(600); pad.up(event(1)); assert.equal(packets.length, 0);
  pad.down(event(1, 40, 40)); pad.pointerMove(event(1, 70, 40)); pad.up(event(1)); assert.deepEqual(packets.map(p => p.type), ['hover']);
  packets.length = 0; pad.down(event(1, 40, 40)); pad.release(); pad.up(event(1)); assert.equal(packets.length, 0);
});
test('explicit drag survives clutching but releases on cancellation and two-finger scroll', () => {
  const { pad, packets, event } = fixture();
  pad.toggleDrag(); pad.down(event(1, 20, 20)); pad.pointerMove(event(1, 60, 20)); pad.up(event(1));
  assert.equal(pad.dragging, true); assert.deepEqual(packets.map(p => p.type), ['down', 'move']);
  pad.toggleDrag(); assert.equal(packets.at(-1).type, 'cancel'); assert.equal(pad.dragging, false);
  pad.toggleDrag(); pad.down(event(1, 20, 20)); pad.down(event(2, 40, 20));
  assert.equal(packets.at(-1).type, 'cancel'); assert.equal(pad.dragging, false);
  pad.pointerMove(event(2, 40, 0)); assert.equal(packets.at(-1).type, 'scroll'); assert.equal(packets.at(-1).dy, 10);
  pad.up(event(2)); const n = packets.length; pad.pointerMove(event(1, 30, 30)); pad.up(event(1)); assert.equal(packets.length, n);
});
test('invalid geometry, stale pointers, excessive contacts and non-finite deltas stay inert', () => {
  const { pad, packets, geometry, event } = fixture();
  pad.pointerMove(event(8, 1, 1)); pad.up(event(8)); pad.move(NaN, 1); pad.scroll(0, Infinity); assert.equal(packets.length, 0);
  geometry.cssWidth = 0; pad.toggleDrag(); pad.click(); pad.down(event(1, 1, 1)); assert.equal(packets.length, 0);
  geometry.cssWidth = 400; pad.toggleDrag(); pad.down(event(1, 1, 1)); pad.down(event(2, 2, 2)); pad.down(event(3, 3, 3));
  assert.equal(pad.dragging, false); assert.equal(pad.hasPointer(1), false); assert.equal(pad.hasPointer(3), false);
  pad.reset(); assert.equal(pad.position().x, 1919 / 2);
});
