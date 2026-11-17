import { focusGeometry } from './protocol.mjs';
// Local framing only. A capable host may supply a bounded field/caret rectangle;
// older/unsupported hosts retain last-tap framing. No text or input is sent here.
export function createTypingView(view) {
  let geometry, target, precise, ignoredGeometry, saved, pendingRestore, active = false, zoom = true;
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
    if (!zoom || (!target && !precise)) { restore(saved); return; }
    let point = target;
    if (precise) {
      const rect = precise.rect, x = rect.x / 65535, y = rect.y / 65535;
      const width = rect.width / 65535, height = rect.height / 65535;
      const tapInside = rect.kind === 'field' && target && target.x >= x && target.x <= x + width && target.y >= y && target.y <= y + height;
      point = tapInside ? target : { x: x + width / 2, y: y + height / 2, width: precise.sourceWidth };
    }
    let desired = .85 * point.width / geometry.contentWidth;
    if (precise?.rect.kind === 'caret') desired = 22 / (precise.rect.height / 65535 * geometry.contentHeight);
    const scale = Math.max(saved?.scale || 1, Math.min(10, Math.max(2.5, desired)));
    view.frameAt(point.x, point.y, scale);
  }
  return {
    begin() { if (!active) { saved = capture(); pendingRestore = null; active = true; } },
    end() { if (active) { pendingRestore = saved; saved = null; active = false; } },
    reset({ restoreView = true } = {}) {
      if (active) pendingRestore = saved;
      if (!restoreView) pendingRestore = null;
      active = false; saved = null; target = null; precise = null; ignoredGeometry = null;
    },
    remember(point) {
      if (!point || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(point[key]))
          || point.width <= 0 || point.height <= 0 || point.x < 0 || point.y < 0 || point.x > point.width || point.y > point.height) return;
      target = { x: point.x / point.width, y: point.y / point.height, width: point.width };
      // A new accepted tap supersedes a queued hint for the prior field. Keep
      // its fallback point until the host supplies a changed target.
      ignoredGeometry = precise ? JSON.stringify(precise.rect) : ignoredGeometry; precise = null;
    },
    setFocusGeometry(value, sourceWidth) {
      const rect = value === null ? null : focusGeometry(value);
      if (value !== null && (!rect || !Number.isFinite(sourceWidth) || sourceWidth <= 0)) return false;
      if (value === null) { const changed = Boolean(precise); precise = null; ignoredGeometry = null; return changed; }
      if (rect && JSON.stringify(rect) === ignoredGeometry) return false;
      if (JSON.stringify(precise) === JSON.stringify(rect ? { rect, sourceWidth } : null)) return false;
      precise = rect ? { rect, sourceWidth } : null; ignoredGeometry = null;
      return true;
    },
    hasTarget: () => Boolean(target || precise),
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
