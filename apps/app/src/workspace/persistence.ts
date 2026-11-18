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

export async function restoreTabs(workspace: Workspace): Promise<void> {
  let saved: { open?: unknown; active?: unknown } = {};
  try {
    saved = JSON.parse(readStorage(TABS_KEY) ?? '{}') as typeof saved;
  } catch {
    return;
  }
  const ids = Array.isArray(saved.open) ? saved.open.filter((id): id is string => typeof id === 'string') : [];
  // First run after the foundation: reopen its file so nothing seems lost.
  if (!readStorage(TABS_KEY)) {
    const last = readStorage(LAST_KEY);
    if (last && workspace.library.get(last)) ids.push(last);
  }
  for (const id of ids) {
    const item = workspace.library.get(id);
    if (!item || item.archived) continue;
    await workspace.open(id).catch(() => undefined);
  }
  if (typeof saved.active === 'string' && workspace.doc(saved.active)) workspace.activate(saved.active);
}
