import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MarkupDoc, MarkupNode } from '@markup/doc';
import { formatShortcut, isMacPlatform, shortcutLabel, type Command } from '../commands/keyboard';
import { useDoc } from '../store/DocProvider';
import { useSelection } from '../canvas/selection';
import { copiedStyles } from '../canvas/canvasOps';
import { useDismiss } from '../ui/useDismiss';
import './contextMenu.css';

export interface CopyMenuState {
  x: number;
  y: number;
}

/** What the menu hands to onPick: any canvas command. */
export type CopyCommand = Command;

interface Entry {
  label: string;
  command?: Command;
  shortcut?: string;
  disabled?: boolean;
  submenu?: Entry[];
  /** Runs instead of a command (Select layer rows). */
  run?(): void;
  /** Select layer rows: depth in the tree, and indent relative to the shallowest row. */
  depth?: number;
  indent?: number;
}

const EDGE = 4;

/** Rendered layers under a screen point, topmost first, de-duplicated. */
function layersAt(doc: MarkupDoc, x: number, y: number): MarkupNode[] {
  if (typeof document.elementsFromPoint !== 'function') return [];
  const seen = new Set<string>();
  const out: MarkupNode[] = [];
  for (const el of document.elementsFromPoint(x, y)) {
    if (!el.closest('.canvas-world')) continue;
    const id = el.closest('[data-node-id]')?.getAttribute('data-node-id');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = doc.getNode(id);
    if (node && node.type !== 'root') out.push(node);
  }
  return out;
}

function depthOf(doc: MarkupDoc, id: string): number {
  let depth = -1;
  for (let p = doc.getNode(id)?.parentId; p; p = doc.getNode(p)?.parentId) depth++;
  return Math.max(0, depth);
}

const isFlexFrame = (n: MarkupNode) => n.type === 'frame' && /^(inline-)?flex$/.test(String(n.styles.display ?? '').trim());

const ChevronRight = () => (
  <svg className="canvas-menu-chevron" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.5 4.5 10 8l-3.5 3.5" />
  </svg>
);

/** Keeps a fixed box inside the viewport. */
function clamp(left: number, top: number, el: HTMLElement): { left: number; top: number } {
  const { width, height } = el.getBoundingClientRect();
  return {
    left: Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE)),
    top: Math.max(EDGE, Math.min(top, window.innerHeight - height - EDGE)),
  };
}

const enabledItems = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled)') ?? [])];

/**
 * Canvas right-click menu: selection, clipboard, styles, structure, order and visibility commands, with Select layer
 * and Copy as submenus. Arrow keys move focus and open or close submenus, Enter activates, Esc or an outside click closes.
 */
