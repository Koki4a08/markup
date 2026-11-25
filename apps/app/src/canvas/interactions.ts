import type { MarkupDoc, MarkupNode, Styles } from '@markup/doc';
import type * as Y from 'yjs';
import { parsePxValue, type Rect } from './geometry';
import type { Point } from './viewport';

const contains = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height;

/**
 * Cheap reads of one node's fields straight from its Y.Map, for hot loops (hit testing every pointer frame)
 * that would otherwise take a full snapshot (styles, children, src/svg copies) just to check a flag.
 */
export function nodeFlags(doc: MarkupDoc, id: string): { type: MarkupNode['type']; hidden: boolean; locked: boolean } | null {
  const node = doc.nodes.get(id) as Y.Map<unknown> | undefined;
  if (!node) return null;
  return { type: node.get('type') as MarkupNode['type'], hidden: Boolean(node.get('hidden')), locked: Boolean(node.get('locked')) };
}

/**
 * Whether the node itself paints nothing: opacity 0, visibility hidden or display none. Page snapshots are full
 * of these (hover and focus overlays from ::before/::after that cover the whole element), and a click must
 * land on what the user sees, never on a transparent layer stacked over it.
 */
export function paintsNothing(doc: MarkupDoc, id: string): boolean {
  const styles = (doc.nodes.get(id) as Y.Map<unknown> | undefined)?.get('styles') as Y.Map<unknown> | undefined;
  if (!styles) return false;
  const opacity = styles.get('opacity');
  return (
    (opacity !== undefined && opacity !== null && opacity !== '' && Number(opacity) === 0) ||
    /^(hidden|collapse)$/.test(String(styles.get('visibility') ?? '')) ||
    String(styles.get('display') ?? '') === 'none'
  );
}

/** A canvas click or drop can land on the node: shown, unlocked, and painting something. */
export function pickable(doc: MarkupDoc, id: string): boolean {
  const n = nodeFlags(doc, id);
  return !!n && !n.hidden && !n.locked && !paintsNothing(doc, id);
}

/** Child ids of a node, read from its Y.Map; empty when the node is gone. */
export function childIds(doc: MarkupDoc, id: string): string[] {
  const children = (doc.nodes.get(id) as Y.Map<unknown> | undefined)?.get('children') as Y.Array<string> | undefined;
  return children ? children.toArray() : [];
}

export interface HitOptions {
  /** deep (⌘-click) returns the leaf; shallow returns the artboard's direct child. */
  deep: boolean;
  rectOf: (id: string) => Rect | null;
}

/** Top-most visible, unlocked node under a world point. Later siblings paint on top. */
export function hitTest(doc: MarkupDoc, rootId: string, point: Point, opts: HitOptions): string | null {
  const selectable = (id: string) => pickable(doc, id);

  const topmostChild = (parentId: string): string | null => {
    if (!doc.nodes.has(parentId)) doc.requireNode(parentId);
    const children = childIds(doc, parentId);
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
    const child = nodeFlags(doc, current)?.type === 'frame' ? topmostChild(current) : null;
    if (!child) return current;
    if (!opts.deep && depth === 0) return child;
    current = child;
  }
}

/**
 * Every node under the point, outermost first: the topmost artboard, then at each level the topmost
 * visible, unlocked child that contains the point.
 */
export function hitPath(doc: MarkupDoc, rootId: string, point: Point, rectOf: (id: string) => Rect | null): string[] {
  const path: string[] = [];
  let parentId = rootId;
  for (;;) {
    const parent = nodeFlags(doc, parentId);
    if (!parent || (parentId !== rootId && parent.type !== 'frame')) return path;
    const children = childIds(doc, parentId);
    let next: string | null = null;
    for (let i = children.length - 1; i >= 0; i--) {
      const id = children[i]!;
      if (!pickable(doc, id)) continue;
      const r = rectOf(id);
      if (r && contains(r, point)) {
        next = id;
        break;
      }
    }
    if (!next) return path;
    path.push(next);
    parentId = next;
  }
}

