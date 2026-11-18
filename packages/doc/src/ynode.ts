import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import type { MarkupNode, Styles } from './schema';

export type YNode = Y.Map<unknown>;

export const newId = (): string => nanoid(10);

/** Builds the Y.Map for one node. Caller inserts it into the nodes map. */
export function createYNode(fields: {
  id: string;
  type: MarkupNode['type'];
  name: string;
  parentId: string | null;
  styles?: Styles;
  text?: string;
  src?: string;
  svg?: string;
  locked?: boolean;
  hidden?: boolean;
}): YNode {
  const node = new Y.Map<unknown>();
  node.set('id', fields.id);
  node.set('type', fields.type);
  node.set('name', fields.name);
  node.set('parentId', fields.parentId);
  node.set('locked', fields.locked ?? false);
  node.set('hidden', fields.hidden ?? false);
  if (fields.text !== undefined) node.set('text', fields.text);
  if (fields.src !== undefined) node.set('src', fields.src);
  if (fields.svg !== undefined) node.set('svg', fields.svg);
  const styles = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(fields.styles ?? {})) styles.set(k, v);
  node.set('styles', styles);
  node.set('children', new Y.Array<string>());
  return node;
}

export function snapshotNode(node: YNode): MarkupNode {
  const styles = node.get('styles') as Y.Map<unknown>;
  const children = node.get('children') as Y.Array<string>;
  const out: MarkupNode = {
    id: node.get('id') as string,
    type: node.get('type') as MarkupNode['type'],
    name: node.get('name') as string,
    parentId: (node.get('parentId') as string | null) ?? null,
    children: children.toArray(),
    styles: styles.toJSON() as Styles,
    locked: Boolean(node.get('locked')),
    hidden: Boolean(node.get('hidden')),
  };
  for (const key of ['text', 'src', 'svg'] as const) {
    const v = node.get(key);
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

