import * as Y from 'yjs';
import type { MarkupDoc } from './document';
import { MarkupError, type Actor, type NodeSpec, type StyleValue } from './schema';
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

function buildSpec(doc: MarkupDoc, spec: NodeSpec, parentId: string): string {
  const id = newId();
  const name = spec.name ?? defaultName(spec);
  doc.nodes.set(id, createYNode({ id, type: spec.type, name, parentId, styles: spec.styles, text: spec.text, src: spec.src, svg: spec.svg }));
  const children = childrenOf(doc.yNode(id));
  for (const child of spec.children ?? []) children.push([buildSpec(doc, child, id)]);
  return id;
}

function defaultName(spec: NodeSpec): string {
  if (spec.type === 'text') {
    const plain = (spec.text ?? '').replace(/<[^>]*>/g, '').trim();
    return plain ? plain.slice(0, 30) : 'Text';
  }
  return { frame: 'Frame', image: 'Image', svg: 'SVG' }[spec.type];
}

export function insertNodes(doc: MarkupDoc, parentId: string, specs: NodeSpec[], index?: number): string[] {
  const parent = doc.yNode(parentId);
  if (!canHaveChildren(parent)) throw new MarkupError('INVALID_PARENT', `Node ${parentId} cannot have children.`);
  const ids = specs.map((spec) => buildSpec(doc, spec, parentId));
  const siblings = childrenOf(parent);
  const at = Math.max(0, Math.min(index ?? siblings.length, siblings.length));
  siblings.insert(at, ids);
  return ids;
}

export function replaceNode(doc: MarkupDoc, targetId: string, specs: NodeSpec[]): string[] {
  const target = doc.yNode(targetId);
  assertNotRoot(target);
  const parentId = target.get('parentId') as string;
  const index = childrenOf(doc.yNode(parentId)).toArray().indexOf(targetId);
  deleteNodes(doc, [targetId]);
  return insertNodes(doc, parentId, specs, index);
}

export function updateStyles(doc: MarkupDoc, updates: StyleUpdate[]): void {
  for (const { nodeIds, styles } of updates) {
    for (const id of nodeIds) {
      const map = stylesOf(doc.yNode(id));
      for (const [key, value] of Object.entries(styles)) {
        if (value === null || value === '') map.delete(key);
        else map.set(key, value);
      }
    }
  }
}

export function setText(doc: MarkupDoc, updates: { nodeId: string; html: string }[]): void {
  for (const { nodeId, html } of updates) {
    const node = doc.yNode(nodeId);
    if (node.get('type') !== 'text') throw new MarkupError('INVALID_ARGUMENT', `Node ${nodeId} is not a Text node.`);
    node.set('text', html);
  }
}

export function moveNodes(doc: MarkupDoc, moves: Move[]): MoveResult {
  const results: MoveResult['results'] = [];
  const touched = new Set<string>();
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
    if (!node) continue; // already removed with an ancestor in this batch
    assertNotRoot(node);
    detach(doc, id);
    removeSubtree(doc, id);
  }
}

function removeSubtree(doc: MarkupDoc, id: string) {
  const node = doc.nodes.get(id);
  if (!node) return;
  for (const child of childrenOf(node).toArray()) removeSubtree(doc, child);
  doc.nodes.delete(id);
}

export function duplicateNodes(doc: MarkupDoc, items: { id: string; parentId?: string }[]): DuplicateResult[] {
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

/** Walks the new subtree in parallel with the cloned spec to map source descendant ids to new ids. */
function remap(doc: MarkupDoc, newId: string, spec: ClonedSpec, map: Record<string, string>): Record<string, string> {
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
