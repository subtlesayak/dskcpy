// Local framing only. Does not inspect Mac fields, read text, move the phone's
// keyboard or send remote input. The target is the last accepted desktop tap.
export function createTypingView(view) {
  let geometry, target, saved, pendingRestore, active = false, zoom = true;
  function capture() {
    if (!geometry) return null;
    const state = view.state();
    return { scale: state.scale, x: state.x / geometry.contentWidth, y: state.y / geometry.contentHeight };
  }
  function restore(snapshot) {
    if (!geometry || !snapshot) return;
    view.zoomBy(snapshot.scale / view.state().scale);
    const state = view.state();
    view.panBy(snapshot.x * geometry.contentWidth - state.x, snapshot.y * geometry.contentHeight - state.y);
  }
  function focus() {
    if (!geometry || !active) return;
    if (!zoom || !target) { restore(saved); return; }
    const scale = Math.max(saved?.scale || 1, Math.min(10, Math.max(2.5, .85 * target.width / geometry.contentWidth)));
    view.frameAt(target.x, target.y, scale);
  }
  return {
    begin() { if (!active) { saved = capture(); pendingRestore = null; active = true; } },
    end() { if (active) { pendingRestore = saved; saved = null; active = false; } },
    reset({ restoreView = true } = {}) {
      if (active) pendingRestore = saved;
      if (!restoreView) pendingRestore = null;
      active = false; saved = null; target = null;
    },
    remember(point) {
      if (!point || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(point[key]))
          || point.width <= 0 || point.height <= 0 || point.x < 0 || point.y < 0 || point.x > point.width || point.y > point.height) return;
      target = { x: point.x / point.width, y: point.y / point.height, width: point.width };
    },
    hasTarget: () => Boolean(target),
    zoomEnabled: () => zoom,
    setZoom(value) { zoom = value === true; focus(); },
    layout(next) {
      if (!next || !['width', 'height', 'contentWidth', 'contentHeight'].every(key => Number.isFinite(next[key]) && next[key] > 0)) { geometry = null; return; }
      geometry = next;
      if (active && !saved) saved = capture();
      if (pendingRestore) { const snapshot = pendingRestore; pendingRestore = null; restore(snapshot); }
      else focus();
    },
  };
}