/**
 * Which node of a hit path a click picks. Deep (Ctrl/⌘) takes the innermost. Otherwise the click stays at
 * the level the user is working at: a selected node under the pointer stays picked (so it can be dragged),
 * and a sibling of a selected node is picked at that same depth, so moving between neighbours needs one
 * click each. With nothing relevant selected it picks an artboard's direct child, past wrappers (see
 * `pastWrappers`).
 */
export function pickFromPath(doc: MarkupDoc, path: string[], selected: string[], deep: boolean): string | null {
  if (!path.length) return null;
  if (deep) return path[path.length - 1]!;
  for (const id of selected) {
    const at = path.indexOf(id);
    if (at > 0) return path[at]!;
    const parentAt = path.indexOf(doc.getNode(id)?.parentId ?? '');
    if (parentAt >= 0) return path[Math.min(parentAt + 1, path.length - 1)]!;
  }
  return path[pastWrappers(doc, path, Math.min(1, path.length - 1))]!;
}

/**
 * From `path[at]`, steps past frames that are their parent's only child and only wrap another frame: a click
 * means the first layer that has neighbours to choose between (a page snapshot nests a button row many
 * wrappers deep). It never steps onto a text, image or svg leaf, so a card holding just a title stays the pick.
 */
export function pastWrappers(doc: MarkupDoc, path: string[], at: number): number {
  while (at < path.length - 1 && doc.getNode(path[at + 1]!)?.type === 'frame' && doc.getNode(doc.getNode(path[at]!)?.parentId ?? '')?.children.length === 1) at++;
  return at;
}

/**
 * Layers a drag-select box can pick inside `scopeId`: its visible, unlocked children. Inside an artboard it
 * steps past a lone wrapper frame (a page snapshot often nests everything in one), so the box picks the
 * layers the user sees side by side. On the page itself it picks artboards and loose layers.
 */
export function marqueeCandidates(doc: MarkupDoc, rootId: string, scopeId: string): string[] {
  let ids = childIds(doc, scopeId).filter((id) => pickable(doc, id));
  if (scopeId === rootId) return ids;
  while (ids.length === 1 && nodeFlags(doc, ids[0]!)?.type === 'frame') {
    const inner = childIds(doc, ids[0]!).filter((id) => pickable(doc, id));
    if (!inner.length) break;
    ids = inner;
  }
  return ids;
}

const intersects = (a: Rect, b: Rect) => a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;

