import * as Y from 'yjs';
import { MarkupDoc, MarkupError, type LibraryItem, type MarkupLibrary } from '@markup/doc';

export interface Tab {
  fileId: string;
  name: string;
  active: boolean;
}

export interface WorkspaceOptions {
  library: MarkupLibrary;
  /** Loads a stored file. The ydoc must be synced before it is wrapped in a MarkupDoc. */
  openDoc(fileId: string): Promise<MarkupDoc>;
  /** Makes and stores a new file, as a copy of cloneOf when given. */
  createDoc(name: string, cloneOf?: MarkupDoc): Promise<MarkupDoc>;
  /** Called once the workspace stops using a doc it got from openDoc/createDoc. */
  releaseDoc?(doc: MarkupDoc): void;
  /** PNG data URL of the file's first artboard, when its editor is on screen. Called synchronously on close. */
  captureThumbnail?(fileId: string): Promise<string | undefined> | undefined;
  /** Debounce for library updatedAt after doc edits. Default 2 s. */
  touchDelayMs?: number;
}

interface OpenTab {
  doc: MarkupDoc;
  pageId: string;
  unsubscribe(): void;
  touchTimer: ReturnType<typeof setTimeout> | null;
}

export const fileUrl = (fileId: string) => `markup://file/${fileId}`;

const firstPageId = (doc: MarkupDoc) => doc.pages().find((p) => p.type === 'page')!.id;

/** A copy of a file under a new id and name, with its pages, nodes and tokens but none of its history. */
export function cloneDoc(source: MarkupDoc, name: string): MarkupDoc {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source.ydoc));
  ydoc.transact(() => {
    const meta = ydoc.getMap('meta');
    meta.set('fileId', newFileId());
    meta.set('name', name);
    const log = ydoc.getArray('log');
    log.delete(0, log.length);
    const working = ydoc.getMap('working');
    for (const key of [...working.keys()]) working.delete(key);
  });
  return new MarkupDoc({ ydoc });
}

function newFileId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** The files open as tabs in this window, on top of the local file library. */
export class Workspace {
  readonly library: MarkupLibrary;
  private readonly opts: WorkspaceOptions;
  private readonly openTabs = new Map<string, OpenTab>();
  private readonly opening = new Map<string, Promise<MarkupDoc>>();
  private order: string[] = [];
  private active: string | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(opts: WorkspaceOptions) {
    this.opts = opts;
    this.library = opts.library;
  }

  tabs(): Tab[] {
    return this.order.map((fileId) => ({ fileId, name: this.library.get(fileId)?.name ?? this.openTabs.get(fileId)!.doc.name, active: fileId === this.active }));
  }

  /** Opens a file as a tab and brings it to the foreground. pageId applies only when the file was not open yet. */
  open(fileId: string, pageId?: string): Promise<MarkupDoc> {
    const existing = this.openTabs.get(fileId);
    if (existing) {
      this.activate(fileId);
      return Promise.resolve(existing.doc);
    }
    let pending = this.opening.get(fileId);
    if (!pending) {
      pending = this.load(fileId, pageId).finally(() => this.opening.delete(fileId));
      this.opening.set(fileId, pending);
    }
    return pending;
  }

  close(fileId: string): void {
    const tab = this.openTabs.get(fileId);
    if (!tab) return;
    const capture = fileId === this.active ? this.opts.captureThumbnail?.(fileId) : undefined;
    if (capture) {
      void capture
        .then((thumbnail) => {
          if (thumbnail && this.library.get(fileId)) this.library.touch(fileId, { thumbnail });
        })
        .catch(() => {
          // A missing thumbnail only leaves the dashboard card blank.
        });
    }
    tab.unsubscribe();
    if (tab.touchTimer) {
      clearTimeout(tab.touchTimer);
      if (this.library.get(fileId)) this.library.touch(fileId);
    }
    const index = this.order.indexOf(fileId);
    this.order.splice(index, 1);
    this.openTabs.delete(fileId);
    if (this.active === fileId) this.active = this.order[index] ?? this.order[index - 1] ?? null;
    this.opts.releaseDoc?.(tab.doc);
    this.emit();
  }

  activate(fileId: string): void {
    if (!this.openTabs.has(fileId)) throw new MarkupError('INVALID_ARGUMENT', `File ${fileId} is not open.`);
    if (this.active === fileId) return;
    this.active = fileId;
    this.emit();
  }

  doc(fileId: string): MarkupDoc | undefined {
    return this.openTabs.get(fileId)?.doc;
  }

  activeFileId(): string | null {
    return this.active;
  }

