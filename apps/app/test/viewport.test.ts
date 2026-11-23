import { describe, expect, it, vi } from 'vitest';
import { TickStore, ValueStore } from '../src/canvas/store';
import { blendViewport, MAX_ZOOM, MIN_ZOOM, screenToWorld, worldToScreen, zoomAt } from '../src/canvas/viewport';

describe('viewport', () => {
  const v = { x: 100, y: 50, zoom: 2 };

  it('screenToWorld inverts worldToScreen', () => {
    const p = { x: 37, y: -12 };
    expect(screenToWorld(v, worldToScreen(v, p))).toEqual(p);
    expect(worldToScreen(v, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
  });

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const cursor = { x: 400, y: 300 };
    const before = screenToWorld(v, cursor);
    const next = zoomAt(v, cursor, 1.5);
    expect(next.zoom).toBe(3);
    const after = screenToWorld(next, cursor);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('zoom clamps', () => {
    expect(zoomAt(v, { x: 0, y: 0 }, 1e9).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(v, { x: 0, y: 0 }, 1e-9).zoom).toBe(MIN_ZOOM);
    expect(MIN_ZOOM).toBe(0.02);
    expect(MAX_ZOOM).toBe(256);
  });
});

describe('canvas stores', () => {
  it('ValueStore notifies on change only, and applies updaters to the latest value', () => {
    const store = new ValueStore({ x: 0, y: 0, zoom: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set((v) => ({ ...v, x: v.x + 5 }));
    store.set((v) => ({ ...v, x: v.x + 5 }));
    expect(store.get().x).toBe(10);
    expect(listener).toHaveBeenCalledTimes(2);
    store.set(store.get());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('TickStore coalesces bumps to one per animation frame; bumpNow flushes at once', () => {
    let pending: FrameRequestCallback | null = null;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => ((pending = cb), 1));
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => (pending = null));
    try {
      const ticks = new TickStore();
      const listener = vi.fn();
      ticks.subscribe(listener);
      ticks.bump();
      ticks.bump();
      ticks.bump();
      expect(raf).toHaveBeenCalledTimes(1);
      expect(listener).not.toHaveBeenCalled();
      (pending as FrameRequestCallback | null)?.(0);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(ticks.get()).toBe(1);
      ticks.bump();
      ticks.bumpNow();
      expect(caf).toHaveBeenCalled();
      expect(listener).toHaveBeenCalledTimes(2);
      expect(ticks.get()).toBe(2);
    } finally {
      raf.mockRestore();
      caf.mockRestore();
    }
  });
});

describe('blendViewport', () => {
  const from = { x: 10, y: 20, zoom: 0.5 };
  const to = { x: -300, y: 140, zoom: 2 };
  const mid = { x: 400, y: 300 };

  it('starts at the first view and ends exactly at the second', () => {
    expect(blendViewport(from, to, 0, mid)).toBe(from);
    expect(blendViewport(from, to, 1, mid)).toBe(to);
  });

  it('changes zoom by equal ratios and moves the centred world point in a straight line', () => {
    const half = blendViewport(from, to, 0.5, mid);
    expect(half.zoom).toBeCloseTo(1);
    const a = screenToWorld(from, mid);
    const b = screenToWorld(to, mid);
    const c = screenToWorld(half, mid);
    expect(c.x).toBeCloseTo((a.x + b.x) / 2);
    expect(c.y).toBeCloseTo((a.y + b.y) / 2);
  });
});
