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