export function CopyMenu({ at, onPick, onClose }: { at: CopyMenuState; onPick(command: Command): void; onClose(): void }) {
  const { doc } = useDoc();
  const selection = useSelection();
  const mac = useMemo(isMacPlatform, []);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [rootPos, setRootPos] = useState({ left: at.x, top: at.y });
  const [open, setOpen] = useState<{ index: number; focus: boolean } | null>(null);
  const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null);
  const hits = useMemo(() => layersAt(doc, at.x, at.y), [doc, at.x, at.y]);
  // Like a native menu: gone when the app loses focus, the window resizes or the page scrolls under it.
  useDismiss(onClose, { ref: wrapRef });

  // Right-clicking a layer outside the selection selects it first (hits only change with the click point).
  const { get: getSelection, set: setSelection } = selection;
  useLayoutEffect(() => {
    const top = hits[0];
    if (top && !getSelection().includes(top.id)) setSelection([top.id]);
  }, [hits, getSelection, setSelection]);

  const nodes = selection.ids.map((id) => doc.getNode(id)).filter((n): n is MarkupNode => !!n && n.type !== 'root');
  const none = nodes.length === 0;
  const short = (command: Command) => shortcutLabel(command, mac);
  const cmd = (label: string, command: Command, disabled = none, shortcut = short(command)): Entry => ({ label, command, disabled, shortcut });

  const layerRows: Entry[] = useMemo(() => {
    const rows = hits.map((n) => ({ node: n, depth: depthOf(doc, n.id) })).sort((a, b) => b.depth - a.depth);
    const min = Math.min(...rows.map((r) => r.depth));
    return rows.map(({ node, depth }) => ({ label: node.name || node.type, depth, indent: depth - min, run: () => selection.set([node.id]) }));
  }, [hits, doc, selection]);

  const groups: Entry[][] = [
    [
      { label: 'Select layer…', submenu: layerRows, disabled: layerRows.length === 0 },
      cmd('Select children', 'selectChildren', !nodes.some((n) => n.children.length > 0)),
      cmd('Select parent', 'selectParent'),
      cmd('Deselect', 'deselect'),
    ],
    [
      cmd('Copy', 'copy'),
      cmd('Copy link', 'copyLink', false),
      {
        label: 'Copy as…',
        disabled: none,
        submenu: [
          cmd('Copy as React', 'copyReact'),
          cmd('Copy as Tailwind', 'copyTailwind'),
          cmd('Copy as HTML', 'copyHtml'),
          cmd('Copy as PNG', 'copyPng'),
          cmd('Copy as SVG', 'copySvg', !nodes.some((n) => n.type === 'svg')),
        ],
      },
    ],
    [
      cmd('Paste', 'paste', false, formatShortcut({ code: 'KeyV', mod: true }, mac)),
      cmd('Paste on top', 'pasteOnTop'),
      cmd('Paste to replace', 'pasteToReplace'),
      cmd('Duplicate', 'duplicate'),
    ],
    [cmd('Copy styles', 'copyStyles'), cmd('Paste styles', 'pasteStyles', none || !copiedStyles())],
    [
      cmd('Rename', 'rename'),
      cmd('Frame selection', 'wrapInFrame'),
      cmd('Remove flex', 'removeFlex', !nodes.some(isFlexFrame)),
      cmd('Ungroup', 'ungroup', !nodes.some((n) => n.type === 'frame' && n.children.length > 0)),
    ],
    [cmd('Bring to front', 'bringToFront'), cmd('Send to back', 'sendToBack'), cmd('Move forward', 'moveForward'), cmd('Move backward', 'moveBackward')],
    [cmd('Show / hide', 'toggleHidden'), cmd('Lock / unlock', 'toggleLocked')],
    [cmd('Set as thumbnail', 'setThumbnail', nodes.length !== 1)],
  ];
  const entries = groups.flat();
  const openEntry = open ? entries[open.index] : undefined;

  const activate = (entry: Entry, index: number) => {
    if (entry.disabled) return;
    if (entry.submenu) return setOpen({ index, focus: true });
    onClose();
    if (entry.run) entry.run();
    else if (entry.command) onPick(entry.command);
  };

  useLayoutEffect(() => {
    if (rootRef.current) setRootPos(clamp(at.x, at.y, rootRef.current));
  }, [at.x, at.y]);

  useLayoutEffect(() => {
    if (!open) return setSubPos(null);
    const anchor = rootRef.current?.querySelector<HTMLElement>(`[data-index="${open.index}"]`);
    const sub = subRef.current;
    if (!anchor || !sub) return;
    const a = anchor.getBoundingClientRect();
    const { width } = sub.getBoundingClientRect();
    const right = a.right + 2;
    setSubPos(clamp(right + width > window.innerWidth - EDGE ? a.left - width - 2 : right, a.top - 4, sub));
    if (open.focus) enabledItems(sub)[0]?.focus();
  }, [open]);

  useEffect(() => {
    enabledItems(rootRef.current)[0]?.focus();
  }, []);

  useEffect(() => {
    const closeSub = () => {
      const index = open?.index;
      setOpen(null);
      if (index !== undefined) rootRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const inSub = !!active && !!subRef.current?.contains(active);
      const menu = inSub ? subRef.current : rootRef.current;
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      switch (e.key) {
        case 'Escape':
          handled();
          return open ? closeSub() : onClose();
        case 'ArrowDown':
        case 'ArrowUp': {
          handled();
          const items = enabledItems(menu);
          const i = items.indexOf(active as HTMLButtonElement);
          const step = e.key === 'ArrowDown' ? 1 : items.length - 1;
          items[i < 0 ? 0 : (i + step) % items.length]?.focus();
          return;
        }
        case 'ArrowRight': {
          const index = Number(active?.getAttribute('data-index'));
          if (!inSub && active && entries[index]?.submenu && !entries[index]!.disabled) {
            handled();
            setOpen({ index, focus: true });
          }
          return;
        }
        case 'ArrowLeft':
          if (inSub) {
            handled();
            closeSub();
          }
          return;
        case 'Enter':
        case ' ':
          if (active && wrapRef.current?.contains(active) && active.getAttribute('role') === 'menuitem') {
            handled();
            active.click();
          }
          return;
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, open, entries]);

  let index = 0;
  return (
    <div ref={wrapRef} className="canvas-menu-layer">
      <div ref={rootRef} className="canvas-menu" role="menu" aria-label="Canvas actions" style={rootPos}>
        {groups.map((group, g) => (
          <Fragment key={g}>
            {g > 0 && <div role="separator" className="canvas-menu-sep" />}
            {group.map((entry) => {
              const i = index++;
              return (
                <Row
                  key={entry.label}
                  entry={entry}
                  index={i}
                  expanded={open?.index === i}
                  onActivate={() => activate(entry, i)}
                  onHover={(el) => {
                    if (entry.submenu && !entry.disabled) setOpen({ index: i, focus: false });
                    else setOpen(null);
                    el.focus();
                  }}
                />
              );
            })}
          </Fragment>
        ))}
      </div>
      {openEntry?.submenu && (
        <div
          ref={subRef}
          className="canvas-menu canvas-submenu"
          role="menu"
          aria-label={openEntry.label.replace('…', '')}
          style={subPos ?? { left: rootPos.left, top: rootPos.top, visibility: 'hidden' }}
        >
          {openEntry.submenu.map((entry, i) => (
            <Row key={`${entry.label}-${i}`} entry={entry} onActivate={() => activate(entry, i)} onHover={(el) => el.focus()} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ entry, index, expanded, onActivate, onHover }: { entry: Entry; index?: number; expanded?: boolean; onActivate(): void; onHover(el: HTMLButtonElement): void }) {
  const style = entry.indent ? ({ '--indent': entry.indent } as CSSProperties) : undefined;
  return (
    <button
      type="button"
      role="menuitem"
      className="canvas-menu-item"
      disabled={entry.disabled}
      data-index={index}
      data-depth={entry.depth}
      aria-haspopup={entry.submenu ? 'menu' : undefined}
      aria-expanded={entry.submenu ? !!expanded : undefined}
      style={style}
      onClick={onActivate}
      onMouseEnter={(e) => !entry.disabled && onHover(e.currentTarget)}
    >
      <span className="canvas-menu-label">{entry.label}</span>
      {entry.submenu ? <ChevronRight /> : entry.shortcut ? <kbd>{entry.shortcut}</kbd> : null}
    </button>
  );
}
