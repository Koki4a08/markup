import type { Actor, MarkupDoc, MarkupNode, Move, StyleUpdate, Styles, StyleValue } from '@markup/doc';

/** Canvas edits behind the context menu that need more than one doc op or a look at the rendered layout. */

const STYLES_KEY = 'markup:styles';
/** Where a layer sits and how big it is: Copy styles leaves these behind. */
const PLACEMENT = /^(position|left|top|right|bottom|width|height|zIndex|flex|flexGrow|flexShrink|flexBasis|alignSelf|order|margin.*|gridRow.*|gridColumn.*)$/;
/** Text-only properties (the doc's strict dialect drops them on anything but text); pasted only onto text. */
const TEXT_ONLY = new Set(['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform', 'textDecoration', 'color']);
const FLEX_KEYS = ['display', 'flexDirection', 'gap', 'rowGap', 'columnGap', 'alignItems', 'justifyContent', 'flexWrap'];

let copied: Styles | null | undefined;

/** The styles Copy styles remembered (also across reloads, through localStorage), or null. */
export function copiedStyles(): Styles | null {
  if (copied === undefined) {
    try {
      const raw = localStorage.getItem(STYLES_KEY);
      copied = raw ? (JSON.parse(raw) as Styles) : null;
    } catch {
      copied = null;
    }
  }
  return copied;
}

export function setCopiedStyles(styles: Styles | null): void {
  copied = styles;
  try {
    if (styles) localStorage.setItem(STYLES_KEY, JSON.stringify(styles));
    else localStorage.removeItem(STYLES_KEY);
  } catch {
    /* Storage blocked: the in-memory copy still works for this session. */
  }
}

/** Remembers the node's styles minus placement and size. Returns false when the node is gone. */
export function copyStyles(doc: MarkupDoc, id: string): boolean {
  const node = doc.getNode(id);
  if (!node || node.type === 'root') return false;
  setCopiedStyles(Object.fromEntries(Object.entries(node.styles).filter(([k]) => !PLACEMENT.test(k))));
  return true;
}

/** Applies the copied styles to every node in one undo step; text-only properties only on text nodes. */
export function pasteStyles(doc: MarkupDoc, actor: Actor, ids: string[]): void {
  const styles = copiedStyles();
  if (!styles || ids.length === 0) return;
  const live = ids.filter((id) => doc.getNode(id));
  const texts = live.filter((id) => doc.requireNode(id).type === 'text');
  const others = live.filter((id) => doc.requireNode(id).type !== 'text');
  const boxStyles = Object.fromEntries(Object.entries(styles).filter(([k]) => !TEXT_ONLY.has(k)));
  const updates: StyleUpdate[] = [];
  if (texts.length) updates.push({ nodeIds: texts, styles });
  if (others.length && Object.keys(boxStyles).length) updates.push({ nodeIds: others, styles: boxStyles });
  if (updates.length) doc.updateStyles(actor, updates, `Pasted styles on ${ids.length} layer${ids.length === 1 ? '' : 's'}`, { dialect: 'any' });
}

const px = (v: StyleValue | undefined): number | undefined => {
  if (typeof v === 'number') return v;
  const m = typeof v === 'string' ? /^(-?\d+(?:\.\d+)?)(px)?$/.exec(v.trim()) : null;
  return m ? Number(m[1]) : undefined;
};
const isFlex = (node: MarkupNode) => /^(inline-)?flex$/.test(String(node.styles.display ?? '').trim());

/** The node as rendered on the canvas, if it is. */
function rendered(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.canvas-world [data-node-id="${id.replace(/["\\]/g, '\\$&')}"]`);
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The child's box relative to the frame's border box, in layout px (the canvas zoom divided out), plus the frame's borders. */
function measure(frameEl: HTMLElement, childEl: HTMLElement): Box {
  const f = frameEl.getBoundingClientRect();
  const c = childEl.getBoundingClientRect();
  const zoom = frameEl.offsetWidth > 0 && f.width > 0 ? f.width / frameEl.offsetWidth : 1;
  return { x: (c.left - f.left) / zoom, y: (c.top - f.top) / zoom, w: c.width / zoom, h: c.height / zoom };
}

function borders(el: HTMLElement | null): { left: number; top: number } {
  if (!el) return { left: 0, top: 0 };
  const cs = getComputedStyle(el);
  return { left: parseFloat(cs.borderLeftWidth) || 0, top: parseFloat(cs.borderTopWidth) || 0 };
}

const pinned = (b: Box, dx = 0, dy = 0): Styles => ({
  position: 'absolute',
  left: `${Math.round(b.x + dx)}px`,
  top: `${Math.round(b.y + dy)}px`,
  width: `${Math.round(b.w)}px`,
  height: `${Math.round(b.h)}px`,
});

/** Turns each selected flex frame into a plain frame whose rendered children are pinned where they were. One undo step. */
export function removeFlex(doc: MarkupDoc, actor: Actor, ids: string[]): void {
  const frames = ids.map((id) => doc.getNode(id)).filter((n): n is MarkupNode => n?.type === 'frame' && isFlex(n));
  const updates: StyleUpdate[] = [];
  for (const frame of frames) {
    const frameEl = rendered(frame.id);
    const border = borders(frameEl);
    for (const child of frame.children) {
      const childEl = frameEl && rendered(child);
      if (frameEl && childEl) updates.push({ nodeIds: [child], styles: pinned(measure(frameEl, childEl), -border.left, -border.top) });
    }
    const off: Record<string, StyleValue | null> = Object.fromEntries(FLEX_KEYS.map((k) => [k, null]));
    if (!frame.styles.position) off.position = 'relative';
    updates.push({ nodeIds: [frame.id], styles: off });
  }
  if (frames.length) doc.updateStyles(actor, updates, `Removed flex from ${frames.length} frame${frames.length === 1 ? '' : 's'}`, { dialect: 'any' });
}

