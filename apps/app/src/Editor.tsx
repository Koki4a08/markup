import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, isTyping } from './canvas/Canvas';
import { measureNode, unionRects, type Rect } from './canvas/geometry';
import { useCanvasGestures } from './canvas/gestures';
import { SelectionOverlay } from './canvas/SelectionOverlay';
import { TOOLS, type Tool } from './canvas/tools';
import { fitRect, type Viewport } from './canvas/viewport';
import { runCommand, type CommandContext } from './commands';
import { isMacPlatform, resolveShortcut } from './keyboard';
import { icons } from './panels/icons';
import { LayersPanel } from './panels/LayersPanel';
import { SelectionProvider, useSelection } from './selection';
import { useDoc } from './store/DocProvider';
import { usePages } from './store/hooks';
import { sanitizeText } from './canvas/NodeView';

export function Editor() {
  return (
    <SelectionProvider>
      <EditorShell />
    </SelectionProvider>
  );
}

const CURSORS: Record<Tool, string> = { move: 'default', frame: 'crosshair', rect: 'crosshair', text: 'text', hand: 'grab' };

function EditorShell() {
  const { doc, actor, undo } = useDoc();
  const pages = usePages();
  const selection = useSelection();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [activePageId, setActivePageId] = useState(() => pages.find((p) => p.type === 'page')!.id);
  const page = pages.find((p) => p.type === 'page' && p.id === activePageId) ?? pages.find((p) => p.type === 'page');
  const rootId = page && page.type === 'page' ? page.rootId : '';
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 80, zoom: 0.5 });
  const [tool, setTool] = useState<Tool>('move');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [collapseSignal, setCollapseSignal] = useState(0);
  const [dragTick, setDragTick] = useState(0);
  const bumpDrag = useCallback(() => setDragTick((t) => t + 1), []);

  const zoomToFit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ids = selection.get().length ? selection.get() : doc.requireNode(rootId).children;
    const box = unionRects(ids.map((id) => measureNode(canvas, id, viewport)).filter((r): r is Rect => r !== null));
    if (box) setViewport(fitRect(box, canvas.getBoundingClientRect()));
  }, [doc, rootId, selection, viewport]);

  const startTextEdit = useCallback(
    (id: string) => {
      const el = canvasRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
      if (!el) return;
      el.contentEditable = 'true';
      el.focus();
      document.getSelection()?.selectAllChildren(el);
      const finish = (commit: boolean) => {
        el.removeEventListener('blur', onBlur);
        el.removeEventListener('keydown', onKey);
        el.contentEditable = 'false';
        const html = sanitizeText(el.innerHTML);
        if (commit && html !== doc.getNode(id)?.text) doc.setText(actor, [{ nodeId: id, html }]);
        else el.innerHTML = sanitizeText(doc.getNode(id)?.text ?? '');
      };
      const onBlur = () => finish(true);
      const onKey = (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          finish(true);
          el.blur();
        }
      };
      el.addEventListener('blur', onBlur);
      el.addEventListener('keydown', onKey);
    },
    [doc, actor],
  );

  const ctx: CommandContext = useMemo(
    () => ({
      doc,
      actor,
      undo,
      rootId,
      getSelection: selection.get,
      setSelection: selection.set,
      setTool,
      zoomToFit,
      zoomTo: (zoom) => setViewport((v) => ({ ...v, zoom })),
      startRename: setRenamingId,
      collapseLayers: () => setCollapseSignal((n) => n + 1),
    }),
    [doc, actor, undo, rootId, selection, zoomToFit],
  );

  useEffect(() => {
    const mac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const command = resolveShortcut(e, mac);
      if (!command) return;
      e.preventDefault();
      runCommand(command, ctx);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx]);

  const gestures = useCanvasGestures({ canvasRef, viewport, tool, setTool, rootId, bumpDrag, startTextEdit });

  if (!rootId || !page || page.type !== 'page') return null;

  return (
    <div className="editor">
      <header className="topbar">
        <span className="file-name">{doc.name}</span>
        <div className="toolbar" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={`tool-button ${tool === t.id ? 'is-active' : ''}`} aria-pressed={tool === t.id} title={`${t.label} (${t.shortcut})`} onClick={() => setTool(t.id)}>
              {icons[t.id]}
            </button>
          ))}
        </div>
        <button className="zoom" title="Zoom to fit (⇧1)" onClick={zoomToFit}>
          {Math.round(viewport.zoom * 100)}%
        </button>
      </header>
      <main className="workspace">
        <LayersPanel
          activePageId={page.id}
          onPage={(id) => {
            setActivePageId(id);
            selection.set([]);
          }}
          renamingId={renamingId}
          onRenameDone={() => setRenamingId(null)}
          collapseSignal={collapseSignal}
        />
        <Canvas
          containerRef={canvasRef}
          rootId={rootId}
          viewport={viewport}
          onViewport={setViewport}
          cursor={CURSORS[tool]}
          onPointerDown={gestures.onPointerDown}
          overlay={<SelectionOverlay canvasRef={canvasRef} ids={selection.ids} viewport={viewport} dragTick={dragTick} onHandleDown={gestures.onHandleDown} />}
        />
      </main>
    </div>
  );
}
