import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { MarkupDoc, MarkupError, MarkupLibrary } from '@markup/doc';
import { cloneDoc, Workspace, type WorkspaceOptions } from './Workspace';

const LIBRARY_DB = 'markup:library';
/** The single file of the foundation release, before the library existed. */
const LAST_KEY = 'markup:last';
const TABS_KEY = 'markup:tabs';
const dbName = (fileId: string) => `markup:${fileId}`;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private window): tabs are just not restored next time.
  }
}

/**
 * Adds the foundation's single file to the library on first run. Idempotent: a file already
 * in the library (archived or not) is left alone, and an id with nothing stored is skipped.
 */
export async function importFoundationFile(library: MarkupLibrary, opts: { lastFileId: string | null; readName(fileId: string): Promise<string | null> }): Promise<void> {
  const id = opts.lastFileId;
  if (!id || library.get(id)) return;
  const name = await opts.readName(id);
  if (name === null || library.get(id)) return;
  library.addFile({ id, name });
}

/** Opens a stored ydoc, synced, or returns null when nothing is stored under the id. */
async function loadStored(fileId: string): Promise<{ ydoc: Y.Doc; persistence: IndexeddbPersistence } | null> {
  const ydoc = new Y.Doc();
  const persistence = new IndexeddbPersistence(dbName(fileId), ydoc);
  await persistence.whenSynced;
  if (ydoc.getMap('meta').get('fileId') === fileId) return { ydoc, persistence };
  await persistence.destroy();
  return null;
}

/** A stored file's full Yjs state, or null when nothing is stored under the id. For cloud backup. */
export async function readStoredState(fileId: string): Promise<Uint8Array | null> {
  const stored = await loadStored(fileId);
  if (!stored) return null;
  const state = Y.encodeStateAsUpdate(stored.ydoc);
  await stored.persistence.destroy();
  return state;
}

/**
 * Merges a state (from the cloud) into the stored file, creating it when absent. Closing the
 * database waits for the write, so the next open sees it.
 */
export async function mergeStoredState(fileId: string, update: Uint8Array): Promise<void> {
  // Checked on a scratch doc first, so a state that is not this file never reaches storage.
  const check = new Y.Doc();
  Y.applyUpdate(check, update);
  const matches = check.getMap('meta').get('fileId') === fileId;
  check.destroy();
  if (!matches) throw new MarkupError('INVALID_ARGUMENT', `The cloud copy of ${fileId} is not that file.`);
  const ydoc = new Y.Doc();
  const persistence = new IndexeddbPersistence(dbName(fileId), ydoc);
  await persistence.whenSynced;
  Y.applyUpdate(ydoc, update, 'cloud');
  await persistence.destroy();
}

/** The local workspace: library and files in IndexedDB. */
export async function openLocalWorkspace(opts: Pick<WorkspaceOptions, 'captureThumbnail'> = {}): Promise<Workspace> {
  const libraryDoc = new Y.Doc();
  const libraryStore = new IndexeddbPersistence(LIBRARY_DB, libraryDoc);
  await libraryStore.whenSynced;
  const library = new MarkupLibrary(libraryDoc);

  await importFoundationFile(library, {
    lastFileId: readStorage(LAST_KEY),
    async readName(fileId) {
      const stored = await loadStored(fileId);
      if (!stored) return null;
      const name = (stored.ydoc.getMap('meta').get('name') as string | undefined) ?? 'Untitled';
      await stored.persistence.destroy();
      return name;
    },
  });

  const stores = new Map<MarkupDoc, IndexeddbPersistence>();
  const workspace = new Workspace({
    library,
    async openDoc(fileId) {
      const stored = await loadStored(fileId);
      if (!stored) throw new MarkupError('INVALID_ARGUMENT', `File ${fileId} has no stored content on this device.`);
      // Wrap only after the sync, so an existing file never gets a second seeded page.
      const doc = new MarkupDoc({ ydoc: stored.ydoc });
      stores.set(doc, stored.persistence);
      return doc;
    },
    async createDoc(name, cloneOf) {
      const doc = cloneOf ? cloneDoc(cloneOf, name) : new MarkupDoc({ name });
      const persistence = new IndexeddbPersistence(dbName(doc.fileId), doc.ydoc);
      await persistence.whenSynced;
      stores.set(doc, persistence);
      return doc;
    },
    releaseDoc(doc) {
      const persistence = stores.get(doc);
      stores.delete(doc);
      void persistence?.destroy();
    },
    captureThumbnail: opts.captureThumbnail,
  });
  return workspace;
}

/** Open tabs survive a reload. */
export function saveTabs(workspace: Workspace) {
  writeStorage(TABS_KEY, JSON.stringify({ open: workspace.tabs().map((t) => t.fileId), active: workspace.activeFileId() }));
}

/**
 * Reopens the saved tabs. Resolves once the tab in front is open, so the app can render; the
 * others keep loading in the background, in their saved places, until `done` settles.
 */
export async function restoreTabs(workspace: Workspace): Promise<{ done: Promise<void> }> {
  let saved: { open?: unknown; active?: unknown } = {};
  try {
    saved = JSON.parse(readStorage(TABS_KEY) ?? '{}') as typeof saved;
  } catch {
    return { done: Promise.resolve() };
  }
  const ids = Array.isArray(saved.open) ? saved.open.filter((id): id is string => typeof id === 'string') : [];
  // First run after the foundation: reopen its file so nothing seems lost.
  if (!readStorage(TABS_KEY)) {
    const last = readStorage(LAST_KEY);
    if (last && workspace.library.get(last)) ids.push(last);
  }
  const restorable = ids.filter((id) => {
    const item = workspace.library.get(id);
    return item && !item.archived;
  });
  return workspace.restore(restorable, typeof saved.active === 'string' ? saved.active : undefined);
}
