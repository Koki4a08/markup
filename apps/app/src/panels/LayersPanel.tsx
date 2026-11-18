import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { MarkupNode, Move } from '@markup/doc';
import { icons } from './icons';
import { useDoc } from '../store/DocProvider';
import { useNode, usePages } from '../store/hooks';
import { useSelection } from '../selection';

interface Props {
  activePageId: string;
  onPage(id: string): void;
  renamingId: string | null;
  onRenameDone(): void;
  collapseSignal: number;
}

type DropZone = 'before' | 'after' | 'inside';

export function LayersPanel({ activePageId, onPage, renamingId, onRenameDone, collapseSignal }: Props) {
  const { doc, actor } = useDoc();
  const pages = usePages();
  const page = pages.find((p) => p.type === 'page' && p.id === activePageId);
  const root = useNode(page && page.type === 'page' ? page.rootId : '');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const dragged = useRef<string | null>(null);

  useEffect(() => {
    if (collapseSignal === 0) return;
    setCollapsed(new Set([...doc.nodes.keys()]));
  }, [collapseSignal, doc]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const drop = (targetId: string, zone: DropZone) => {
    const nodeId = dragged.current;
    dragged.current = null;
    if (!nodeId || nodeId === targetId) return;
    const move: Move = zone === 'inside' ? { nodeId, parentId: targetId, index: 0 } : zone === 'before' ? { nodeId, before: targetId } : { nodeId, after: targetId };
    try {
      doc.moveNodes(actor, [move]);
    } catch {
      // Invalid target (a node into its own subtree, or into a text node): ignore the drop.
    }
  };

  return (
    <aside className="panel layers-panel" aria-label="Pages and layers">
      <section className="panel-section">
        <div className="panel-heading">
          <span>Pages</span>
          <button className="icon-button" aria-label="Add page" onClick={() => onPage(doc.createPage(actor))}>
            {icons.plus}
          </button>
        </div>
        <ul className="page-list" role="listbox" aria-label="Pages">
          {pages.map((p) =>
            p.type === 'divider' ? (
              <li key={p.id} className="page-divider" role="separator" />
            ) : (
              <li key={p.id} role="option" aria-selected={p.id === activePageId}>
                <button className={`row ${p.id === activePageId ? 'is-active' : ''}`} onClick={() => onPage(p.id)}>
                  <span className="row-icon">{icons.page}</span>
                  <span className="row-name">{p.name}</span>
                </button>
              </li>
            ),
          )}
        </ul>
      </section>
      <section className="panel-section layers">
        <div className="panel-heading">
          <span>Layers</span>
        </div>
        <ul className="layer-tree" role="tree" aria-label="Layers">
          {root?.children.map((id) => (
              <LayerRow key={id} id={id} depth={0} collapsed={collapsed} onToggle={toggle} renamingId={renamingId} onRenameDone={onRenameDone} dragged={dragged} onDrop={drop} />
            ))}
          {root && root.children.length === 0 && <li className="empty-hint">Press F and drag on the canvas to draw an artboard.</li>}
        </ul>
      </section>
    </aside>
  );
}

interface RowProps {
  id: string;
  depth: number;
  collapsed: Set<string>;
  onToggle(id: string): void;
  renamingId: string | null;
  onRenameDone(): void;
  dragged: React.MutableRefObject<string | null>;
  onDrop(targetId: string, zone: DropZone): void;
}

const typeIcon = (n: MarkupNode) => (n.type === 'text' ? icons.text : n.type === 'image' ? icons.image : n.type === 'svg' ? icons.svg : icons.frame);

function LayerRow({ id, depth, collapsed, onToggle, renamingId, onRenameDone, dragged, onDrop }: RowProps) {
  const { doc, actor } = useDoc();
  const node = useNode(id);
  const selection = useSelection();
  const [zone, setZone] = useState<DropZone | null>(null);
  const [editing, setEditing] = useState(false);
  const renaming = editing || renamingId === id;
  if (!node) return null;
  const selected = selection.ids.includes(id);
  const hasChildren = node.children.length > 0;
  const open = hasChildren && !collapsed.has(id);

  const zoneFor = (e: DragEvent<HTMLDivElement>): DropZone => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientY - r.top) / r.height;
    if (node.type === 'frame' && f > 0.3 && f < 0.7) return 'inside';
    // The tree lists children in document (DOM) order, like the code they become.
    return f < 0.5 ? 'before' : 'after';
  };

  const commitName = (value: string) => {
    setEditing(false);
    onRenameDone();
    const name = value.trim();
    if (name && name !== node.name) doc.renameNodes(actor, [{ nodeId: id, name }]);
  };

  return (
    <li role="treeitem" aria-selected={selected} aria-expanded={hasChildren ? open : undefined}>
      <div
        className={`row layer-row ${selected ? 'is-selected' : ''} ${node.hidden ? 'is-hidden' : ''} ${zone ? `drop-${zone}` : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        draggable={!renaming}
        onDragStart={(e) => {
          dragged.current = id;
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!dragged.current || dragged.current === id) return;
          e.preventDefault();
          setZone(zoneFor(e));
        }}
        onDragLeave={() => setZone(null)}
        onDrop={(e) => {
          e.preventDefault();
          const z = zoneFor(e);
          setZone(null);
          onDrop(id, z);
        }}
        onClick={(e) => {
          const current = selection.get();
          if (e.shiftKey) selection.set(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
          else selection.set([id]);
        }}
        onDoubleClick={() => setEditing(true)}
      >
        <button
          className={`twisty ${open ? 'is-open' : ''}`}
          aria-label={open ? 'Collapse' : 'Expand'}
          tabIndex={-1}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(id);
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
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitName(e.currentTarget.value);
              if (e.key === 'Escape') {
                setEditing(false);
                onRenameDone();
              }
            }}
            onBlur={(e) => commitName(e.currentTarget.value)}
          />
        ) : (
          <span className="row-name">{node.name}</span>
        )}
        <span className="row-actions">
          <button
            className={`icon-button ${node.locked ? 'is-on' : ''}`}
            aria-label={node.locked ? 'Unlock' : 'Lock'}
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
              <LayerRow key={child} id={child} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} renamingId={renamingId} onRenameDone={onRenameDone} dragged={dragged} onDrop={onDrop} />
            ))}
        </ul>
      )}
    </li>
  );
}