/**
 * Moves each selected frame's children into its parent at the frame's place and deletes the frame, in one undo
 * step. Outside a flex parent the children keep their place on screen: absolute ones are offset by the frame's
 * position, the others are pinned absolutely where they were rendered. Returns the moved children.
 */
export function ungroup(doc: MarkupDoc, actor: Actor, ids: string[]): string[] {
  const frames = ids
    .map((id) => doc.getNode(id))
    .filter((n): n is MarkupNode => n?.type === 'frame' && n.children.length > 0)
    // A frame inside another one being ungrouped moves with it.
    .filter((n, _, all) => !all.some((other) => other.id !== n.id && isInside(doc, n.id, other.id)));
  if (frames.length === 0) return [];
  const moved = frames.flatMap((f) => f.children);
  doc.batch(actor, `Ungrouped ${frames.length} frame${frames.length === 1 ? '' : 's'}`, () => {
    const updates: StyleUpdate[] = [];
    for (const frame of frames) {
      const parent = doc.requireNode(frame.parentId!);
      if (parent.type !== 'root' && isFlex(parent)) continue;
      const absolute = frame.styles.position === 'absolute';
      const dx = absolute ? (px(frame.styles.left) ?? 0) : 0;
      const dy = absolute ? (px(frame.styles.top) ?? 0) : 0;
      const frameEl = rendered(frame.id);
      const border = borders(frameEl);
      for (const id of frame.children) {
        const child = doc.requireNode(id);
        if (child.styles.position === 'absolute') {
          const left = px(child.styles.left);
          const top = px(child.styles.top);
          const styles: Styles = {};
          if (left !== undefined) styles.left = `${Math.round(left + dx + border.left)}px`;
          if (top !== undefined) styles.top = `${Math.round(top + dy + border.top)}px`;
          if (Object.keys(styles).length) updates.push({ nodeIds: [id], styles });
          continue;
        }
        const childEl = frameEl && rendered(id);
        if (frameEl && childEl) updates.push({ nodeIds: [id], styles: pinned(measure(frameEl, childEl), dx, dy) });
      }
    }
    if (updates.length) doc.updateStyles(actor, updates, undefined, { dialect: 'any' });
    doc.moveNodes(actor, frames.flatMap((f) => f.children.map((nodeId): Move => ({ nodeId, before: f.id }))));
    doc.deleteNodes(actor, frames.map((f) => f.id));
  });
  return moved;
}

function isInside(doc: MarkupDoc, id: string, ancestor: string): boolean {
  for (let p = doc.getNode(id)?.parentId; p; p = doc.getNode(p)?.parentId) if (p === ancestor) return true;
  return false;
}

export type Arrange = 'bringToFront' | 'sendToBack' | 'moveForward' | 'moveBackward';

/** The sibling order after the arrange command; the last child paints on top. */
function arranged(order: string[], picked: Set<string>, command: Arrange): string[] {
  const out = [...order];
  if (command === 'bringToFront') return [...out.filter((id) => !picked.has(id)), ...out.filter((id) => picked.has(id))];
  if (command === 'sendToBack') return [...out.filter((id) => picked.has(id)), ...out.filter((id) => !picked.has(id))];
  if (command === 'moveForward') {
    for (let i = out.length - 2; i >= 0; i--) if (picked.has(out[i]!) && !picked.has(out[i + 1]!)) [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
  } else {
    for (let i = 1; i < out.length; i++) if (picked.has(out[i]!) && !picked.has(out[i - 1]!)) [out[i], out[i - 1]] = [out[i - 1]!, out[i]!];
  }
  return out;
}

/** Reorders the selected nodes among their siblings in one undo step. */
export function reorder(doc: MarkupDoc, actor: Actor, ids: string[], command: Arrange): void {
  const byParent = new Map<string, Set<string>>();
  for (const id of ids) {
    const parentId = doc.getNode(id)?.parentId;
    if (parentId) byParent.set(parentId, (byParent.get(parentId) ?? new Set()).add(id));
  }
  const moves: Move[] = [];
  for (const [parentId, picked] of byParent) {
    const current = [...doc.requireNode(parentId).children];
    const next = arranged(current, picked, command);
    // Placing next[i] at index i in turn keeps 0..i-1 settled, so each move's index is final.
    for (let i = 0; i < next.length; i++) {
      if (current[i] === next[i]) continue;
      current.splice(current.indexOf(next[i]!), 1);
      current.splice(i, 0, next[i]!);
      moves.push({ nodeId: next[i]!, parentId, index: i });
    }
  }
  if (moves.length) doc.moveNodes(actor, moves, labels[command]);
}

const labels: Record<Arrange, string> = { bringToFront: 'Brought to front', sendToBack: 'Sent to back', moveForward: 'Moved forward', moveBackward: 'Moved backward' };
