import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, controlOwnsKey, isTyping } from './canvas/Canvas';
import { measureNode, unionRects, type Rect } from './canvas/geometry';
import { useCanvasGestures } from './canvas/gestures';
import { SelectionOverlay } from './canvas/SelectionOverlay';
import { anchorWorld } from './comments/anchor';
import { CommentLayer } from './comments/CommentLayer';
import { DEFAULT_FILTER, markSeen, type CommentFilter, type Draft } from './comments/state';
import { TOOLS, type Tool } from './canvas/tools';
import { fitRect, screenToWorld, worldToScreen, type Viewport } from './canvas/viewport';
import { runCommand, type CommandContext } from './commands';
import { isMacPlatform, resolveShortcut } from './keyboard';
import { icons } from './panels/icons';
import { RightPanel } from './panels/RightPanel';
import { captureThumbnail, createDomTools } from './bridge/domTools';
import { LayersPanel } from './panels/LayersPanel';
import { McpPanel } from './panels/McpPanel';
import { SelectionProvider, useSelection } from './selection';
import { useDoc } from './store/DocProvider';
import { usePages } from './store/hooks';
import { CopyMenu, type CopyMenuState } from './export/CopyMenu';
import { sanitizeText } from './canvas/NodeView';
import { pasteIntoDoc } from './paste';
import { useTabs, useWorkspace } from './workspace/WorkspaceProvider';

export function Editor() {
  return (
    <SelectionProvider>
      <EditorShell />
    </SelectionProvider>
  );
}

const CURSORS: Record<Tool, string> = { move: 'default', frame: 'crosshair', rect: 'crosshair', text: 'text', hand: 'grab', comment: 'crosshair' };

