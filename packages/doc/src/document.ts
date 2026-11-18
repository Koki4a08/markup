import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import {
  MarkupError,
  type Actor,
  type MarkupNode,
  type PageEntry,
  type PageIcon,
  type Styles,
} from './schema';

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

export class MarkupDoc {
  readonly ydoc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly pagesArr: Y.Array<Y.Map<unknown>>;
  readonly nodes: Y.Map<YNode>;

  constructor(opts: { ydoc?: Y.Doc; name?: string } = {}) {
    this.ydoc = opts.ydoc ?? new Y.Doc();
    this.meta = this.ydoc.getMap('meta');
    this.pagesArr = this.ydoc.getArray('pages');
    this.nodes = this.ydoc.getMap('nodes');
    if (!this.meta.has('fileId')) {
      this.ydoc.transact(() => {
        this.meta.set('fileId', newId());
        this.meta.set('name', opts.name ?? 'Untitled');
        this.insertPage('Page 1', null);
      }, null);
    }
  }

  get fileId(): string {
    return this.meta.get('fileId') as string;
  }

  get name(): string {
    return this.meta.get('name') as string;
  }

  set name(value: string) {
    this.meta.set('name', value);
  }

  pages(): PageEntry[] {
    return this.pagesArr.toArray().map((p) => {
      if (p.get('type') === 'divider') return { type: 'divider', id: p.get('id') as string };
      return {
        type: 'page',
        id: p.get('id') as string,
        name: p.get('name') as string,
        icon: (p.get('icon') as PageIcon | null) ?? null,
        rootId: p.get('rootId') as string,
      };
    });
  }

  createPage(actor: Actor, opts: { name?: string; icon?: PageIcon } = {}): string {
    let id = '';
    this.ydoc.transact(() => {
      const count = this.pages().filter((p) => p.type === 'page').length;
      id = this.insertPage(opts.name ?? `Page ${count + 1}`, opts.icon ?? null);
    }, actor);
    return id;
  }

  getNode(id: string): MarkupNode | undefined {
    const node = this.nodes.get(id);
    return node ? snapshotNode(node) : undefined;
  }

  requireNode(id: string): MarkupNode {
    const node = this.getNode(id);
    if (!node) throw new MarkupError('NODE_NOT_FOUND', `Node ${id} does not exist.`);
    return node;
  }

  /** Raw Y.Map of a node; throws NODE_NOT_FOUND. */
  yNode(id: string): YNode {
    const node = this.nodes.get(id);
    if (!node) throw new MarkupError('NODE_NOT_FOUND', `Node ${id} does not exist.`);
    return node;
  }

  rootOf(pageId: string): string {
    const page = this.pages().find((p) => p.type === 'page' && p.id === pageId);
    if (!page || page.type !== 'page') throw new MarkupError('PAGE_NOT_FOUND', `Page ${pageId} does not exist.`);
    return page.rootId;
  }

  pageOfNode(nodeId: string): string {
    let current = this.yNode(nodeId);
    for (;;) {
      const parentId = current.get('parentId') as string | null;
      if (!parentId) break;
      current = this.yNode(parentId);
    }
    const rootId = current.get('id') as string;
    const page = this.pages().find((p) => p.type === 'page' && p.rootId === rootId);
    if (!page) throw new MarkupError('PAGE_NOT_FOUND', `Node ${nodeId} is not on any page.`);
    return page.id;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  private insertPage(name: string, icon: PageIcon | null): string {
    const pageId = newId();
    const rootId = newId();
    this.nodes.set(rootId, createYNode({ id: rootId, type: 'root', name, parentId: null }));
    const page = new Y.Map<unknown>();
    page.set('type', 'page');
    page.set('id', pageId);
    page.set('name', name);
    page.set('icon', icon);
    page.set('rootId', rootId);
    this.pagesArr.push([page]);
    return pageId;
  }
}
