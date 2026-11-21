export interface Point {
  x: number;
  y: number;
}

/** Screen = world * zoom + (x, y). */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 256;

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** The levels Ctrl/⌘ + and − step through. */
export const ZOOM_STEPS = [0.02, 0.05, 0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128, 256];

/** The next zoom level above (direction 1) or below (-1) the current zoom. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next = direction > 0 ? ZOOM_STEPS.find((z) => z > zoom * 1.001) : [...ZOOM_STEPS].reverse().find((z) => z < zoom * 0.999);
  return clampZoom(next ?? zoom);
}

export function screenToWorld(v: Viewport, p: Point): Point {
  return { x: (p.x - v.x) / v.zoom, y: (p.y - v.y) / v.zoom };
}

export function worldToScreen(v: Viewport, p: Point): Point {
  return { x: p.x * v.zoom + v.x, y: p.y * v.zoom + v.y };
}

/** Zooms by factor while keeping the world point under the screen point fixed. */
export function zoomAt(v: Viewport, screen: Point, factor: number): Viewport {
  const zoom = clampZoom(v.zoom * factor);
  const world = screenToWorld(v, screen);
  return { zoom, x: screen.x - world.x * zoom, y: screen.y - world.y * zoom };
}

/** Viewport that fits a world rect into a screen of the given size with padding. */
export function fitRect(rect: { x: number; y: number; width: number; height: number }, screen: { width: number; height: number }, padding = 64): Viewport {
  const zoom = clampZoom(Math.min((screen.width - padding * 2) / Math.max(rect.width, 1), (screen.height - padding * 2) / Math.max(rect.height, 1)));
  return { zoom, x: (screen.width - rect.width * zoom) / 2 - rect.x * zoom, y: (screen.height - rect.height * zoom) / 2 - rect.y * zoom };
}
