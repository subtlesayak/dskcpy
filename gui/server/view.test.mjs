import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopView } from '../receiver/view.mjs';
const geometry = { width: 400, height: 300, contentWidth: 400, contentHeight: 225 };
function fixture() { const view = createDesktopView(); view.setGeometry(geometry); return view; }
test('local zoom preserves its anchor and clamps pan without revealing new gutters', () => {
  const v = fixture(); v.zoomBy(2, 100, 150);
  assert.deepEqual(v.state(), { scale: 2, x: 100, y: 0 });
  v.panBy(1e6, -1e6); assert.deepEqual(v.state(), { scale: 2, x: 200, y: -75 });
  v.zoomBy(1e6); assert.equal(v.state().scale, 4);
  v.zoomBy(1e-6); assert.deepEqual(v.state(), { scale: 1, x: 0, y: 0 });
});
test('two contacts pinch around their moving center, then rebase when one lifts', () => {
  const v = fixture(); v.down(1, 100, 150); v.down(2, 300, 150);
  v.move(2, 400, 150); assert.deepEqual(v.state(), { scale: 1.5, x: 50, y: 0 });
  v.up(2); v.move(1, 90, 140); assert.deepEqual(v.state(), { scale: 1.5, x: 40, y: -10 });
  v.up(1); v.move(1, 10, 10); assert.equal(v.state().x, 40);
});
test('geometry changes keep the normalized center and discard old contacts', () => {
  const v = fixture(); v.zoomBy(3); v.panBy(60, 30); v.down(1, 100, 100);
  v.setGeometry({ width: 800, height: 600, contentWidth: 800, contentHeight: 450 });
  assert.deepEqual(v.state(), { scale: 3, x: 120, y: 60 });
  v.move(1, 200, 200); assert.equal(v.state().x, 120);
  v.cancel(); v.reset(); assert.deepEqual(v.state(), { scale: 1, x: 0, y: 0 });
});
test('invalid geometry, deltas and excessive or cancelled contacts do not move the view', () => {
  const v = fixture(); v.zoomBy(NaN); v.zoomBy(-1); v.panBy(Infinity, 0);
  assert.deepEqual(v.state(), { scale: 1, x: 0, y: 0 });
  v.zoomBy(2); v.down(1, 100, 100); v.down(2, 200, 100); v.down(3, 300, 100);
  const state = v.state(); v.move(1, 0, 0); assert.deepEqual(v.state(), state);
  v.setGeometry({ ...geometry, width: 0 }); v.panBy(100, 100); v.zoomBy(2); assert.deepEqual(v.state(), state);
});
