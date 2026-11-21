import { MarkupDoc, MarkupLibrary } from '@markup/doc';
import * as Y from 'yjs';
import { cloneDoc, Workspace } from '../src/workspace/Workspace';

/** A Workspace whose files live in memory: stored as encoded Yjs state like IndexedDB would. */
export function memoryWorkspace(
  opts: {
    touchDelayMs?: number;
    captureThumbnail?: (fileId: string) => Promise<string | undefined> | undefined;
    /** Awaited before a stored file loads, to control the order loads finish in. */
    beforeOpen?: (fileId: string) => Promise<void>;
  } = {},
) {
  const library = new MarkupLibrary();
  const store = new Map<string, Uint8Array>();
  const opened: string[] = [];
  const released: string[] = [];
  const save = (doc: MarkupDoc) => {
    store.set(doc.fileId, Y.encodeStateAsUpdate(doc.ydoc));
    doc.ydoc.on('update', () => store.set(doc.fileId, Y.encodeStateAsUpdate(doc.ydoc)));
  };
  const workspace = new Workspace({
    library,
    async openDoc(fileId) {
      await opts.beforeOpen?.(fileId);
      const state = store.get(fileId);
      if (!state) throw new Error(`no stored file ${fileId}`);
      opened.push(fileId);
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, state);
      const doc = new MarkupDoc({ ydoc });
      save(doc);
      return doc;
    },
    async createDoc(name, cloneOf) {
      const doc = cloneOf ? cloneDoc(cloneOf, name) : new MarkupDoc({ name });
      save(doc);
      return doc;
    },
    releaseDoc: (doc) => released.push(doc.fileId),
    touchDelayMs: opts.touchDelayMs,
    captureThumbnail: opts.captureThumbnail,
  });
  /** Adds a stored file to the library, as if the user had made it earlier. */
  const addFile = (name: string, parentId?: string) => {
    const doc = new MarkupDoc({ name });
    save(doc);
    library.addFile({ id: doc.fileId, name, parentId });
    return doc.fileId;
  };
  return { workspace, library, store, opened, released, addFile };
}
