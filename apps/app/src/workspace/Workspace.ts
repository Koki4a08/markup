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
  /** Image data URL of the file's first artboard, when its editor is on screen. Called synchronously on close. */
  captureThumbnail?(fileId: string): Promise<string | undefined> | undefined;
  /** Debounce for library updatedAt after doc edits. Default 2 s. */
  touchDelayMs?: number;
}

interface OpenTab {
  doc: MarkupDoc;
  pageId: string;
  unsubscribe(): void;
  touchTimer: ReturnType<typeof setTimeout> | null;
  /** Editor state kept while the tab is open; see tabState. */
  state: Map<string, { value: unknown; dispose?: (value: unknown) => void }>;
}

function disposeState(tab: OpenTab): void {
  for (const { value, dispose } of tab.state.values()) dispose?.(value);
  tab.state.clear();
}

export const fileUrl = (fileId: string) => `markup://file/${fileId}`;

/** The error for any agent call into an archived file. */
export const archivedFileError = (fileId: string) =>
  new MarkupError('FILE_NOT_OPEN', `File ${fileId} is archived, so it cannot be opened or edited. Call unarchive_resources with its ID first.`);

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
  /** Files loading through restore(): they open without coming to the front. */
  private readonly background = new Set<string>();
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly revealListeners = new Set<(fileId: string) => void>();

  constructor(opts: WorkspaceOptions) {
    this.opts = opts;
    this.library = opts.library;
    this.library.ydoc.on('update', this.closeArchived);
  }

  /** Archiving a file (from the dashboard or an agent's archive_resources) closes its tab. */
  private readonly closeArchived = () => {
    for (const fileId of [...this.order]) if (this.library.get(fileId)?.archived) this.close(fileId);
  };

  isArchived(fileId: string): boolean {
    return this.library.get(fileId)?.archived === true;
  }

  tabs(): Tab[] {
    return this.order.map((fileId) => ({ fileId, name: this.library.get(fileId)?.name ?? this.openTabs.get(fileId)!.doc.name, active: fileId === this.active }));
  }

  /**
   * Opens a file as a tab and brings it to the foreground, emitting 'reveal' every time so the
   * UI shows its editor even when it was already the active tab. pageId applies only when the
   * file was not open yet.
   */
  async open(fileId: string, pageId?: string): Promise<MarkupDoc> {
    const existing = this.openTabs.get(fileId);
    // Joining a restore() load: that load leaves the tab in the back, but an explicit open brings it forward.
    const joinsBackground = !existing && this.background.has(fileId);
    let doc: MarkupDoc;
    if (existing) {
      this.activate(fileId);
      doc = existing.doc;
    } else {
      let pending = this.opening.get(fileId);
      if (!pending) {
        pending = this.load(fileId, pageId).finally(() => this.opening.delete(fileId));
        this.opening.set(fileId, pending);
      }
      doc = await pending;
      if (joinsBackground && this.openTabs.get(fileId)?.doc === doc) this.activate(fileId);
    }
    // Skip the reveal if the tab was closed while it was opening.
    if (this.openTabs.get(fileId)?.doc === doc) for (const fn of [...this.revealListeners]) fn(fileId);
    return doc;
  }

  close(fileId: string): void {
    const tab = this.openTabs.get(fileId);
    if (!tab) return;
    // First, so a library update fired from in here (touch) cannot close the tab twice.
    this.openTabs.delete(fileId);
    this.refreshThumbnail(fileId);
    tab.unsubscribe();
    disposeState(tab);
    if (tab.touchTimer) {
      clearTimeout(tab.touchTimer);
      if (this.library.get(fileId)) this.library.touch(fileId);
    }
    const index = this.order.indexOf(fileId);
    this.order.splice(index, 1);
    if (this.active === fileId) this.active = this.order[index] ?? this.order[index - 1] ?? null;
    this.opts.releaseDoc?.(tab.doc);
    this.emit();
  }

  activate(fileId: string): void {
    if (!this.openTabs.has(fileId)) throw new MarkupError('INVALID_ARGUMENT', `File ${fileId} is not open.`);
    if (this.active === fileId) return;
    // The tab going to the background is still on screen: its card on the dashboard catches up now.
    if (this.active) this.refreshThumbnail(this.active);
    this.active = fileId;
    this.emit();
  }

  /**
   * Captures the file's dashboard image from its editor, when that editor is the one on screen. The
   * image is taken at once, so the editor may close or go to the background right after.
   */
  refreshThumbnail(fileId: string): void {
    const capture = fileId === this.active ? this.opts.captureThumbnail?.(fileId) : undefined;
    if (!capture) return;
    void capture
      .then((thumbnail) => {
        if (thumbnail && this.library.get(fileId)) this.library.setThumbnail(fileId, thumbnail);
      })
      .catch(() => {
        // A missing thumbnail only leaves the dashboard card blank.
      });
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

  /**
   * State the editor keeps per open tab so switching tabs or visiting the dashboard does not lose it
   * (undo history, viewport, selection). Made by create on first use; dispose runs when the tab closes.
   */
  tabState<T>(fileId: string, key: string, create: () => T, dispose?: (value: T) => void): T {
    const tab = this.openTabs.get(fileId);
    if (!tab) throw new MarkupError('INVALID_ARGUMENT', `File ${fileId} is not open.`);
    let entry = tab.state.get(key);
    if (!entry) {
      entry = { value: create(), dispose: dispose as ((value: unknown) => void) | undefined };
      tab.state.set(key, entry);
    }
    return entry.value as T;
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

  /** 'change': tabs, names or the active tab changed. 'reveal': a file was asked to come to the foreground. */
  on(event: 'change', fn: () => void): () => void;
  on(event: 'reveal', fn: (fileId: string) => void): () => void;
  on(event: 'change' | 'reveal', fn: (fileId: string) => void): () => void {
    const set: Set<(fileId: string) => void> = event === 'reveal' ? this.revealListeners : this.listeners;
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Reopens the tabs of an earlier session in the order given. Only the tab to show first is awaited:
   * activeId when it is in ids, else the last id (the one opening them in turn would leave in front).
   * The others load in parallel in the background and take their place in that order without coming
   * to the front; `done` settles once they all have. If the first one fails to open, everything is
   * awaited and the last tab that opened comes to the front, as opening them in turn would do.
   */
  async restore(ids: string[], activeId?: string): Promise<{ done: Promise<void> }> {
    const unique = [...new Set(ids)];
    if (!unique.length) return { done: Promise.resolve() };
    const first = activeId !== undefined && unique.includes(activeId) ? activeId : unique[unique.length - 1]!;
    const rank = new Map(unique.map((id, i) => [id, i]));
    const opened = await this.open(first).then(
      () => true,
      () => false,
    );
    const rest = unique.filter((id) => id !== first);
    // Only when the first tab failed: otherwise active is null because the user closed tabs meanwhile,
    // and the dashboard they are on must stay.
    const done = Promise.all(rest.map((id) => this.loadInBackground(id, rank).catch(() => undefined))).then(() => {
      if (!opened && !this.disposed && this.active === null && this.order.length) this.activate(this.order[this.order.length - 1]!);
    });
    if (!opened) await done;
    return { done };
  }

  private loadInBackground(fileId: string, rank: Map<string, number>): Promise<unknown> {
    if (this.disposed || this.openTabs.has(fileId)) return Promise.resolve();
    let pending = this.opening.get(fileId);
    if (!pending) {
      this.background.add(fileId);
      pending = this.load(fileId, undefined, rank).finally(() => {
        this.opening.delete(fileId);
        this.background.delete(fileId);
      });
      this.opening.set(fileId, pending);
    }
    return pending;
  }

  /** Releases every open doc without notifying listeners; for teardown. */
  dispose(): void {
    this.disposed = true;
    this.library.ydoc.off('update', this.closeArchived);
    for (const fileId of [...this.order]) {
      const tab = this.openTabs.get(fileId)!;
      tab.unsubscribe();
      disposeState(tab);
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

  /** rank: a restore() load, placed by that order and left in the back. */
  private async load(fileId: string, pageId?: string, rank?: Map<string, number>): Promise<MarkupDoc> {
    const item = this.requireFile(fileId);
    if (item.archived) throw archivedFileError(fileId);
    const doc = await this.opts.openDoc(fileId);
    if (rank && this.disposed) {
      this.opts.releaseDoc?.(doc);
      throw new MarkupError('INVALID_ARGUMENT', 'The workspace was closed.');
    }
    if (this.isArchived(fileId)) {
      this.opts.releaseDoc?.(doc);
      throw archivedFileError(fileId);
    }
    if (pageId !== undefined && !doc.pages().some((p) => p.type === 'page' && p.id === pageId)) {
      this.opts.releaseDoc?.(doc);
      throw new MarkupError('PAGE_NOT_FOUND', `Page ${pageId} does not exist in ${item.name}.`);
    }
    // Indicators persist in the file; any left from an earlier session belong to agents that are gone.
    doc.clearWorking();
    if (doc.name !== item.name) doc.name = item.name;
    const tab: OpenTab = { doc, pageId: pageId ?? firstPageId(doc), touchTimer: null, unsubscribe: () => {}, state: new Map() };
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
    if (rank) {
      // Before the first tab that comes later in the restored order, or that the restore did not open.
      const mine = rank.get(fileId)!;
      const at = this.order.findIndex((id) => (rank.get(id) ?? Number.POSITIVE_INFINITY) > mine);
      this.order.splice(at < 0 ? this.order.length : at, 0, fileId);
    } else {
      this.order.push(fileId);
      this.active = fileId;
    }
    this.emit();
    return doc;
  }

  private emit() {
    for (const fn of [...this.listeners]) fn();
  }
}
