import * as Y from 'yjs';
import type { MarkupDoc } from './document';
import { MarkupError, type Actor, type MarkupNode, type NodeSpec, type StyleValue } from './schema';
import { clearShadowedLonghands, normalizeStyles, type Dialect } from './styles';
import { createYNode, newId, type YNode } from './ynode';

export type Move =
  | { nodeId: string; before: string }
  | { nodeId: string; after: string }
  | { nodeId: string; parentId: string | 'root'; index?: number };

export interface MoveResult {
  results: { nodeId: string; parentId: string; index: number }[];
  affectedParents: Record<string, string[]>;
}

export interface DuplicateResult {
  sourceId: string;
  newId: string;
  descendantIdMap: Record<string, string>;
}

export type StyleUpdate = { nodeIds: string[]; styles: Record<string, StyleValue | null> };

const ARTBOARD_GAP = 80;

export function parsePx(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(value.trim());
    if (m) return Number(m[1]);
  }
  return undefined;
}

const childrenOf = (node: YNode) => node.get('children') as Y.Array<string>;
const stylesOf = (node: YNode) => node.get('styles') as Y.Map<unknown>;

function canHaveChildren(node: YNode): boolean {
  const type = node.get('type');
  return type === 'frame' || type === 'root';
}

function assertNotRoot(node: YNode) {
  if (node.get('type') === 'root') throw new MarkupError('IS_ROOT', 'The page root cannot be moved, duplicated or deleted.');
}

function rootIdOf(doc: MarkupDoc, nodeId: string): string {
  let current = doc.yNode(nodeId);
  for (;;) {
    const parentId = current.get('parentId') as string | null;
    if (!parentId) return current.get('id') as string;
    current = doc.yNode(parentId);
  }
}

function isDescendant(doc: MarkupDoc, candidateId: string, ancestorId: string): boolean {
  let current: string | null = candidateId;
  while (current) {
    if (current === ancestorId) return true;
    current = (doc.yNode(current).get('parentId') as string | null) ?? null;
  }
  return false;
}

function detach(doc: MarkupDoc, nodeId: string) {
  const node = doc.yNode(nodeId);
  const parentId = node.get('parentId') as string | null;
  if (!parentId) return;
  const siblings = childrenOf(doc.yNode(parentId));
  const idx = siblings.toArray().indexOf(nodeId);
  if (idx >= 0) siblings.delete(idx, 1);
}

function attach(doc: MarkupDoc, nodeId: string, parentId: string, index: number): number {
  const siblings = childrenOf(doc.yNode(parentId));
  const at = Math.max(0, Math.min(index, siblings.length));
  siblings.insert(at, [nodeId]);
  doc.yNode(nodeId).set('parentId', parentId);
  return at;
}

function buildSpec(doc: MarkupDoc, input: NodeSpec, parentId: string): string {
  const spec = input.cloneOf ? resolveClone(doc, input.cloneOf) : input;
  const id = newId();
  const name = spec.name ?? defaultName(spec);
  doc.nodes.set(id, createYNode({ id, type: spec.type, name, parentId, styles: spec.styles, text: spec.text, src: spec.src, svg: spec.svg }));
  const children = childrenOf(doc.yNode(id));
  for (const child of spec.children ?? []) children.push([buildSpec(doc, child, id)]);
  return id;
}

function resolveClone(doc: MarkupDoc, cloneOf: NonNullable<NodeSpec['cloneOf']>): NodeSpec {
  const spec = toSpec(doc, cloneOf.nodeId);
  if (cloneOf.styles) spec.styles = { ...spec.styles, ...cloneOf.styles };
  return spec;
}

function defaultName(spec: NodeSpec): string {
  if (spec.type === 'text') {
    const plain = (spec.text ?? '').replace(/<[^>]*>/g, '').trim();
    return plain ? plain.slice(0, 30) : 'Text';
  }
  return { frame: 'Frame', image: 'Image', svg: 'SVG' }[spec.type];
}

/** Throws before any write if a clone source is missing, so a failed insert leaves no partial tree. */
function assertClones(doc: MarkupDoc, specs: NodeSpec[]) {
  for (const spec of specs) {
    if (spec.cloneOf) doc.yNode(spec.cloneOf.nodeId);
    assertClones(doc, spec.children ?? []);
  }
}

