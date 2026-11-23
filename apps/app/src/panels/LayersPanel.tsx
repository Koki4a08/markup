import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { MarkupNode, Move } from '@markup/doc';
import { icons } from './icons';
import { IdSetStore, useIdIn } from './idSetStore';
import { useDoc } from '../store/DocProvider';
import { useNode, usePages } from '../store/hooks';
import { useSelection } from '../canvas/selection';
import { isFreshFocus, keepEditingAcrossWindowBlur } from '../ui/windowFocus';
import { useDismiss } from '../ui/useDismiss';
import { pageLink } from '@markup/protocol/links';
import { copyText } from '../export/clipboard';

interface Props {
  activePageId: string;
  onPage(id: string): void;
  renamingId: string | null;
  onRenameDone(): void;
  collapseSignal: number;
  /** Right-click on a layer row: open the canvas context menu at this screen point. */
  onContextMenu?(at: { x: number; y: number }): void;
  /** Drag handle on the panel's inner edge. */
  resizer?: ReactNode;
  /** Short status message (Link copied, or why a copy failed). */
  onNotify?(message: string): void;
}

type DropZone = 'before' | 'after' | 'inside';

/**
 * Shared by every row and stable for the panel's lifetime. Selection, collapse and rename state live in
 * per-id stores, so a change re-renders only the rows whose own state flipped, not the whole tree.
 */
interface Tree {
  selected: IdSetStore;
  /** Rows showing their children. Empty at first: a big page lists only its artboards, not every layer. */
  expanded: IdSetStore;
  renaming: IdSetStore;
  toggle(id: string): void;
  /** Pointer down on a row: past a few pixels of movement it becomes a drag that reorders the layer. */
  pointerDown(id: string, e: ReactPointerEvent<HTMLElement>): void;
  /** True right after a drag ended, so the click the browser sends next does not reselect. */
  justDragged(): boolean;
  renameDone(): void;
  getSelection(): string[];
  setSelection(ids: string[]): void;
  contextMenu(at: { x: number; y: number }): void;
}

