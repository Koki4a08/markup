import * as Y from 'yjs';
import { appendEntry, EntryHistory, plural, readLog, type LogEntry } from './history';
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
  private readonly history: EntryHistory;
  private batchDepth = 0;

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
    this.history = new EntryHistory(this);
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

  createPage(actor: Actor, opts: { name?: string; icon?: PageIcon } = {}, summary?: string): string {
    return this.mutate(actor, summary ?? 'Created 1 page', () => {
      const count = this.pages().filter((p) => p.type === 'page').length;
      return this.insertPage(opts.name ?? `Page ${count + 1}`, opts.icon ?? null);
    });
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

  insertNodes(actor: Actor, parentId: string, specs: NodeSpec[], index?: number, summary?: string): string[] {
    return this.mutate(actor, summary ?? `Inserted ${plural(countSpecs(specs), 'node')}`, () => ops.insertNodes(this, parentId, specs, index));
  }

  replaceNode(actor: Actor, targetId: string, specs: NodeSpec[], summary?: string): string[] {
    return this.mutate(actor, summary ?? `Replaced 1 node with ${plural(countSpecs(specs), 'node')}`, () => ops.replaceNode(this, targetId, specs));
  }

  writeHtml(
    actor: Actor,
    targetNodeId: string,
    html: string,
    mode: 'insert-children' | 'replace',
    summary?: string,
  ): { nodeIds: string[]; ignoredStyles: string[] } {
    const { specs, ignored } = parseHtml(html);
    const nodeIds = mode === 'replace' ? this.replaceNode(actor, targetNodeId, specs, summary) : this.insertNodes(actor, targetNodeId, specs, undefined, summary);
    return { nodeIds, ignoredStyles: ignored };
  }

  updateStyles(actor: Actor, updates: StyleUpdate[], summary?: string): { ignoredStyles: Record<string, string[]> } {
    const count = new Set(updates.flatMap((u) => u.nodeIds)).size;
    return { ignoredStyles: this.mutate(actor, summary ?? `Updated styles on ${plural(count, 'node')}`, () => ops.updateStyles(this, updates)) };
  }

  setText(actor: Actor, updates: { nodeId: string; html: string }[], summary?: string): void {
    this.mutate(actor, summary ?? `Set text on ${plural(updates.length, 'node')}`, () => ops.setText(this, updates));
  }

  moveNodes(actor: Actor, moves: Move[], summary?: string): MoveResult {
    return this.mutate(actor, summary ?? `Moved ${plural(moves.length, 'node')}`, () => ops.moveNodes(this, moves));
  }

  deleteNodes(actor: Actor, ids: string[], summary?: string): void {
    this.mutate(actor, summary ?? `Deleted ${plural(ids.length, 'node')}`, () => ops.deleteNodes(this, ids));
  }

  duplicateNodes(actor: Actor, items: { id: string; parentId?: string }[], summary?: string): DuplicateResult[] {
    return this.mutate(actor, summary ?? `Duplicated ${plural(items.length, 'node')}`, () => ops.duplicateNodes(this, items));
  }

  renameNodes(actor: Actor, updates: { nodeId: string; name: string }[], summary?: string): void {
    this.mutate(actor, summary ?? `Renamed ${plural(updates.length, 'node')}`, () => ops.renameNodes(this, updates));
  }

  setWorking(actor: Actor, artboardIds: string[] | 'all', on: boolean): void {
    this.mutate(actor, null, () => ops.setWorking(this, actor, artboardIds, on));
  }

  createTokens(actor: Actor, list: Token[], summary?: string): TokenResult[] {
    return this.mutate(actor, summary ?? `Created ${plural(list.length, 'token')}`, () => tokens.createTokens(this, list));
  }

  setTokens(actor: Actor, edits: TokenEdit[], summary?: string): TokenResult[] {
    return this.mutate(actor, summary ?? `Edited ${plural(edits.length, 'token')}`, () => tokens.setTokens(this, edits));
  }

  getTokens(q?: TokenQuery): Token[] | string {
    return tokens.getTokens(this, q);
  }

  log(): LogEntry[] {
    return readLog(this);
  }

  revertEntry(actor: Actor, seq: number): void {
    this.history.revert(actor, seq);
  }

  working(): Record<string, Actor> {
    return this.ydoc.getMap<Actor>('working').toJSON() as Record<string, Actor>;
  }

  artboardOf(nodeId: string): string | null {
    return ops.artboardOf(this, nodeId);
  }

  /** Runs fn in one transaction whose origin is the actor; a non-null summary appends a log entry. */
  protected mutate<T>(actor: Actor, summary: string | null, fn: () => T): T {
    // Inside a batch, the batch owns the transaction and the single log entry.
    if (this.batchDepth > 0) return fn();
    let result!: T;
    this.ydoc.transact(() => {
      result = fn();
      if (summary !== null) this.history.tag(appendEntry(this, actor, summary));
    }, actor);
    return result;
  }

  /** Runs several operations as one transaction: one log entry, one undo step. */
  batch<T>(actor: Actor, summary: string, fn: () => T): T {
    if (this.batchDepth > 0) return fn();
    let result!: T;
    this.ydoc.transact(() => {
      this.batchDepth++;
      try {
        result = fn();
      } finally {
        this.batchDepth--;
      }
      this.history.tag(appendEntry(this, actor, summary));
    }, actor);
    return result;
  }

  setFlags(actor: Actor, ids: string[], flags: { hidden?: boolean; locked?: boolean }, summary?: string): void {
    this.mutate(actor, summary ?? `Changed visibility or lock on ${plural(ids.length, 'node')}`, () => {
      for (const id of ids) {
        const node = this.yNode(id);
        if (flags.hidden !== undefined) node.set('hidden', flags.hidden);
        if (flags.locked !== undefined) node.set('locked', flags.locked);
      }
    });
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

function countSpecs(specs: NodeSpec[]): number {
  return specs.reduce((n, s) => n + 1 + countSpecs(s.children ?? []), 0);
}
