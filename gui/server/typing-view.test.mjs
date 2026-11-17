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
test('closing and reopening typing before the queued fit retains the original view', () => {
  const f=fixture();f.view.zoomBy(2);f.view.panBy(70,-30);const before=f.view.state();
  f.typing.remember({x:1200,y:700,width:1600,height:900});f.typing.begin();f.layout(docked);
  f.typing.end();f.typing.begin();f.layout(docked);
  f.typing.end();f.layout(full);
  for(const key of ['scale','x','y'])assert.ok(Math.abs(f.view.state()[key]-before[key])<1e-9, key);
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

const caret = { kind: 'caret', x: 40000, y: 39000, width: 30, height: 1400 };
test('a validated caret frames readable typing without a prior desktop tap', () => {
  const f = fixture(); f.typing.begin(); f.layout(docked);
  assert.equal(f.typing.setFocusGeometry(caret, 1600), true); f.layout(docked);
  const state = f.view.state(), x = (caret.x + caret.width / 2) / 65535, y = (caret.y + caret.height / 2) / 65535;
  assert.ok(state.scale > 4 && state.scale <= 10);
  assert.ok(caret.height / 65535 * docked.contentHeight * state.scale >= 18);
  assert.ok(Math.abs(docked.height / 2 + (y - .5) * docked.contentHeight * state.scale + state.y - docked.height / 2) < 1e-8);
  assert.ok(docked.width / 2 + (x - .5) * docked.contentWidth * state.scale + state.x >= 0);
});
test('an accepted tap supersedes queued old-field geometry; absent geometry clears that exclusion', () => {
  const f = fixture(); f.typing.setFocusGeometry(caret, 1600); f.typing.begin(); f.layout(docked);
  f.typing.remember({ x: 300, y: 250, width: 1600, height: 900 });
  assert.equal(f.typing.setFocusGeometry(caret, 1600), false);
  f.typing.remember({ x: 320, y: 260, width: 1600, height: 900 });
  assert.equal(f.typing.setFocusGeometry(caret, 1600), false);
  f.typing.setFocusGeometry(null, 1600);
  assert.equal(f.typing.setFocusGeometry(caret, 1600), true);
});
test('field fallback preserves a tap inside the field and typing close restores the saved view', () => {
  const f = fixture(); f.view.zoomBy(1.5); f.view.panBy(40, -10); const before = f.view.state();
  f.typing.remember({ x: 800, y: 450, width: 1600, height: 900 }); f.typing.begin();
  assert.equal(f.typing.setFocusGeometry({ kind: 'field', x: 20000, y: 20000, width: 20000, height: 20000 }, 1600), true);
  f.layout(docked); assert.ok(f.view.state().scale > 4);
  f.typing.end(); f.typing.setFocusGeometry(null, 1600); f.layout(full);
  assert.deepEqual(f.view.state(), before);
  f.typing.reset({ restoreView: false }); assert.equal(f.typing.hasTarget(), false);
});