function EditorShell() {
  const { doc, actor, undo } = useDoc();
  const pages = usePages();
  const selection = useSelection();
  const canvasRef = useRef<HTMLDivElement>(null);
  const { workspace, surfaces, bridgeStatus } = useWorkspace();
  const [activePageId, setActivePageId] = useState(() => workspace.activePageId(doc.fileId));
  const page = pages.find((p) => p.type === 'page' && p.id === activePageId) ?? pages.find((p) => p.type === 'page');
  const rootId = page && page.type === 'page' ? page.rootId : '';
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 80, zoom: 0.5 });
  const [tool, setTool] = useState<Tool>('move');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [collapseSignal, setCollapseSignal] = useState(0);
  const [commentFilter, setCommentFilter] = useState<CommentFilter>(DEFAULT_FILTER);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [copyMenu, setCopyMenu] = useState<CopyMenuState | null>(null);
  const [toast, setToast] = useState('');
  const [mcpOpen, setMcpOpen] = useState(false);
  const closeMcp = useCallback(() => setMcpOpen(false), []);
  const [dragTick, setDragTick] = useState(0);
  const bumpDrag = useCallback(() => setDragTick((t) => t + 1), []);
  const fileName = useTabs().find((t) => t.fileId === doc.fileId)?.name ?? doc.name;
  const shownPageId = page?.id ?? activePageId;
  // Agents read the page the tab shows; the workspace remembers it per tab.
  useEffect(() => workspace.setActivePage(doc.fileId, shownPageId), [workspace, doc, shownPageId]);
  const rootRef = useRef(rootId);
  rootRef.current = rootId;

  useEffect(
    () =>
      surfaces.register(doc.fileId, {
        domTools: createDomTools({ doc, canvas: () => canvasRef.current, getSelection: selection.get }),
        thumbnail: () => captureThumbnail(canvasRef.current, doc.getNode(rootRef.current)?.children[0]),
      }),
    [surfaces, doc, selection.get],
  );

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

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const viewportCenter = useCallback(() => {
    const box = canvasRef.current?.getBoundingClientRect();
    return screenToWorld(viewportRef.current, { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 });
  }, []);

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
      notify: setToast,
      viewportCenter,
    }),
    [doc, actor, undo, rootId, selection, zoomToFit, viewportCenter],
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onMenu = (e: MouseEvent) => {
      const hit = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id]')?.getAttribute('data-node-id');
      if (hit && !selection.get().includes(hit) && doc.getNode(hit)?.type !== 'root') selection.set([hit]);
      if (!selection.get().some((id) => doc.getNode(id)?.type !== 'root')) return;
      e.preventDefault();
      setCopyMenu({ x: e.clientX, y: e.clientY });
    };
    el.addEventListener('contextmenu', onMenu);
    return () => el.removeEventListener('contextmenu', onMenu);
  }, [doc, selection, rootId]);

  useEffect(() => {
    const mac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || controlOwnsKey(e.target, e)) return;
      const command = resolveShortcut(e, mac);
      if (!command) return;
      e.preventDefault();
      runCommand(command, ctx);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctx]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || !e.clipboardData) return;
      const data = { html: e.clipboardData.getData('text/html'), text: e.clipboardData.getData('text/plain'), files: Array.from(e.clipboardData.files) };
      if (!data.html && !data.text && !data.files.length) return;
      e.preventDefault();
      pasteIntoDoc(doc, actor, data, { selection: selection.get(), rootId, viewportCenter: viewportCenter() }).then(
        (ids) => ids.length && selection.set(ids),
        (err: unknown) => setToast(err instanceof Error ? err.message : `Could not paste: ${String(err)}`),
      );
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [doc, actor, selection, rootId, viewportCenter]);

  const placeComment = useCallback(
    (at: { nodeId: string | null; x: number; y: number }) => {
      setThreadId(null);
      setDraft({ pageId: shownPageId, ...at });
    },
    [shownPageId],
  );

  const gestures = useCanvasGestures({ canvasRef, viewport, tool, setTool, rootId, bumpDrag, startTextEdit, placeComment });

  /** Opens a thread from the panel: switches page when needed and pans so its pin is on screen. */
  const openThread = useCallback(
    (id: string) => {
      const thread = doc.threads().find((t) => t.id === id);
      if (!thread) return;
      markSeen(doc.fileId, thread);
      setDraft(null);
      setThreadId(id);
      setRevealId(id);
      if (thread.pageId !== shownPageId) {
        setActivePageId(thread.pageId);
        selection.set([]);
      }
    },
    [doc, shownPageId, selection],
  );

  useEffect(() => {
    if (!revealId) return;
    const canvas = canvasRef.current;
    const thread = doc.threads().find((t) => t.id === revealId);
    if (!canvas || !thread || thread.pageId !== shownPageId) return;
    setRevealId(null);
    const world = anchorWorld(canvas, thread, viewport);
    const box = canvas.getBoundingClientRect();
    if (!world || box.width === 0) return;
    const at = worldToScreen(viewport, world);
    if (at.x < 24 || at.y < 24 || at.x > box.width - 360 || at.y > box.height - 24) setViewport({ ...viewport, x: box.width / 2 - world.x * viewport.zoom - 160, y: box.height / 2 - world.y * viewport.zoom });
  }, [revealId, doc, shownPageId, viewport]);

  const createComment = (d: Draft, body: string) => {
    const id = doc.createThread(actor, { ...d, body });
    setDraft(null);
    setThreadId(id);
    setTool('move');
  };

  if (!rootId || !page || page.type !== 'page') return null;

  return (
    <div className="editor">
      <header className="topbar">
        <span className="file-name">{fileName}</span>
        <div className="toolbar" role="toolbar" aria-label="Tools">
          {TOOLS.map((t) => (
            <button key={t.id} className={`tool-button ${tool === t.id ? 'is-active' : ''}`} aria-pressed={tool === t.id} title={`${t.label} (${t.shortcut})`} onClick={() => setTool(t.id)}>
              {icons[t.id]}
            </button>
          ))}
        </div>
        <span className={`bridge-status is-${bridgeStatus}`} title={bridgeStatus === 'connected' ? 'Agents can reach this file through markup mcp' : 'Run `markup mcp` from an agent to connect'}>
          {bridgeStatus === 'connected' ? 'Agents connected' : 'Agents offline'}
        </span>
        <div className="mcp-anchor">
          <button className="topbar-button" data-mcp-toggle aria-expanded={mcpOpen} onClick={() => setMcpOpen((o) => !o)}>
            Connect an agent
          </button>
          {mcpOpen && <McpPanel onClose={closeMcp} />}
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
            setThreadId(null);
            setDraft(null);
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
          overlay={
            <>
              <SelectionOverlay canvasRef={canvasRef} ids={selection.ids} viewport={viewport} dragTick={dragTick} onHandleDown={gestures.onHandleDown} />
              <CommentLayer
                canvasRef={canvasRef}
                viewport={viewport}
                pageId={page.id}
                filter={commentFilter}
                selectedId={threadId}
                draft={draft}
                dragTick={dragTick}
                onSelect={(id) => {
                  setDraft(null);
                  setThreadId(id);
                }}
                onCancelDraft={() => setDraft(null)}
                onCreate={createComment}
              />
            </>
          }
        />
        <RightPanel comments={{ activePageId: page.id, filter: commentFilter, onFilter: setCommentFilter, selectedId: threadId, onSelect: openThread }} />
      </main>
      {copyMenu && <CopyMenu at={copyMenu} onClose={() => setCopyMenu(null)} onPick={(command) => runCommand(command, ctx)} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
