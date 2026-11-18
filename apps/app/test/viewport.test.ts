import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, screenToWorld, worldToScreen, zoomAt } from '../src/canvas/viewport';

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