export function insertNodes(doc: MarkupDoc, parentId: string, specs: NodeSpec[], index?: number): string[] {
  const parent = doc.yNode(parentId);
  if (!canHaveChildren(parent)) throw new MarkupError('INVALID_PARENT', `Node ${parentId} cannot have children.`);
  assertClones(doc, specs);
  const ids = specs.map((spec) => buildSpec(doc, spec, parentId));
  const siblings = childrenOf(parent);
  const at = Math.max(0, Math.min(index ?? siblings.length, siblings.length));
  siblings.insert(at, ids);
  return ids;
}

/** Specs placed on a page root as artboards, left to right after the last one (a spec's own left/top wins). */
export function insertArtboards(doc: MarkupDoc, rootId: string, specs: NodeSpec[]): string[] {
  assertClones(doc, specs);
  return specs.map((spec) => {
    const own = spec.cloneOf ? { ...doc.requireNode(spec.cloneOf.nodeId).styles, ...spec.cloneOf.styles } : (spec.styles ?? {});
    const place = { position: 'absolute', left: own.left ?? rightEdge(doc, rootId) + ARTBOARD_GAP, top: own.top ?? 0 };
    const placed: NodeSpec = spec.cloneOf ? { ...spec, cloneOf: { ...spec.cloneOf, styles: { ...spec.cloneOf.styles, ...place } } } : { ...spec, styles: { ...own, ...place } };
    return insertNodes(doc, rootId, [placed])[0]!;
  });
}

export function replaceNode(doc: MarkupDoc, targetId: string, specs: NodeSpec[]): string[] {
  const target = doc.yNode(targetId);
  assertNotRoot(target);
  assertClones(doc, specs);
  const parentId = target.get('parentId') as string;
  const index = childrenOf(doc.yNode(parentId)).toArray().indexOf(targetId);
  deleteNodes(doc, [targetId]);
  return insertNodes(doc, parentId, specs, index);
}

export function updateStyles(doc: MarkupDoc, updates: StyleUpdate[], dialect: Dialect = 'strict'): Record<string, string[]> {
  const ignoredStyles: Record<string, string[]> = {};
  updates.forEach((u) => u.nodeIds.forEach((id) => doc.yNode(id)));
  for (const { nodeIds, styles: raw } of updates) {
    for (const id of nodeIds) {
      const node = doc.yNode(id);
      const type = node.get('type') as MarkupNode['type'];
      const { styles, ignored } = normalizeStyles(raw, { type, isArtboard: artboardOf(doc, id) === id }, dialect);
      if (ignored.length) ignoredStyles[id] = [...(ignoredStyles[id] ?? []), ...ignored];
      const map = stylesOf(node);
      for (const key of Object.keys(clearShadowedLonghands((k) => map.has(k), styles))) map.delete(key);
      for (const [key, value] of Object.entries(styles)) {
        if (value === null || value === '') map.delete(key);
        else map.set(key, value);
      }
    }
  }
  return ignoredStyles;
}

export function setText(doc: MarkupDoc, updates: { nodeId: string; html: string }[]): void {
  for (const { nodeId } of updates) {
    if (doc.yNode(nodeId).get('type') !== 'text') throw new MarkupError('INVALID_ARGUMENT', `Node ${nodeId} is not a Text node.`);
  }
  for (const { nodeId, html } of updates) doc.yNode(nodeId).set('text', html);
}