export const LayersPanel = memo(function LayersPanel({ activePageId, onPage, renamingId, onRenameDone, collapseSignal, onContextMenu, resizer, onNotify }: Props) {
  const { doc, actor } = useDoc();
  const selection = useSelection();
  const pages = usePages();
  const page = pages.find((p) => p.type === 'page' && p.id === activePageId);
  const root = useNode(page && page.type === 'page' ? page.rootId : '');
  const pageCount = pages.filter((p) => p.type === 'page').length;
  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);
  const [pageMenu, setPageMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closePageMenu = useCallback(() => setPageMenu(null), []);
  const deletePage = (id: string) => {
    const list = pages.filter((p) => p.type === 'page');
    if (list.length < 2) return;
    // Leaving the deleted page: open its neighbour (the next one, or the previous at the end of the list).
    if (id === activePageId) {
      const i = list.findIndex((p) => p.id === id);
      onPage((list[i + 1] ?? list[i - 1])!.id);
    }
    doc.deletePage(actor, id);
  };
  const drop = (nodeId: string, targetId: string, zone: DropZone) => {
    if (nodeId === targetId) return;
    const move: Move = zone === 'inside' ? { nodeId, parentId: targetId, index: 0 } : zone === 'before' ? { nodeId, before: targetId } : { nodeId, after: targetId };
    try {
      doc.moveNodes(actor, [move]);
    } catch {
      // Invalid target (a node into its own subtree, or into a text node): ignore the drop.
    }
  };
  // Rows call through these refs, so the tree object (and every memoized row) stays stable across renders.
  const latest = useRef({ drop, onRenameDone, onContextMenu });
  latest.current = { drop, onRenameDone, onContextMenu };
  const drag = useLayerDrag((nodeId, targetId, zone) => latest.current.drop(nodeId, targetId, zone));

  const { get: getSelection, set: setSelection } = selection;
  const [stores] = useState(() => ({
    selected: new IdSetStore(getSelection()),
    expanded: new IdSetStore(),
    renaming: new IdSetStore(renamingId ? [renamingId] : []),
  }));
  const tree = useMemo<Tree>(
    () => ({
      ...stores,
      toggle: (id) => stores.expanded.toggle(id),
      pointerDown: drag.pointerDown,
      justDragged: drag.justDragged,
      renameDone: () => latest.current.onRenameDone(),
      contextMenu: (at) => latest.current.onContextMenu?.(at),
      getSelection,
      setSelection,
    }),
    [stores, getSelection, setSelection, drag],
  );

  useLayoutEffect(() => stores.selected.replace(selection.ids), [stores, selection.ids]);
  // A layer selected on the canvas shows in the tree: its ancestors open (nothing else closes).
  useLayoutEffect(() => {
    const open = new Set(stores.expanded.current());
    const before = open.size;
    const parentOf = (id: string) => (doc.nodes.get(id)?.get('parentId') as string | null | undefined) ?? null;
    for (const id of selection.ids) for (let p = parentOf(id); p; p = parentOf(p)) open.add(p);
    if (open.size !== before) stores.expanded.replace(open);
  }, [stores, selection.ids, doc]);
  useLayoutEffect(() => stores.renaming.replace(renamingId ? [renamingId] : []), [stores, renamingId]);

  useEffect(() => {
    if (collapseSignal === 0) return;
    stores.expanded.replace([]);
  }, [collapseSignal, doc, stores]);

  return (
    <aside className="panel layers-panel" aria-label="Pages and layers">
      {resizer}
      <section className="panel-section">
        <div className="panel-heading">
          <span>Pages</span>
          <button className="icon-button" aria-label="Add page" data-tip="Add page" onClick={() => onPage(doc.createPage(actor))}>
            {icons.plus}
          </button>
        </div>
        <ul className="page-list" role="listbox" aria-label="Pages">
          {pages.map((p) =>
            p.type === 'divider' ? (
              <li key={p.id} className="page-divider" role="separator" />
            ) : (
              <PageRow
                key={p.id}
                id={p.id}
                name={p.name}
                active={p.id === activePageId}
                canDelete={pageCount > 1}
                renaming={renamingPageId === p.id}
                onSelect={() => onPage(p.id)}
                onRename={() => setRenamingPageId(p.id)}
                onRenameEnd={(name) => {
                  setRenamingPageId(null);
                  if (name !== null && name !== p.name) doc.updatePages(actor, [{ pageId: p.id, name }], 'Renamed 1 page');
                }}
                onDelete={() => deletePage(p.id)}
                onMenu={(x, y) => setPageMenu({ id: p.id, x, y })}
              />
            ),
          )}
        </ul>
        {pageMenu && (
          <PageMenu
            x={pageMenu.x}
            y={pageMenu.y}
            canDelete={pageCount > 1}
            onClose={closePageMenu}
            onRename={() => {
              setPageMenu(null);
              setRenamingPageId(pageMenu.id);
            }}
            onCopyLink={() => {
              setPageMenu(null);
              copyText(pageLink(doc.fileId, pageMenu.id)).then(
                () => onNotify?.('Link copied'),
                (err: unknown) => onNotify?.(err instanceof Error ? err.message : 'Could not copy the link'),
              );
            }}
            onDelete={() => {
              setPageMenu(null);
              deletePage(pageMenu.id);
            }}
          />
        )}
      </section>
      <section className="panel-section layers">
        <div className="panel-heading">
          <span>Layers</span>
        </div>
        <ul className="layer-tree" role="tree" aria-label="Layers">
          {root?.children.map((id) => (
              <LayerRow key={id} id={id} depth={0} tree={tree} />
            ))}
          {root && root.children.length === 0 && <li className="empty-hint">Press F and drag on the canvas to draw an artboard.</li>}
        </ul>
      </section>
    </aside>
  );
});

interface PageRowProps {
  id: string;
  name: string;
  active: boolean;
  canDelete: boolean;
  renaming: boolean;
  onSelect(): void;
  onRename(): void;
  /** The new name, or null when the rename was cancelled or left empty. */
  onRenameEnd(name: string | null): void;
  onDelete(): void;
  onMenu(x: number, y: number): void;
}