/** Candidates the box touches, in document order. */
export function marqueeHits(candidates: string[], rectOf: (id: string) => Rect | null, box: Rect): string[] {
  return candidates.filter((id) => {
    const r = rectOf(id);
    return !!r && intersects(r, box);
  });
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

/** Main axis children of a container flow along: a flex row (or a grid, filled row by row) is 'row'; block flow is 'column'. */
export function layoutAxis(styles: Styles): 'row' | 'column' {
  const display = String(styles.display ?? '');
  if (display.endsWith('grid')) return 'row';
  if (display.endsWith('flex')) return String(styles.flexDirection ?? 'row').startsWith('row') ? 'row' : 'column';
  return 'column';
}

/** True when a node takes part in its parent's layout (it is not lifted out with absolute or fixed position). */
export const inFlow = (styles: Styles): boolean => styles.position !== 'absolute' && styles.position !== 'fixed';

/**
 * Index among in-flow siblings a dragged node takes, from the pointer. Rows may wrap onto several lines
 * (flex-wrap, grid), so on the row axis an item whose line starts below the pointer, or that sits on the
 * pointer's line to its right half, comes after the drop point.
 */
export function flowDropIndex(siblingRects: Rect[], pointer: Point, axis: 'row' | 'column'): number {
  if (axis === 'column') return flexDropIndex(siblingRects, pointer, 'column');
  for (let i = 0; i < siblingRects.length; i++) {
    const r = siblingRects[i]!;
    if (pointer.y < r.y) return i;
    if (pointer.y <= r.y + r.height && pointer.x < r.x + r.width / 2) return i;
  }
  return siblingRects.length;
}

/**
 * Where dragged layers land, as a change to the HTML tree rather than a pixel offset:
 * - `root`: off every artboard, onto the page (a new top-level layer);
 * - `flow`: into `parentId`'s layout, before the in-flow sibling `beforeId` (null appends).
 */
export type DropTarget = { kind: 'root' } | { kind: 'flow'; parentId: string; beforeId: string | null; axis: 'row' | 'column' };

/** Edge band (world units) of a frame where a drop goes next to it instead of into it. */
const ENTER_BAND_MAX = 24;

/**
 * Drop target for a drag at `point`. It walks down from the artboard under the pointer into nested frames,
 * skipping the dragged layers (a layer never drops into itself). A frame is entered when it lays out
 * children (has some, or is a flex/grid box) and the pointer is past its edge band on its parent's axis, so
 * dropping near a card's edge reorders the card while dropping in its middle puts the layer inside it.
 * With `keepDragged` (an Alt-drag duplicate) the dragged layers stay in place and count as siblings.
 */
export function flowDropTarget(
  doc: MarkupDoc,
  rootId: string,
  point: Point,
  dragged: readonly string[],
  rectOf: (id: string) => Rect | null,
  keepDragged = false,
): DropTarget {
  const skip = new Set(dragged);
  const topmost = (parentId: string): string | null => {
    const children = childIds(doc, parentId);
    for (let i = children.length - 1; i >= 0; i--) {
      const id = children[i]!;
      if (skip.has(id) || !pickable(doc, id)) continue;
      const r = rectOf(id);
      if (r && contains(r, point)) return id;
    }
    return null;
  };
  let container = topmost(rootId);
  if (!container || nodeFlags(doc, container)?.type !== 'frame') return { kind: 'root' };
  for (;;) {
    const child = topmost(container);
    if (!child) break;
    const node = doc.getNode(child);
    if (!node || node.type !== 'frame') break;
    const laysOut = node.children.some((c) => !skip.has(c)) || /flex|grid/.test(String(node.styles.display ?? ''));
    const r = rectOf(child);
    if (!laysOut || !r) break;
    const axis = layoutAxis(doc.getNode(container)?.styles ?? {});
    const [lo, size, at] = axis === 'row' ? [r.x, r.width, point.x] : [r.y, r.height, point.y];
    const band = Math.min(size * 0.25, ENTER_BAND_MAX);
    if (inFlow(node.styles) && (at < lo + band || at > lo + size - band)) break;
    container = child;
  }
  const parent = doc.requireNode(container);
  const axis = layoutAxis(parent.styles);
  const siblings = parent.children.filter((id) => {
    if (!keepDragged && skip.has(id)) return false;
    const n = doc.getNode(id);
    return !!n && !n.hidden && inFlow(n.styles);
  });
  const placed = siblings.map((id) => ({ id, r: rectOf(id) })).filter((s): s is { id: string; r: Rect } => !!s.r);
  const index = flowDropIndex(
    placed.map((s) => s.r),
    point,
    axis,
  );
  return { kind: 'flow', parentId: container, beforeId: placed[index]?.id ?? null, axis };
}

/** Clears the absolute placement of a layer that joins its new parent's layout. */
export const JOIN_FLOW: Styles = { position: '', left: '', top: '', right: '', bottom: '', inset: '' };

/**
 * Styles of a layer dragged off its artboard onto the page: placed where it was dropped, and pinned to the
 * width it had, since a width taken from the old parent (auto, %, flex) means nothing on the page.
 */
export function pageLayerStyles(styles: Styles, rect: Rect | null, delta: Point): Styles {
  const r = rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const out: Styles = { position: 'absolute', left: Math.round(r.x + delta.x), top: Math.round(r.y + delta.y), right: '', bottom: '', inset: '' };
  const width = styles.width;
  if (rect && (width === undefined || typeof width === 'string' && !/^\d+(\.\d+)?px$/.test(width))) out.width = `${Math.round(rect.width)}px`;
  return out;
}
