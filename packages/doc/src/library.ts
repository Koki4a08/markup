import * as Y from 'yjs';
import { MarkupError } from './schema';
import { newId } from './ynode';

export interface LibraryItem {
  id: string;
  type: 'file' | 'folder';
  name: string;
  parentId: string | null;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  thumbnail?: string;
  /** Layer the user chose as the file's thumbnail; captured instead of the first artboard. */
  thumbnailNodeId?: string;
}

const NAME_MAX = 500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_FOLDER_NAME = 'Untitled project';

const cleanName = (name: string | undefined): string => (name ?? '').trim().slice(0, NAME_MAX);

/** Local list of files and folders. Independent of MarkupDoc: owns its own Y.Doc. */
export class MarkupLibrary {
  readonly ydoc: Y.Doc;
  private readonly items: Y.Map<Y.Map<unknown>>;

  constructor(ydoc: Y.Doc = new Y.Doc()) {
    this.ydoc = ydoc;
    this.items = ydoc.getMap<Y.Map<unknown>>('items');
  }

  list(opts: { parentId?: string; includeArchived?: boolean; limit?: number } = {}): {
    items: LibraryItem[];
    truncated?: true;
  } {
    const limit = Math.min(Math.max(Math.floor(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
    const all = this.all()
      .filter((i) => opts.includeArchived || !i.archived)
      .filter((i) => opts.parentId === undefined || i.parentId === opts.parentId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return all.length > limit ? { items: all.slice(0, limit), truncated: true } : { items: all };
  }

  get(id: string): LibraryItem | undefined {
    const m = this.items.get(id);
    return m && toItem(m);
  }

  addFile(opts: { id: string; name: string; parentId?: string | null }): LibraryItem {
    if (this.items.has(opts.id)) throw new MarkupError('INVALID_ARGUMENT', `Item already exists: ${opts.id}`);
    return this.insert('file', opts.id, cleanName(opts.name) || 'Untitled', opts.parentId ?? null);
  }

  createFolder(opts: { name?: string; parentId?: string | null }): LibraryItem {
    return this.insert('folder', newId(), cleanName(opts.name) || DEFAULT_FOLDER_NAME, opts.parentId ?? null);
  }

  rename(id: string, name: string): LibraryItem {
    const m = this.require(id);
    const next = cleanName(name);
    this.ydoc.transact(() => {
      if (next) m.set('name', next);
      m.set('updatedAt', Date.now());
    });
    return toItem(m);
  }

  move(ids: string[], parentId: string): { moved: LibraryItem[]; alreadyThere: LibraryItem[] } {
    const maps = ids.map((id) => this.require(id));
    this.requireFolder(parentId);
    const idSet = new Set(ids);
    for (const id of ids) {
      // A selected item with a selected ancestor folder is redundant and ambiguous.
      for (let p = this.get(id)!.parentId; p; p = this.get(p)?.parentId ?? null) {
        if (idSet.has(p)) {
          throw new MarkupError('INVALID_ARGUMENT', `${id} is inside ${p}, which is also being moved`);
        }
      }
    }
    for (let p: string | null = parentId; p; p = this.get(p)?.parentId ?? null) {
      if (idSet.has(p)) throw new MarkupError('CYCLE', `Cannot move folder ${p} into itself or its descendant`);
    }
    const moved: LibraryItem[] = [];
    const alreadyThere: LibraryItem[] = [];
    const now = Date.now();
    this.ydoc.transact(() => {
      for (const m of maps) {
        if (m.get('parentId') === parentId) {
          alreadyThere.push(toItem(m));
        } else {
          m.set('parentId', parentId);
          m.set('updatedAt', now);
          moved.push(toItem(m));
        }
      }
    });
    return { moved, alreadyThere };
  }

  archive(ids: string[]): LibraryItem[] {
    const maps = ids.map((id) => this.require(id));
    const now = Date.now();
    this.ydoc.transact(() => {
      const mark = (m: Y.Map<unknown>) => {
        if (m.get('archived') !== true) {
          m.set('archived', true);
          m.set('updatedAt', now);
        }
      };
      for (const m of maps) {
        mark(m);
        for (const d of this.descendants(m.get('id') as string)) mark(d);
      }
    });
    return maps.map(toItem);
  }

  unarchive(ids: string[]): (LibraryItem & { parentId: string | null })[] {
    const maps = ids.map((id) => this.require(id));
    const now = Date.now();
    const restoring = new Set<Y.Map<unknown>>();
    for (const m of maps) {
      restoring.add(m);
      for (const d of this.descendants(m.get('id') as string)) restoring.add(d);
    }
    const restoringIds = new Set([...restoring].map((m) => m.get('id') as string));
    this.ydoc.transact(() => {
      for (const m of restoring) {
        const parent = m.get('parentId') as string | null;
        if (parent && !restoringIds.has(parent) && this.items.get(parent)?.get('archived') === true) {
          m.set('parentId', null);
        }
        m.set('archived', false);
        m.set('updatedAt', now);
      }
    });
    return maps.map(toItem);
  }

  /** Bumps updatedAt. thumbnailNodeId: null forgets the chosen layer. */
  touch(id: string, patch?: { thumbnail?: string; thumbnailNodeId?: string | null }): void {
    const m = this.require(id);
    this.ydoc.transact(() => {
      if (patch?.thumbnail !== undefined) m.set('thumbnail', patch.thumbnail);
      if (patch?.thumbnailNodeId === null) m.delete('thumbnailNodeId');
      else if (patch?.thumbnailNodeId !== undefined) m.set('thumbnailNodeId', patch.thumbnailNodeId);
      m.set('updatedAt', Date.now());
    });
  }

  /** Replaces the dashboard image only. Unlike touch, it is not an edit, so updatedAt stays. */
  setThumbnail(id: string, thumbnail: string): void {
    const m = this.require(id);
    if (m.get('thumbnail') !== thumbnail) this.ydoc.transact(() => m.set('thumbnail', thumbnail));
  }

  /** Every item, archived ones included, in no particular order. */
  all(): LibraryItem[] {
    return [...this.items.values()].map(toItem);
  }

  private require(id: string): Y.Map<unknown> {
    const m = this.items.get(id);
    if (!m) throw new MarkupError('INVALID_ARGUMENT', `Unknown library item: ${id}`);
    return m;
  }

  private requireFolder(id: string): Y.Map<unknown> {
    const m = this.require(id);
    if (m.get('type') !== 'folder') throw new MarkupError('INVALID_ARGUMENT', `Not a folder: ${id}`);
    return m;
  }

  private descendants(id: string): Y.Map<unknown>[] {
    const out: Y.Map<unknown>[] = [];
    const queue = [id];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const m of this.items.values()) {
        if (m.get('parentId') === cur) {
          out.push(m);
          queue.push(m.get('id') as string);
        }
      }
    }
    return out;
  }

  private insert(type: LibraryItem['type'], id: string, name: string, parentId: string | null): LibraryItem {
    if (parentId !== null) this.requireFolder(parentId);
    const now = Date.now();
    const m = new Y.Map<unknown>();
    this.ydoc.transact(() => {
      this.items.set(id, m);
      m.set('id', id);
      m.set('type', type);
      m.set('name', name);
      m.set('parentId', parentId);
      m.set('archived', false);
      m.set('createdAt', now);
      m.set('updatedAt', now);
    });
    return toItem(m);
  }
}

function toItem(m: Y.Map<unknown>): LibraryItem {
  const thumbnail = m.get('thumbnail') as string | undefined;
  const thumbnailNodeId = m.get('thumbnailNodeId') as string | undefined;
  return {
    id: m.get('id') as string,
    type: m.get('type') as LibraryItem['type'],
    name: m.get('name') as string,
    parentId: (m.get('parentId') as string | null) ?? null,
    archived: m.get('archived') === true,
    createdAt: m.get('createdAt') as number,
    updatedAt: m.get('updatedAt') as number,
    ...(thumbnail !== undefined ? { thumbnail } : {}),
    ...(thumbnailNodeId !== undefined ? { thumbnailNodeId } : {}),
  };
}