function PageRow({ id, name, active, canDelete, renaming, onSelect, onRename, onRenameEnd, onDelete, onMenu }: PageRowProps) {
  const done = useRef(false);
  useEffect(() => {
    if (renaming) done.current = false;
  }, [renaming]);
  // Enter, Escape and blur can all fire for one rename: only the first one counts.
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    const trimmed = value?.trim();
    onRenameEnd(trimmed ? trimmed : null);
  };

  return (
    <li role="option" aria-selected={active}>
      <div
        className={`row page-row ${active ? 'is-active' : ''}`}
        data-page-id={id}
        tabIndex={renaming ? -1 : 0}
        onClick={() => !renaming && onSelect()}
        onDoubleClick={onRename}
        onKeyDown={(e) => {
          if (renaming || e.target !== e.currentTarget) return;
          const action =
            e.key === 'Enter' || e.key === ' ' ? onSelect : e.key === 'F2' ? onRename : (e.key === 'Delete' || e.key === 'Backspace') && canDelete ? onDelete : null;
          if (!action) return;
          // Keep handled keys from the editor's shortcuts (Delete would remove the selected layers instead).
          e.preventDefault();
          e.stopPropagation();
          action();
        }}
        onContextMenu={(e) => {
          if (renaming) return;
          e.preventDefault();
          onMenu(e.clientX, e.clientY);
        }}
      >
        <span className="row-icon">{icons.page}</span>
        {renaming ? (
          <input
            className="rename-input"
            defaultValue={name}
            aria-label="Page name"
            autoFocus
            onFocus={(e) => isFreshFocus(e.currentTarget) && e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') finish(e.currentTarget.value);
              if (e.key === 'Escape') finish(null);
            }}
            // Switching to another app keeps the rename open; only a blur inside the app commits it.
            onBlur={(e) => keepEditingAcrossWindowBlur(e.currentTarget) || finish(e.currentTarget.value)}
          />
        ) : (
          <span className="row-name">{name}</span>
        )}
        {canDelete && !renaming && (
          <span className="row-actions">
            <button
              className="icon-button"
              aria-label={`Delete ${name}`}
              data-tip="Delete page"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {icons.trash}
            </button>
          </span>
        )}
      </div>
    </li>
  );
}

