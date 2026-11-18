import * as Y from 'yjs';
import { parseHtml } from './html-import';
import * as ops from './ops';
import * as tokens from './tokens';
import type { Token, TokenEdit, TokenQuery, TokenResult } from './tokens';
import type { DuplicateResult, Move, MoveResult, StyleUpdate } from './ops';
import { createYNode, newId, snapshotNode, type YNode } from './ynode';
import {
  MarkupError,
  type Actor,
  type MarkupNode,
  type NodeSpec,
  type PageEntry,
  type PageIcon,
} from './schema';

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

  insertNodes(actor: Actor, parentId: string, specs: NodeSpec[], index?: number): string[] {
    return this.mutate(actor, () => ops.insertNodes(this, parentId, specs, index));
  }

  replaceNode(actor: Actor, targetId: string, specs: NodeSpec[]): string[] {
    return this.mutate(actor, () => ops.replaceNode(this, targetId, specs));
  }

  updateStyles(actor: Actor, updates: StyleUpdate[]): { ignoredStyles: Record<string, string[]> } {
    return { ignoredStyles: this.mutate(actor, () => ops.updateStyles(this, updates)) };
  }

  writeHtml(actor: Actor, targetNodeId: string, html: string, mode: 'insert-children' | 'replace'): { nodeIds: string[]; ignoredStyles: string[] } {
    const { specs, ignored } = parseHtml(html);
    const nodeIds = mode === 'replace' ? this.replaceNode(actor, targetNodeId, specs) : this.insertNodes(actor, targetNodeId, specs);
    return { nodeIds, ignoredStyles: ignored };
  }

  setText(actor: Actor, updates: { nodeId: string; html: string }[]): void {
    this.mutate(actor, () => ops.setText(this, updates));
  }

  moveNodes(actor: Actor, moves: Move[]): MoveResult {
    return this.mutate(actor, () => ops.moveNodes(this, moves));
  }

  deleteNodes(actor: Actor, ids: string[]): void {
    this.mutate(actor, () => ops.deleteNodes(this, ids));
  }

  duplicateNodes(actor: Actor, items: { id: string; parentId?: string }[]): DuplicateResult[] {
    return this.mutate(actor, () => ops.duplicateNodes(this, items));
  }

  renameNodes(actor: Actor, updates: { nodeId: string; name: string }[]): void {
    this.mutate(actor, () => ops.renameNodes(this, updates));
  }

  setWorking(actor: Actor, artboardIds: string[] | 'all', on: boolean): void {
    this.mutate(actor, () => ops.setWorking(this, actor, artboardIds, on));
  }

  createTokens(actor: Actor, list: Token[]): TokenResult[] {
    return this.mutate(actor, () => tokens.createTokens(this, list));
  }

  setTokens(actor: Actor, edits: TokenEdit[]): TokenResult[] {
    return this.mutate(actor, () => tokens.setTokens(this, edits));
  }

  getTokens(q?: TokenQuery): Token[] | string {
    return tokens.getTokens(this, q);
  }

  working(): Record<string, Actor> {
    return this.ydoc.getMap<Actor>('working').toJSON() as Record<string, Actor>;
  }

  artboardOf(nodeId: string): string | null {
    return ops.artboardOf(this, nodeId);
  }

  /** Runs fn in one transaction whose origin is the actor. */
  protected mutate<T>(actor: Actor, fn: () => T): T {
    let result!: T;
    this.ydoc.transact(() => {
      result = fn();
    }, actor);
    return result;
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
