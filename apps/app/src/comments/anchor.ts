import { measureNode } from '../canvas/geometry';
import type { Point, Viewport } from '../canvas/viewport';

/** World point of a comment anchor: an offset inside its node, or plain world coordinates. Null when the node is gone or not rendered. */
export function anchorWorld(canvas: HTMLElement, a: { nodeId: string | null; x: number; y: number }, viewport: Viewport): Point | null {
  if (a.nodeId === null) return { x: a.x, y: a.y };
  const r = measureNode(canvas, a.nodeId, viewport);
  return r && { x: r.x + a.x, y: r.y + a.y };
}