export function moveNodes(doc: MarkupDoc, moves: Move[]): MoveResult {
  const results: MoveResult['results'] = [];
  const touched = new Set<string>();
  for (const move of moves) {
    assertNotRoot(doc.yNode(move.nodeId));
    if ('before' in move) doc.yNode(move.before);
    else if ('after' in move) doc.yNode(move.after);
    else if (move.parentId !== 'root') doc.yNode(move.parentId);
  }
  for (const move of moves) {
    const node = doc.yNode(move.nodeId);
    assertNotRoot(node);
    const oldParent = node.get('parentId') as string;
    let parentId: string;
    let index: number;
    if ('before' in move || 'after' in move) {
      const siblingId = 'before' in move ? move.before : move.after;
      if (siblingId === move.nodeId) throw new MarkupError('INVALID_ARGUMENT', 'A node cannot be placed next to itself.');
      parentId = doc.yNode(siblingId).get('parentId') as string;
      if (!parentId) throw new MarkupError('INVALID_PARENT', 'Cannot place a node next to the page root.');
      validateParent(doc, move.nodeId, parentId);
      detach(doc, move.nodeId);
      const siblingIndex = childrenOf(doc.yNode(parentId)).toArray().indexOf(siblingId);
      index = 'before' in move ? siblingIndex : siblingIndex + 1;
    } else {
      parentId = move.parentId === 'root' ? rootIdOf(doc, move.nodeId) : move.parentId;
      validateParent(doc, move.nodeId, parentId);
      detach(doc, move.nodeId);
      index = move.index ?? Number.MAX_SAFE_INTEGER;
    }
    const at = attach(doc, move.nodeId, parentId, index);
    touched.add(oldParent).add(parentId);
    results.push({ nodeId: move.nodeId, parentId, index: at });
  }
  const affectedParents: Record<string, string[]> = {};
  for (const id of touched) affectedParents[id] = childrenOf(doc.yNode(id)).toArray();
  return { results, affectedParents };
}

function validateParent(doc: MarkupDoc, nodeId: string, parentId: string) {
  const parent = doc.yNode(parentId);
  if (!canHaveChildren(parent)) throw new MarkupError('INVALID_PARENT', `Node ${parentId} cannot have children.`);
  if (isDescendant(doc, parentId, nodeId)) throw new MarkupError('CYCLE', `Cannot move ${nodeId} under itself or its descendants.`);
}

export function deleteNodes(doc: MarkupDoc, ids: string[]): void {
  for (const id of ids) {
    const node = doc.nodes.get(id);
    if (node) assertNotRoot(node);
  }
  // Nodes removed with an ancestor in this batch need no work of their own, as before.
  const batch = new Set(ids.filter((id) => doc.nodes.has(id)));
  const tops = [...batch].filter((id) => !hasAncestorIn(doc, id, batch));
  // Detach per parent with one sibling scan, deleting from the end so earlier indices stay valid.
  const byParent = new Map<string, string[]>();
  for (const id of tops) {
    const parentId = doc.yNode(id).get('parentId') as string | null;
    if (!parentId) continue;
    const group = byParent.get(parentId);
    if (group) group.push(id);
    else byParent.set(parentId, [id]);
  }
  for (const [parentId, group] of byParent) {
    const siblings = childrenOf(doc.yNode(parentId));
    const indices = siblingIndices(siblings.toArray(), group).sort((x, y) => y - x);
    for (let i = 0; i < indices.length; ) {
      // A run of adjacent indices goes in one delete.
      let start = indices[i]!;
      let len = 1;
      while (i + len < indices.length && indices[i + len] === start - 1) {
        start--;
        len++;
      }
      siblings.delete(start, len);
      i += len;
    }
  }
  for (const id of tops) removeSubtree(doc, id);
}

/** Index of each id's first occurrence among the siblings, skipping ids not there. */
function siblingIndices(siblings: string[], ids: string[]): number[] {
  if (ids.length === 1) {
    const idx = siblings.indexOf(ids[0]!);
    return idx >= 0 ? [idx] : [];
  }
  const first = new Map<string, number>();
  siblings.forEach((id, i) => {
    if (!first.has(id)) first.set(id, i);
  });
  const out: number[] = [];
  for (const id of ids) {
    const idx = first.get(id);
    if (idx !== undefined) out.push(idx);
  }
  return out;
}

function hasAncestorIn(doc: MarkupDoc, id: string, set: Set<string>): boolean {
  let parentId = doc.nodes.get(id)?.get('parentId') as string | null | undefined;
  while (parentId) {
    if (set.has(parentId)) return true;
    parentId = doc.nodes.get(parentId)?.get('parentId') as string | null | undefined;
  }
  return false;
}

function removeSubtree(doc: MarkupDoc, id: string) {
  const node = doc.nodes.get(id);
  if (!node) return;
  for (const child of childrenOf(node).toArray()) removeSubtree(doc, child);
  doc.nodes.delete(id);
}

