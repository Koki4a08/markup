import type { StyleValue } from '@markup/doc';
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

/** World-space rect of a rendered node, measured from the DOM so flex layout is honoured. */
export function measureNode(canvas: HTMLElement, id: string, viewport: Viewport): Rect | null {
  const el = canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
  if (!el) return null;
  const box = el.getBoundingClientRect();
  const origin = canvas.getBoundingClientRect();
  const tl = screenToWorld(viewport, { x: box.left - origin.left, y: box.top - origin.top });
  return { x: tl.x, y: tl.y, width: box.width / viewport.zoom, height: box.height / viewport.zoom };
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: bottom - y };
}
