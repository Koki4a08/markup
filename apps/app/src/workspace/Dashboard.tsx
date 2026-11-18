import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { LibraryItem } from '@markup/doc';
import { icons } from '../panels/icons';
import { useLibraryItems, useWorkspace } from './WorkspaceProvider';

type View = { kind: 'folder'; id: string | null } | { kind: 'archive' };

interface Menu {
  item: LibraryItem;
  x: number;
  y: number;
  moving: boolean;
}

const byKindThenRecent = (a: LibraryItem, b: LibraryItem) => (a.type === b.type ? b.updatedAt - a.updatedAt : a.type === 'folder' ? -1 : 1);

/** Folders on the left, the files of the chosen folder (or search results, or the archive) on the right. */
export function Dashboard({ onOpened }: { onOpened(): void }) {
  const { workspace } = useWorkspace();
  const { library } = workspace;
  const items = useLibraryItems();
  const [view, setView] = useState<View>({ kind: 'folder', id: null });
  const [query, setQuery] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const folders = useMemo(() => items.filter((i) => i.type === 'folder' && !i.archived), [items]);

  // A folder that was archived elsewhere (an agent, another view) is no place to stay in.
  const currentFolder = view.kind === 'folder' && view.id ? byId.get(view.id) : undefined;
  useEffect(() => {
    if (view.kind === 'folder' && view.id && (!currentFolder || currentFolder.archived)) setView({ kind: 'folder', id: null });
  }, [view, currentFolder]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => {
    const inArchive = view.kind === 'archive';
    let list: LibraryItem[];
    if (q) list = items.filter((i) => i.archived === inArchive && i.name.toLowerCase().includes(q));
    else if (inArchive) list = items.filter((i) => i.archived && !(i.parentId && byId.get(i.parentId)?.archived));
    else list = items.filter((i) => !i.archived && i.parentId === view.id);
    return list.sort(byKindThenRecent);
  }, [items, byId, view, q]);

  const run = async (action: () => unknown) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openItem = (item: LibraryItem) => {
    setMenu(null);
    if (item.type === 'folder') {
      if (item.archived) return;
      setQuery('');
      setView({ kind: 'folder', id: item.id });
      return;
    }
    void run(async () => {
      await workspace.open(item.id);
      onOpened();
    });
  };

  const parentForNew = view.kind === 'folder' && !q ? (view.id ?? undefined) : undefined;

  const newFile = () =>
    run(async () => {
      const created = await workspace.createFile({ parentId: parentForNew });
      await workspace.open(created.id);
      onOpened();
    });

  const newFolder = () =>
    run(() => {
      const folder = library.createFolder({ parentId: parentForNew });
      setQuery('');
      setRenamingId(folder.id);
    });

  const path = useMemo(() => {
    const out: LibraryItem[] = [];
    for (let id = view.kind === 'folder' ? view.id : null; id; id = byId.get(id)?.parentId ?? null) {
      const f = byId.get(id);
      if (!f || out.includes(f)) break;
      out.unshift(f);
    }
    return out;
  }, [view, byId]);

  const title = q ? `Results for “${query.trim()}”` : view.kind === 'archive' ? 'Archive' : (path.at(-1)?.name ?? 'All files');
  const empty = q
    ? `Nothing ${view.kind === 'archive' ? 'archived ' : ''}matches “${query.trim()}”.`
    : view.kind === 'archive'
      ? 'Nothing archived. Archived files and folders appear here.'
      : view.id
        ? 'This folder is empty. Create a file here, or move one in from its menu.'
        : 'No files yet. Create one with New file.';

  return (
    <div className="dashboard">
      <aside className="panel dashboard-nav" aria-label="Folders">
        <div className="panel-heading">Files</div>
        <button className={`row ${view.kind === 'folder' && view.id === null && !q ? 'is-active' : ''}`} onClick={() => (setQuery(''), setView({ kind: 'folder', id: null }))}>
          <span className="row-icon">{icons.home}</span>
          <span className="row-name">All files</span>
        </button>
        <FolderTree folders={folders} parentId={null} depth={0} activeId={view.kind === 'folder' && !q ? view.id : null} onPick={(id) => (setQuery(''), setView({ kind: 'folder', id }))} />
        <button className={`row dashboard-archive ${view.kind === 'archive' && !q ? 'is-active' : ''}`} onClick={() => (setQuery(''), setView({ kind: 'archive' }))}>
          <span className="row-icon">{icons.archive}</span>
          <span className="row-name">Archive</span>
        </button>
      </aside>

      <section className="dashboard-main" aria-label={title}>
        <header className="dashboard-head">
          <h1 className="dashboard-title">
            {!q && path.length > 1 ? (
              <>
                {path.slice(0, -1).map((f) => (
                  <span key={f.id}>
                    <button className="crumb" onClick={() => setView({ kind: 'folder', id: f.id })}>
                      {f.name}
                    </button>
                    <span className="crumb-sep" aria-hidden>
                      /
                    </span>
                  </span>
                ))}
                {title}
              </>
            ) : (
              title
            )}
          </h1>
          <label className="search">
            <span className="row-icon">{icons.search}</span>
            <span className="sr-only">Search all folders</span>
            <input type="search" placeholder="Search all folders" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="text-button" onClick={() => void newFolder()}>
            New folder
          </button>
          <button className="primary-button" onClick={() => void newFile()}>
            {icons.plus}
            New file
          </button>
        </header>

        {error && (
          <p className="dashboard-error" role="alert">
            {error}
          </p>
        )}

        {shown.length === 0 ? (
          <p className="empty-hint">{empty}</p>
        ) : (
          <ul className="file-grid">
            {shown.map((item) => (
              <li key={item.id}>
                <Card
                  item={item}
                  location={q ? locationOf(item, byId) : null}
                  renaming={renamingId === item.id}
                  onOpen={() => openItem(item)}
                  onRename={(name) => {
                    setRenamingId(null);
                    void run(() => workspace.rename(item.id, name));
                  }}
                  onCancelRename={() => setRenamingId(null)}
                  onStartRename={() => setRenamingId(item.id)}
                  onMenu={(x, y) => setMenu({ item, x, y, moving: false })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {menu && (
        <ContextMenu
          menu={menu}
          folders={folders.filter((f) => f.id !== menu.item.parentId && !isInside(f, menu.item.id, byId))}
          onClose={() => setMenu(null)}
          onOpen={() => openItem(menu.item)}
          onRename={() => {
            setMenu(null);
            setRenamingId(menu.item.id);
          }}
          onMoving={() => setMenu({ ...menu, moving: true })}
          onMove={(folderId) => {
            setMenu(null);
            void run(() => library.move([menu.item.id], folderId));
          }}
          onArchive={() => {
            setMenu(null);
            void run(() => (menu.item.archived ? library.unarchive([menu.item.id]) : library.archive([menu.item.id])));
          }}
        />
      )}
    </div>
  );
}

/** True when folder is item itself or sits somewhere inside it. */
function isInside(folder: LibraryItem, itemId: string, byId: Map<string, LibraryItem>): boolean {
  const seen = new Set<string>();
  for (let id: string | null = folder.id; id && !seen.has(id); id = byId.get(id)?.parentId ?? null) {
    if (id === itemId) return true;
    seen.add(id);
  }
  return false;
}

function locationOf(item: LibraryItem, byId: Map<string, LibraryItem>): string {
  return item.parentId ? (byId.get(item.parentId)?.name ?? 'All files') : 'All files';
}

function FolderTree({ folders, parentId, depth, activeId, onPick }: { folders: LibraryItem[]; parentId: string | null; depth: number; activeId: string | null; onPick(id: string): void }) {
  const children = folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
  if (!children.length || depth > 32) return null;
  return (
    <ul className="folder-tree">
      {children.map((f) => (
        <li key={f.id}>
          <button className={`row ${activeId === f.id ? 'is-active' : ''}`} style={{ paddingLeft: 12 + depth * 14 }} onClick={() => onPick(f.id)}>
            <span className="row-icon">{icons.folder}</span>
            <span className="row-name">{f.name}</span>
          </button>
          <FolderTree folders={folders} parentId={f.id} depth={depth + 1} activeId={activeId} onPick={onPick} />
        </li>
      ))}
    </ul>
  );
}

function Card({
  item,
  location,
  renaming,
  onOpen,
  onRename,
  onCancelRename,
  onStartRename,
  onMenu,
}: {
  item: LibraryItem;
  location: string | null;
  renaming: boolean;
  onOpen(): void;
  onRename(name: string): void;
  onCancelRename(): void;
  onStartRename(): void;
  onMenu(x: number, y: number): void;
}) {
  const done = useRef(false);
  useEffect(() => {
    if (renaming) done.current = false;
  }, [renaming]);
  const commit = (value: string) => {
    if (done.current) return;
    done.current = true;
    onRename(value);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'F2') {
      e.preventDefault();
      onStartRename();
    }
  };
  return (
    <div
      className={`file-card ${item.type === 'folder' ? 'is-folder' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
    >
      <button className="file-card-open" onClick={onOpen} onKeyDown={onKey} aria-label={`Open ${item.name}`} disabled={item.type === 'folder' && item.archived}>
        <span className="file-thumb">{item.thumbnail ? <img src={item.thumbnail} alt="" /> : item.type === 'folder' ? icons.folder : icons.file}</span>
      </button>
      <div className="file-card-meta">
        {renaming ? (
          <input
            className="rename-input"
            defaultValue={item.name}
            aria-label="Name"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value);
              if (e.key === 'Escape') {
                done.current = true;
                onCancelRename();
              }
            }}
            onBlur={(e) => commit(e.currentTarget.value)}
          />
        ) : (
          <span className="file-card-name" title={item.name}>
            {item.name}
          </span>
        )}
        <span className="file-card-sub">{location ?? formatWhen(item.updatedAt)}</span>
      </div>
      <button
        className="icon-button file-card-more"
        aria-label={`More actions for ${item.name}`}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.right, r.bottom);
        }}
      >
        {icons.more}
      </button>
    </div>
  );
}

function formatWhen(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return 'Edited just now';
  if (minutes < 60) return `Edited ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Edited ${hours} h ago`;
  return `Edited ${new Date(ms).toLocaleDateString()}`;
}

function ContextMenu({
  menu,
  folders,
  onClose,
  onOpen,
  onRename,
  onMoving,
  onMove,
  onArchive,
}: {
  menu: Menu;
  folders: LibraryItem[];
  onClose(): void;
  onOpen(): void;
  onRename(): void;
  onMoving(): void;
  onMove(folderId: string): void;
  onArchive(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [menu.moving]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const { item } = menu;
  const left = Math.min(menu.x || 240, window.innerWidth - 220);
  const top = Math.min(menu.y || 120, window.innerHeight - 240);
  return (
    <div ref={ref} className="context-menu" role="menu" aria-label={`${item.name} actions`} style={{ left, top }}>
      {menu.moving ? (
        <>
          <div className="context-menu-label">Move to</div>
          {folders.length === 0 ? (
            <p className="empty-hint">No other folders. Create one with New folder.</p>
          ) : (
            folders.map((f) => (
              <button key={f.id} role="menuitem" className="row" onClick={() => onMove(f.id)}>
                <span className="row-icon">{icons.folder}</span>
                <span className="row-name">{f.name}</span>
              </button>
            ))
          )}
        </>
      ) : (
        <>
          {!(item.type === 'folder' && item.archived) && (
            <button role="menuitem" className="row" onClick={onOpen}>
              Open
            </button>
          )}
          <button role="menuitem" className="row" onClick={onRename}>
            Rename
          </button>
          {!item.archived && (
            <button role="menuitem" className="row" onClick={onMoving}>
              Move to…
            </button>
          )}
          <button role="menuitem" className="row" onClick={onArchive}>
            {item.archived ? 'Unarchive' : 'Archive'}
          </button>
        </>
      )}
    </div>
  );
}
