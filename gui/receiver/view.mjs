// Local view geometry only. This module cannot emit remote input or alter the
// captured desktop. Coordinates are CSS pixels in the untransformed stage.
export function createDesktopView({ changed = () => {} } = {}) {
  let geometry = null, scale = 1, x = 0, y = 0;
  const points = new Map();
  const clamp = (value, limit) => limit === 0 ? 0 : Math.max(-limit, Math.min(limit, value));
  const state = () => ({ scale, x, y });
  function paint() {
    if (geometry) {
      x = clamp(x, Math.max(0, (geometry.contentWidth * scale - geometry.width) / 2));
      y = clamp(y, Math.max(0, (geometry.contentHeight * scale - geometry.height) / 2));
    }
    changed(state());
  }
  function cancel() { points.clear(); }
  function reset() { cancel(); scale = 1; x = y = 0; paint(); }
  function zoomBy(factor, anchorX = geometry?.width / 2, anchorY = geometry?.height / 2, moveX = 0, moveY = 0) {
    if (!geometry || ![factor, anchorX, anchorY, moveX, moveY].every(Number.isFinite) || factor <= 0) return;
    const next = Math.max(1, Math.min(4, scale * factor));
    const ax = anchorX - geometry.width / 2, ay = anchorY - geometry.height / 2;
    x = ax + moveX - (ax - x) * next / scale;
    y = ay + moveY - (ay - y) * next / scale;
    scale = next; paint();
  }
  function panBy(dx, dy) {
    if (!geometry || ![dx, dy].every(Number.isFinite)) return;
    x += dx; y += dy; paint();
  }
  function sample() {
    const ps = [...points.values()];
    return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
      y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
      distance: ps.length === 2 ? Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) : 0 };
  }
  return {
    state, cancel, reset, zoomBy, panBy,
    // Typing can need stronger magnification than ordinary navigation when a
    // docked phone keyboard leaves only a thin strip. No remote input is sent.
    frameAt(u, v, nextScale) {
      if (!geometry || ![u, v, nextScale].every(Number.isFinite) || u < 0 || u > 1 || v < 0 || v > 1) return;
      cancel(); scale = Math.max(1, Math.min(10, nextScale));
      x = (.5 - u) * geometry.contentWidth * scale;
      y = (.5 - v) * geometry.contentHeight * scale; paint();
    },
    setGeometry(next) {
      cancel();
      if (!next || !['width', 'height', 'contentWidth', 'contentHeight'].every(k => Number.isFinite(next[k]) && next[k] > 0)) {
        geometry = null; return;
      }
      if (geometry) { x *= next.contentWidth / geometry.contentWidth; y *= next.contentHeight / geometry.contentHeight; }
      geometry = { ...next }; paint();
    },
    down(id, px, py) {
      if (!geometry || ![px, py].every(Number.isFinite) || points.has(id)) return;
      if (points.size >= 2) { cancel(); return; }
      points.set(id, { x: px, y: py });
    },
    move(id, px, py) {
      if (!points.has(id) || ![px, py].every(Number.isFinite)) return;
      const old = sample(); points.set(id, { x: px, y: py }); const next = sample();
      if (points.size === 2 && old.distance >= 8 && next.distance >= 8)
        zoomBy(next.distance / old.distance, old.x, old.y, next.x - old.x, next.y - old.y);
      else panBy(next.x - old.x, next.y - old.y);
    },
    up(id) { points.delete(id); },
    hasPointer(id) { return points.has(id); },
  };
}
