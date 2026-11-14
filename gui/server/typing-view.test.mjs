import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopView } from '../receiver/view.mjs';
import { createTypingView } from '../receiver/typing-view.mjs';
const full = { width: 700, height: 400, contentWidth: 700, contentHeight: 393.75 };
const docked = { width: 700, height: 110, contentWidth: 195.56, contentHeight: 110 };
function fixture() {
  const view = createDesktopView(); const typing = createTypingView(view);
  const layout = geometry => { view.setGeometry(geometry); typing.layout(geometry); };
  layout(full); return { view, typing, layout };
}
test('docked typing keeps near-native text scale at the last tap without overscroll', () => {
  const f = fixture(); f.typing.remember({ x: 1000, y: 540, width: 1600, height: 900 }); f.typing.begin(); f.layout(docked);
  const state = f.view.state(); assert.ok(state.scale > 4 && state.scale <= 10);
  assert.ok(docked.contentWidth / 1600 * state.scale >= .8);
  const x = docked.width / 2 + (.625 - .5) * docked.contentWidth * state.scale + state.x;
  const y = docked.height / 2 + (.6 - .5) * docked.contentHeight * state.scale + state.y;
  assert.ok(x >= 0 && x <= docked.width); assert.ok(Math.abs(y - docked.height / 2) < 1e-9);
  assert.ok(Math.abs(state.x) <= (docked.contentWidth * state.scale - docked.width) / 2);
});
test('closing typing restores the prior zoom and normalized pan after keyboard/orientation changes', () => {
  const f = fixture(); f.view.zoomBy(2); f.view.panBy(70, -30); const before = f.view.state();
  f.typing.remember({ x: 1200, y: 700, width: 1600, height: 900 }); f.typing.begin(); f.layout(docked);
  f.layout({ width: 320, height: 600, contentWidth: 320, contentHeight: 180 });
  f.typing.end(); f.layout(full);
  for (const key of ['scale', 'x', 'y']) assert.ok(Math.abs(f.view.state()[key] - before[key]) < 1e-9);
});
test('no remote tap means no guessed focus zoom, and stale source coordinates are discarded', () => {
  const f = fixture(); f.typing.begin(); f.layout(docked); assert.equal(f.view.state().scale, 1);
  f.typing.remember({ x: 500, y: 200, width: 1600, height: 900 }); f.layout(docked); assert.ok(f.view.state().scale > 4);
  f.typing.reset({ restoreView: false }); f.view.reset(); f.layout(full);
  f.typing.begin(); f.layout(docked); assert.equal(f.typing.hasTarget(), false); assert.equal(f.view.state().scale, 1);
});
test('zoom can be disabled while typing and re-enabled without losing the original view', () => {
  const f = fixture(); f.view.zoomBy(1.5); const before = f.view.state();
  f.typing.remember({ x: 800, y: 400, width: 1600, height: 900 }); f.typing.begin(); f.layout(docked);
  f.typing.setZoom(false); assert.equal(f.view.state().scale, 1.5);
  f.typing.setZoom(true); assert.ok(f.view.state().scale > 4);
  f.typing.end(); f.layout(full); assert.deepEqual(f.view.state(), before);
});
test('invalid geometry and out-of-image taps cannot create non-finite transforms', () => {
  const f = fixture();
  for (const x of [NaN, Infinity, -1, 1601]) f.typing.remember({ x, y: 100, width: 1600, height: 900 });
  assert.equal(f.typing.hasTarget(), false);
  f.typing.begin(); f.typing.layout({ width: 0, height: 0, contentWidth: 0, contentHeight: 0 });
  f.layout(full); assert.deepEqual(f.view.state(), { scale: 1, x: 0, y: 0 });
});
