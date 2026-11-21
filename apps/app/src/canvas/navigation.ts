import { zoomAt, type Viewport } from './viewport';

/**
 * Canvas navigation for every pointing device:
 * - mouse wheel pans (Shift for sideways); Ctrl/⌘ + wheel zooms at the cursor in even steps;
 * - trackpad two-finger scroll pans in both axes; pinch zooms smoothly at the fingers (Chrome and WebView2
 *   report a pinch as Ctrl + wheel with small deltas; Safari and macOS WKWebView send gesture events);
 * - touchscreen: one finger uses the current tool, two fingers pan and pinch-zoom together.
 */

export interface NavigationTarget {
  update(fn: (v: Viewport) => Viewport): void;
  /** Called on every navigation event (the canvas promotes its world layer while it moves). */
  moving(): void;
}

/** Pixels per line / page for wheel events that report deltaMode lines or pages (Firefox, some mice). */
const LINE = 16;

/** Wheel delta in CSS pixels, whatever unit the device reports. */
export function wheelDelta(e: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>, pageHeight: number): { x: number; y: number } {
  const unit = e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? pageHeight : 1;
  return { x: e.deltaX * unit, y: e.deltaY * unit };
}

/**
 * Zoom factor for a Ctrl/⌘ wheel event. Pinches arrive as many small fractional deltas and map
 * continuously; a mouse wheel notch (about 100px) is capped to one comfortable step instead of a jump.
 */
export function zoomFactor(deltaY: number): number {
  const factor = Math.exp(-deltaY * 0.01);
  return Math.min(1.25, Math.max(0.8, factor));
}

interface Touch {
  x: number;
  y: number;
}

/** Wires navigation onto the canvas element; returns a function that removes it. */
export function attachNavigation(el: HTMLElement, target: NavigationTarget): () => void {
  const local = (clientX: number, clientY: number) => {
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const onWheel = (e: WheelEvent) => {
    // A popover over the canvas (a comment thread) scrolls itself under the pointer, as in any native app.
    // Zoom chords still go to the canvas.
    if (!e.ctrlKey && !e.metaKey && (e.target as Element | null)?.closest?.('.comment-popover, [data-own-wheel]')) return;
    // Always ours: otherwise the page zooms, or a sideways swipe navigates back.
    e.preventDefault();
    target.moving();
    const d = wheelDelta(e, el.clientHeight);
    if (e.ctrlKey || e.metaKey) {
      const at = local(e.clientX, e.clientY);
      target.update((v) => zoomAt(v, at, zoomFactor(d.y)));
      return;
    }
    // A plain mouse wheel has no horizontal axis: Shift turns it sideways.
    const dx = e.shiftKey && d.x === 0 ? d.y : d.x;
    const dy = e.shiftKey && d.x === 0 ? 0 : d.y;
    target.update((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
  };

  // Safari / WKWebView pinch: scale is cumulative from the gesture start.
  let gestureScale = 1;
  const onGestureStart = (e: Event) => {
    e.preventDefault();
    gestureScale = 1;
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    const g = e as Event & { scale: number; clientX: number; clientY: number };
    if (!g.scale) return;
    const factor = g.scale / gestureScale;
    gestureScale = g.scale;
    target.moving();
    const at = local(g.clientX, g.clientY);
    target.update((v) => zoomAt(v, at, factor));
  };

  // Touchscreen: two fingers navigate. A first finger waits a moment so a second one can turn the touch
  // into a pan/pinch before any tool acts; without one it is replayed to the tool unchanged.
  const touches = new Map<number, Touch>();
  let pinch: { mid: Touch; dist: number } | null = null;
  let pending: { event: PointerEvent; timer: number } | null = null;
  const replayed = new WeakSet<Event>();

  const replay = () => {
    if (!pending) return;
    const { event } = pending;
    clearTimeout(pending.timer);
    pending = null;
    const copy = new PointerEvent('pointerdown', event);
    replayed.add(copy);
    event.target?.dispatchEvent(copy);
  };

  const midpoint = (): { mid: Touch; dist: number } => {
    const [a, b] = [...touches.values()] as [Touch, Touch];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || replayed.has(e)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) {
      e.stopPropagation();
      pending = { event: e, timer: window.setTimeout(replay, 90) };
      return;
    }
    e.stopPropagation();
    if (pending) {
      clearTimeout(pending.timer);
      pending = null;
    }
    if (touches.size === 2) pinch = midpoint();
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    const start = touches.get(e.pointerId)!;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pending && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) replay();
    if (!pinch || touches.size < 2) return;
    e.stopPropagation();
    const now = midpoint();
    const from = pinch;
    pinch = now;
    target.moving();
    const at = local(now.mid.x, now.mid.y);
    target.update((v) => {
      const panned = { ...v, x: v.x + now.mid.x - from.mid.x, y: v.y + now.mid.y - from.mid.y };
      return zoomAt(panned, at, now.dist / from.dist);
    });
  };

  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    // A quick tap with one finger still reaches the tool.
    if (pending && touches.size === 0) replay();
    if (touches.size < 2) pinch = null;
  };

  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('gesturestart', onGestureStart);
  el.addEventListener('gesturechange', onGestureChange);
  el.addEventListener('gestureend', onGestureStart);
  el.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  return () => {
    if (pending) clearTimeout(pending.timer);
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('gesturestart', onGestureStart);
    el.removeEventListener('gesturechange', onGestureChange);
    el.removeEventListener('gestureend', onGestureStart);
    el.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
  };
}

/**
 * Outside the canvas, a pinch or Ctrl/⌘ + wheel would zoom the whole app (the browser's page zoom, also in
 * WebView2) and a sideways swipe would navigate back. Panels scroll normally; those two are swallowed.
 */
export function preventAppZoom(win: Window = window): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };
  const onGesture = (e: Event) => e.preventDefault();
  // Ctrl/⌘ + − = 0 zoom the canvas (see keyboard.ts), never the app, even while a field has focus.
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (/^[-_+=0]$/.test(e.key) || /^(Numpad(Add|Subtract|0))$/.test(e.code))) e.preventDefault();
  };
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('wheel', onWheel, { passive: false });
  win.addEventListener('gesturestart', onGesture);
  win.addEventListener('gesturechange', onGesture);
  return () => {
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('wheel', onWheel);
    win.removeEventListener('gesturestart', onGesture);
    win.removeEventListener('gesturechange', onGesture);
  };
}
