import type { StyleValue } from '@markup/doc';
import { nodeElementIn } from './registry';
import { screenToWorld, type Viewport } from './viewport';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** px number from a style value; 0 when missing or not in px. */
export function parsePxValue(value: StyleValue | undefined): number {
  if (typeof value === 'number') return value;
  const m = typeof value === 'string' ? /^(-?\d+(?:\.\d+)?)(px)?$/.exec(value.trim()) : null;
  return m ? Number(m[1]) : 0;
}

/**
 * World-space rect of a rendered node, measured from the DOM so flex layout is honoured. Callers measuring
 * many nodes in one pass can pass the canvas's own client rect as origin so it is read once.
 */
export function measureNode(canvas: HTMLElement, id: string, viewport: Viewport, origin?: DOMRect): Rect | null {
  const el = nodeElementIn(canvas, id);
  return el ? measureElement(el, origin ?? canvas.getBoundingClientRect(), viewport) : null;
}

/** World-space rect of an element on the canvas, given the canvas's client rect. */
export function measureElement(el: Element, origin: DOMRect, viewport: Viewport): Rect {
  const box = el.getBoundingClientRect();
  const tl = screenToWorld(viewport, { x: box.left - origin.left, y: box.top - origin.top });
  return { x: tl.x, y: tl.y, width: box.width / viewport.zoom, height: box.height / viewport.zoom };
}

export const sameRect = (a: Rect | null | undefined, b: Rect | null | undefined): boolean =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

export const sameRects = (a: readonly Rect[], b: readonly Rect[]): boolean => a.length === b.length && a.every((r, i) => sameRect(r, b[i]));

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}
