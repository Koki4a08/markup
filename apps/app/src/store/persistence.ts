import { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';
import { MarkupDoc } from '@markup/doc';

const LAST_KEY = 'markup:last';
const dbName = (fileId: string) => `markup:${fileId}`;

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

function writeLast(fileId: string) {
  try {
    localStorage.setItem(LAST_KEY, fileId);
  } catch {
    // Storage blocked (private window): the file still lives in IndexedDB for this session.
  }
}

/**
 * Opens a file from IndexedDB, or creates one. The ydoc is synced from storage BEFORE
 * MarkupDoc wraps it, so an existing file never gets a second seeded page.
 */
export async function openLocalDoc(fileId: string | null = readLast()): Promise<{ doc: MarkupDoc; persistence: IndexeddbPersistence }> {
  if (fileId) {
    const ydoc = new Y.Doc();
    const persistence = new IndexeddbPersistence(dbName(fileId), ydoc);
    await persistence.whenSynced;
    if (ydoc.getMap('meta').has('fileId')) {
      writeLast(fileId);
      return { doc: new MarkupDoc({ ydoc }), persistence };
    }
    await persistence.destroy();
  }
  const doc = new MarkupDoc({ name: 'Untitled' });
  const persistence = new IndexeddbPersistence(dbName(doc.fileId), doc.ydoc);
  await persistence.whenSynced;
  writeLast(doc.fileId);
  return { doc, persistence };
}