export function duplicateNodes(doc: MarkupDoc, items: { id: string; parentId?: string }[]): DuplicateResult[] {
  for (const { id, parentId } of items) {
    assertNotRoot(doc.yNode(id));
    if (parentId && !canHaveChildren(doc.yNode(parentId))) throw new MarkupError('INVALID_PARENT', `Node ${parentId} cannot have children.`);
  }
  return items.map(({ id, parentId }) => {
    const source = doc.yNode(id);
    assertNotRoot(source);
    const descendantIdMap: Record<string, string> = {};
    const spec = toSpec(doc, id);
    const sourceParent = source.get('parentId') as string;
    const targetParent = parentId ?? sourceParent;
    const isArtboard = doc.yNode(targetParent).get('type') === 'root';
    if (isArtboard) spec.styles = { ...spec.styles, left: rightEdge(doc, targetParent) + ARTBOARD_GAP };
    const index = parentId ? undefined : childrenOf(doc.yNode(sourceParent)).toArray().indexOf(id) + 1;
    const [newRootId] = insertNodes(doc, targetParent, [spec], index);
    return { sourceId: id, newId: newRootId!, descendantIdMap: remap(doc, newRootId!, spec, descendantIdMap) };
  });
}

type ClonedSpec = Omit<NodeSpec, 'children'> & { sourceId: string; children: ClonedSpec[] };

function toSpec(doc: MarkupDoc, id: string): ClonedSpec {
  const n = doc.requireNode(id);
  const spec: ClonedSpec = { sourceId: id, type: n.type as NodeSpec['type'], name: n.name, styles: { ...n.styles }, children: [] };
  if (n.text !== undefined) spec.text = n.text;
  if (n.src !== undefined) spec.src = n.src;
  if (n.svg !== undefined) spec.svg = n.svg;
  spec.children = n.children.map((c) => toSpec(doc, c));
  return spec;
}

/** Walks the new subtree in parallel with the cloned spec to map source descendant ids to new ids; copies export settings. */
function remap(doc: MarkupDoc, newId: string, spec: ClonedSpec, map: Record<string, string>): Record<string, string> {
  const exportSettings = doc.yNode(spec.sourceId).get('exports');
  if (Array.isArray(exportSettings)) doc.yNode(newId).set('exports', exportSettings);
  const newChildren = doc.requireNode(newId).children;
  spec.children.forEach((childSpec, i) => {
    const newChild = newChildren[i]!;
    map[childSpec.sourceId] = newChild;
    remap(doc, newChild, childSpec, map);
  });
  return map;
}

/** Right-most edge of the artboards under a page root, in world px. */
export function rightEdge(doc: MarkupDoc, rootId: string): number {
  let edge = Number.NEGATIVE_INFINITY;
  for (const childId of doc.requireNode(rootId).children) {
    const s = doc.requireNode(childId).styles;
    const right = (parsePx(s.left) ?? 0) + (parsePx(s.width) ?? 0);
    edge = Math.max(edge, right);
  }
  return Number.isFinite(edge) ? edge : -ARTBOARD_GAP;
}

export function renameNodes(doc: MarkupDoc, updates: { nodeId: string; name: string }[]): void {
  updates.forEach((u) => doc.yNode(u.nodeId));
  for (const { nodeId, name } of updates) doc.yNode(nodeId).set('name', name.slice(0, 50));
}

export function artboardOf(doc: MarkupDoc, nodeId: string): string | null {
  let current = doc.yNode(nodeId);
  if (current.get('type') === 'root') return null;
  for (;;) {
    const parentId = current.get('parentId') as string;
    const parent = doc.yNode(parentId);
    if (parent.get('type') === 'root') return current.get('id') as string;
    current = parent;
  }
}

export function setWorking(doc: MarkupDoc, actor: Actor, artboardIds: string[] | 'all', on: boolean): void {
  const working = doc.ydoc.getMap<Actor>('working');
  const ids = artboardIds === 'all' ? [...working.keys()].filter((k) => working.get(k)?.id === actor.id) : artboardIds;
  for (const id of ids) {
    if (on) working.set(id, { ...actor });
    else if (working.get(id)?.id === actor.id) working.delete(id);
  }
}