function PageMenu({ x, y, canDelete, onClose, onRename, onCopyLink, onDelete }: { x: number; y: number; canDelete: boolean; onClose(): void; onRename(): void; onCopyLink(): void; onDelete(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(onClose, { ref });
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Capture phase, so Escape closes only the menu and never reaches the editor's shortcuts.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="context-menu" role="menu" aria-label="Page actions" style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - 130) }}>
      <button role="menuitem" className="row" onClick={onRename}>
        Rename
      </button>
      <button role="menuitem" className="row" onClick={onCopyLink}>
        Copy link
      </button>
      <button role="menuitem" className="row" disabled={!canDelete} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

interface RowProps {
  id: string;
  depth: number;
  tree: Tree;
}

const typeIcon = (n: MarkupNode) => (n.type === 'text' ? icons.text : n.type === 'image' ? icons.image : n.type === 'svg' ? icons.svg : icons.frame);

const LayerRow = memo(function LayerRow({ id, depth, tree }: RowProps) {
  const { doc, actor } = useDoc();
  const node = useNode(id);
  const selected = useIdIn(tree.selected, id);
  const isExpanded = useIdIn(tree.expanded, id);
  const isRenaming = useIdIn(tree.renaming, id);
  const [editing, setEditing] = useState(false);
  const renaming = editing || isRenaming;
  if (!node) return null;
  const hasChildren = node.children.length > 0;
  const open = hasChildren && isExpanded;

  const commitName = (value: string) => {
    setEditing(false);
    tree.renameDone();
    const name = value.trim();
    if (name && name !== node.name) doc.renameNodes(actor, [{ nodeId: id, name }]);
  };

  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={hasChildren ? open : undefined}>
      <div
        className={`row layer-row ${selected ? 'is-selected' : ''} ${node.hidden ? 'is-hidden' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-layer-id={id}
        data-layer-container={node.type === 'frame' ? '' : undefined}
        onPointerDown={(e) => {
          if (renaming || (e.target as Element).closest('button, input')) return;
          tree.pointerDown(id, e);
        }}
        onClick={(e) => {
          if (tree.justDragged()) return;
          const current = tree.getSelection();
          if (e.shiftKey) tree.setSelection(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
          else tree.setSelection([id]);
        }}
        onDoubleClick={() => setEditing(true)}
        onContextMenu={(e) => {
          if (renaming) return;
          e.preventDefault();
          // Like the canvas: right-clicking a layer outside the selection selects it first.
          if (!tree.getSelection().includes(id)) tree.setSelection([id]);
          tree.contextMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <button
          className={`twisty ${open ? 'is-open' : ''}`}
          aria-label={open ? 'Collapse' : 'Expand'}
          tabIndex={-1}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation();
            tree.toggle(id);
          }}
        >
          {icons.chevron}
        </button>
        <span className="row-icon">{typeIcon(node)}</span>
        {renaming ? (
          <input
            className="rename-input"
            defaultValue={node.name}
            autoFocus
            onFocus={(e) => isFreshFocus(e.currentTarget) && e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitName(e.currentTarget.value);
              if (e.key === 'Escape') {
                setEditing(false);
                tree.renameDone();
              }
            }}
            // Switching to another app keeps the rename open; only a blur inside the app commits it.
            onBlur={(e) => keepEditingAcrossWindowBlur(e.currentTarget) || commitName(e.currentTarget.value)}
          />
        ) : (
          <span className="row-name">{node.name}</span>
        )}
        <span className={`row-actions ${node.locked || node.hidden ? 'has-on' : ''}`}>
          <button
            className={`icon-button ${node.locked ? 'is-on' : ''}`}
            aria-label={node.locked ? 'Unlock' : 'Lock'}
            data-tip={node.locked ? 'Unlock' : 'Lock'}
            onClick={(e) => {
              e.stopPropagation();
              doc.setFlags(actor, [id], { locked: !node.locked });
            }}
          >
            {node.locked ? icons.lock : icons.unlock}
          </button>
          <button
            className={`icon-button ${node.hidden ? 'is-on' : ''}`}
            aria-label={node.hidden ? 'Show' : 'Hide'}
            data-tip={node.hidden ? 'Show' : 'Hide'}
            onClick={(e) => {
              e.stopPropagation();
              doc.setFlags(actor, [id], { hidden: !node.hidden });
            }}
          >
            {node.hidden ? icons.eyeOff : icons.eye}
          </button>
        </span>
      </div>
      {open && (
        <ul role="group">
          {node.children.map((child) => (
              <LayerRow key={child} id={child} depth={depth + 1} tree={tree} />
            ))}
        </ul>
      )}
    </li>
  );
});

/** Movement in px before a press on a row turns into a drag. */
const DRAG_THRESHOLD = 4;
const ZONE_CLASSES = ['drop-before', 'drop-after', 'drop-inside'];

/**
 * Reorders layers by dragging rows with the pointer. Pointer events rather than HTML5 drag and drop, which
 * the desktop webview does not deliver reliably. The drop indicator is a class on the hovered row, so a drag
 * never re-renders the tree.
 */
function useLayerDrag(onDrop: (nodeId: string, targetId: string, zone: DropZone) => void) {
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const [api] = useState(() => {
    let suppressClickUntil = 0;
    const pointerDown = (id: string, e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
      const source = e.currentTarget;
      const start = { x: e.clientX, y: e.clientY };
      let dragging = false;
      let marked: Element | null = null;
      let target: { id: string; zone: DropZone } | null = null;

      const mark = (row: Element | null, zone: DropZone | null) => {
        if (marked && (marked !== row || !zone)) marked.classList.remove(...ZONE_CLASSES);
        marked = row;
        if (row && zone) {
          row.classList.remove(...ZONE_CLASSES);
          row.classList.add(`drop-${zone}`);
        }
      };
      const targetAt = (x: number, y: number): { row: Element; id: string; zone: DropZone } | null => {
        const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('.layer-row[data-layer-id]');
        // Not onto itself, and not into its own subtree (the dragged row's <li> holds its children).
        if (!row || source.parentElement?.contains(row)) return null;
        const r = row.getBoundingClientRect();
        const f = (y - r.top) / r.height;
        const zone: DropZone = row.hasAttribute('data-layer-container') && f > 0.3 && f < 0.7 ? 'inside' : f < 0.5 ? 'before' : 'after';
        return { row, id: row.dataset.layerId!, zone };
      };
      const move = (ev: PointerEvent) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
          dragging = true;
          source.classList.add('is-dragging');
          document.documentElement.classList.add('is-dragging-layer');
        }
        const hit = targetAt(ev.clientX, ev.clientY);
        target = hit && { id: hit.id, zone: hit.zone };
        mark(hit?.row ?? null, hit?.zone ?? null);
      };
      const end = (commit: boolean) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        window.removeEventListener('keydown', key, true);
        mark(null, null);
        if (!dragging) return;
        source.classList.remove('is-dragging');
        document.documentElement.classList.remove('is-dragging-layer');
        // The click that follows pointerup lands on whatever row is under the pointer: ignore it.
        suppressClickUntil = performance.now() + 50;
        if (commit && target) onDropRef.current(id, target.id, target.zone);
      };
      const up = () => end(true);
      const cancel = () => end(false);
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape' || !dragging) return;
        ev.preventDefault();
        ev.stopPropagation();
        end(false);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      window.addEventListener('keydown', key, true);
    };
    return { pointerDown, justDragged: () => performance.now() < suppressClickUntil };
  });
  return api;
}
