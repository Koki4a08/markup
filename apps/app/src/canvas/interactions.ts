import type { MarkupDoc, MarkupNode, Styles } from '@markup/doc';
import { parsePxValue, type Rect } from './geometry';
import type { Point } from './viewport';

const contains = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;

export interface HitOptions {
  /** deep (⌘-click) returns the leaf; shallow returns the artboard's direct child. */
  deep: boolean;
  rectOf: (id: string) => Rect | null;
}

/** Top-most visible, unlocked node under a world point. Later siblings paint on top. */
export function hitTest(doc: MarkupDoc, rootId: string, point: Point, opts: HitOptions): string | null {
  const selectable = (id: string) => {
    const n = doc.getNode(id);
    return !!n && !n.hidden && !n.locked;
  };

  const topmostChild = (parentId: string): string | null => {
    const children = doc.requireNode(parentId).children;
    for (let i = children.length - 1; i >= 0; i--) {
      const id = children[i]!;
      if (!selectable(id)) continue;
      const r = opts.rectOf(id);
      if (r && contains(r, point)) return id;
    }
    return null;
  };

  const artboard = topmostChild(rootId);
  if (!artboard) return null;
  let current = artboard;
  for (let depth = 0; ; depth++) {
    const child = doc.requireNode(current).type === 'frame' ? topmostChild(current) : null;
    if (!child) return current;
    if (!opts.deep && depth === 0) return child;
    current = child;
  }
}

/** Index a dragged flex child should take among its siblings, from the pointer position on the parent's main axis. */
export function flexDropIndex(siblingRects: Rect[], pointer: Point, axis: 'row' | 'column'): number {
  for (let i = 0; i < siblingRects.length; i++) {
    const r = siblingRects[i]!;
    const mid = axis === 'row' ? r.x + r.width / 2 : r.y + r.height / 2;
    if ((axis === 'row' ? pointer.x : pointer.y) < mid) return i;
  }
  return siblingRects.length;
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** New rect after dragging a resize handle by (dx, dy) in world units; never smaller than 1px. */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number): Rect {
  let { x, y, width, height } = r;
  if (handle.includes('e')) width = r.width + dx;
  if (handle.includes('s')) height = r.height + dy;
  if (handle.includes('w')) {
    width = r.width - dx;
    x = r.x + dx;
  }
  if (handle.includes('n')) {
    height = r.height - dy;
    y = r.y + dy;
  }
  if (width < 1) {
    if (handle.includes('w')) x = r.x + r.width - 1;
    width = 1;
  }
  if (height < 1) {
    if (handle.includes('n')) y = r.y + r.height - 1;
    height = 1;
  }
  return { x, y, width, height };
}


/**
 * Styles that move a node freely by delta inside a non-flex parent (or the page root).
 * A static child is lifted to absolute at its measured position, and a static parent frame
 * becomes its containing block so left/top are relative to it.
 */
export function freeformMove(node: MarkupNode, parent: MarkupNode, nodeRect: Rect, parentRect: Rect | null, delta: Point): { node: Styles; parent?: Styles } {
  const round = Math.round;
  const parentFix = parent.type !== 'root' && parent.styles.position === undefined ? { parent: { position: 'relative' } as Styles } : {};
  if (parent.type === 'root' || node.styles.position === 'absolute') {
    return { node: { left: round(parsePxValue(node.styles.left) + delta.x), top: round(parsePxValue(node.styles.top) + delta.y) }, ...(parent.type === 'root' ? {} : parentFix) };
  }
  const origin = parentRect ?? { x: 0, y: 0 };
  return { node: { position: 'absolute', left: round(nodeRect.x - origin.x + delta.x), top: round(nodeRect.y - origin.y + delta.y) }, ...parentFix };
}
