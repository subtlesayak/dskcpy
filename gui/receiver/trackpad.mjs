// Relative gestures over a fitted video surface. Only local coordinates live
// here; authentication, lifecycle gating and transport belong to the receiver.
export function createRelativeTrackpad({ geometry, emit, changed = () => {}, now = () => performance.now() }) {
  let x = .5, y = .5, dragging = false, gesture = null;
  const points = new Map();
  const bounds = () => {
    const g = geometry();
    return g && ['width', 'height', 'cssWidth', 'cssHeight'].every(k => Number.isFinite(g[k]) && g[k] > 0) ? g : null;
  };
  const position = () => {
    const g = bounds();
    return g ? { x: x * (g.width - 1), y: y * (g.height - 1), width: g.width, height: g.height } : null;
  };
  const output = (type, extra = {}) => { const p = position(); return p ? emit({ type, ...p, ...extra }) !== false : false; };
  function release() {
    if (dragging) output('cancel');
    dragging = false; points.clear(); gesture = null; changed();
  }
  function move(dx, dy) {
    const g = bounds();
    if (!g || ![dx, dy].every(Number.isFinite)) return;
    x = Math.max(0, Math.min(1, x + dx / g.cssWidth));
    y = Math.max(0, Math.min(1, y + dy / g.cssHeight));
    output(dragging ? 'move' : 'hover'); changed();
  }
  function click() {
    if (dragging || points.size || !bounds()) return;
    if (output('down')) output('up');
  }
  const center = () => {
    const ps = [...points.values()];
    return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
  };
  return {
    position, move, click, release,
    hasPointer(id) { return points.has(id); },
    reset() { release(); x = y = .5; changed(); },
    get dragging() { return dragging; },
    toggleDrag() {
      if (dragging) { release(); return; }
      if (points.size || !bounds()) return;
      dragging = output('down'); changed();
    },
    down({ pointerId, clientX, clientY }) {
      if (!bounds() || ![clientX, clientY].every(Number.isFinite) || points.has(pointerId)) return;
      if (points.size >= 2) { release(); return; }
      points.set(pointerId, { x: clientX, y: clientY });
      if (points.size === 1) gesture = { x: clientX, y: clientY, at: now(), moved: false, multiple: false, wasDragging: dragging };
      else {
        // Two fingers always scroll. End a held drag before scrolling, and do
        // not click or resume movement when the first finger lifts.
        if (dragging) output('cancel');
        dragging = false; gesture.multiple = true; gesture.last = center(); changed();
      }
    },
    pointerMove({ pointerId, clientX, clientY }) {
      const previous = points.get(pointerId);
      if (!previous || !gesture || ![clientX, clientY].every(Number.isFinite)) return;
      points.set(pointerId, { x: clientX, y: clientY });
      if (gesture.multiple) {
        if (points.size !== 2) return;
        const c = center();
        output('scroll', { dx: gesture.last.x - c.x, dy: gesture.last.y - c.y });
        gesture.last = c; return;
      }
      if (Math.hypot(clientX - gesture.x, clientY - gesture.y) >= 8) gesture.moved = true;
      move(clientX - previous.x, clientY - previous.y);
    },
    up({ pointerId }) {
      if (!points.has(pointerId)) return;
      points.delete(pointerId);
      if (points.size) return;
      const tap = gesture && !gesture.multiple && !gesture.moved && !gesture.wasDragging && now() - gesture.at <= 500;
      gesture = null;
      if (tap) click();
    },
    scroll(dx, dy) {
      if (![dx, dy].every(Number.isFinite)) return;
      if (dragging) release();
      output('scroll', { dx, dy });
    },
  };
}