  activeDoc(): MarkupDoc | undefined {
    return this.active ? this.doc(this.active) : undefined;
  }

  /** The page the tab shows. */
  activePageId(fileId: string): string {
    const tab = this.openTabs.get(fileId);
    if (!tab) throw new MarkupError('INVALID_ARGUMENT', `File ${fileId} is not open.`);
    const pages = tab.doc.pages();
    return pages.some((p) => p.type === 'page' && p.id === tab.pageId) ? tab.pageId : firstPageId(tab.doc);
  }

  setActivePage(fileId: string, pageId: string): void {
    const tab = this.openTabs.get(fileId);
    if (tab) tab.pageId = pageId;
  }

  async createFile(opts: { name?: string; parentId?: string; cloneFileId?: string }): Promise<LibraryItem & { url: string }> {
    if (opts.parentId !== undefined && this.library.get(opts.parentId)?.type !== 'folder') {
      throw new MarkupError('INVALID_ARGUMENT', `Not a folder: ${opts.parentId}. Use list_resources to find folder IDs.`);
    }
    let source: MarkupDoc | undefined;
    let temporary = false;
    if (opts.cloneFileId !== undefined) {
      this.requireFile(opts.cloneFileId);
      source = this.doc(opts.cloneFileId);
      if (!source) {
        source = await this.opts.openDoc(opts.cloneFileId);
        temporary = true;
      }
    }
    try {
      const sourceName = source ? (this.library.get(source.fileId)?.name ?? source.name) : null;
      const name = opts.name?.trim() || (sourceName ? `${sourceName} copy` : 'Untitled');
      const doc = await this.opts.createDoc(name, source);
      const item = this.library.addFile({ id: doc.fileId, name, parentId: opts.parentId });
      this.opts.releaseDoc?.(doc);
      return { ...item, url: fileUrl(item.id) };
    } finally {
      if (temporary && source) this.opts.releaseDoc?.(source);
    }
  }

  /** Renames a file or folder; an open file's doc name and tab follow. */
  rename(id: string, name: string): LibraryItem {
    const item = this.library.rename(id, name);
    const doc = this.doc(id);
    if (doc && doc.name !== item.name) doc.name = item.name;
    this.emit();
    return item;
  }

  on(_event: 'change', fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Releases every open doc without notifying listeners; for teardown. */
  dispose(): void {
    for (const fileId of [...this.order]) {
      const tab = this.openTabs.get(fileId)!;
      tab.unsubscribe();
      if (tab.touchTimer) clearTimeout(tab.touchTimer);
      this.opts.releaseDoc?.(tab.doc);
    }
    this.openTabs.clear();
    this.order = [];
    this.active = null;
  }

  private requireFile(fileId: string): LibraryItem {
    const item = this.library.get(fileId);
    if (!item) throw new MarkupError('INVALID_ARGUMENT', `Unknown file: ${fileId}. Call list_resources to find file IDs.`);
    if (item.type !== 'file') throw new MarkupError('INVALID_ARGUMENT', `${fileId} is a folder, not a file. Call list_resources to find file IDs.`);
    return item;
  }

  private async load(fileId: string, pageId?: string): Promise<MarkupDoc> {
    const item = this.requireFile(fileId);
    const doc = await this.opts.openDoc(fileId);
    if (pageId !== undefined && !doc.pages().some((p) => p.type === 'page' && p.id === pageId)) {
      this.opts.releaseDoc?.(doc);
      throw new MarkupError('PAGE_NOT_FOUND', `Page ${pageId} does not exist in ${item.name}.`);
    }
    // Indicators persist in the file; any left from an earlier session belong to agents that are gone.
    doc.clearWorking();
    if (doc.name !== item.name) doc.name = item.name;
    const tab: OpenTab = { doc, pageId: pageId ?? firstPageId(doc), touchTimer: null, unsubscribe: () => {} };
    const onUpdate = () => {
      if (tab.touchTimer) clearTimeout(tab.touchTimer);
      tab.touchTimer = setTimeout(() => {
        tab.touchTimer = null;
        if (this.library.get(fileId)) this.library.touch(fileId);
      }, this.opts.touchDelayMs ?? 2000);
    };
    doc.ydoc.on('update', onUpdate);
    tab.unsubscribe = () => doc.ydoc.off('update', onUpdate);
    this.openTabs.set(fileId, tab);
    this.order.push(fileId);
    this.active = fileId;
    this.emit();
    return doc;
  }

  private emit() {
    for (const fn of [...this.listeners]) fn();
  }
}
