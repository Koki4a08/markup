import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, controlOwnsKey, isTyping } from '../canvas/Canvas';
import { measureNode, unionRects, type Rect } from '../canvas/geometry';
import { useCanvasGestures, type DrawDraft } from '../canvas/gestures';
import { DrawPreview, HoverOverlay, MarqueePreview } from '../canvas/HoverOverlay';
import { SelectionOverlay } from '../canvas/SelectionOverlay';
import { TickStore, ValueStore, type ViewportStore } from '../canvas/store';
import { anchorWorld } from '../comments/anchor';
import { CommentLayer } from '../comments/CommentLayer';
import { DEFAULT_FILTER, markSeen, type CommentFilter, type Draft } from '../comments/state';
import { TOOLS, type Tool } from '../canvas/tools';
import { blendViewport, fitRect, screenToWorld, stepZoom, worldToScreen, zoomAt, type Viewport } from '../canvas/viewport';
import { runCommand, type CommandContext } from '../commands/commands';
import { isMacPlatform, resolveShortcut } from '../commands/keyboard';
import { icons } from '../panels/icons';
import { RightPanel } from '../panels/RightPanel';
import { captureThumbnail, createDomTools } from '../bridge/domTools';
import { LayersPanel } from '../panels/LayersPanel';
import { NoSelection } from '../panels/NoSelection';
import { PanelTop } from '../panels/PanelTop';
import { SelectionProvider, useSelection } from '../canvas/selection';
import { useDoc } from '../store/DocProvider';
import { usePages } from '../store/hooks';
import { CopyMenu, type CopyMenuState } from '../export/CopyMenu';
import { sanitizeText } from '../canvas/NodeView';
import { pasteIntoDoc } from '../clipboard/paste';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { PanelResizer, usePanelWidths } from '../ui/PanelResizer';
import { UpdateNotice } from '../desktop/UpdateNotice';
import { keepEditingAcrossWindowBlur } from '../ui/windowFocus';

/** Viewport and selection of one tab, kept by the workspace across tab switches. */
interface TabView {
  viewport: Viewport;
  selection: string[];
}

function useTabView(): TabView {
  const { doc } = useDoc();
  const { workspace } = useWorkspace();
  return useMemo(() => workspace.tabState<TabView>(doc.fileId, 'view', () => ({ viewport: { x: 80, y: 80, zoom: 0.5 }, selection: [] })), [workspace, doc]);
}

export function Editor() {
  const view = useTabView();
  return (
    <SelectionProvider initial={view.selection}>
      <EditorShell view={view} />
    </SelectionProvider>
  );
}

/** Rail order and dividers: select and navigate | draw | annotate. */
const RAIL_ORDER: Tool[] = ['move', 'hand', 'frame', 'rect', 'text', 'comment'];
const RAIL_TOOLS = RAIL_ORDER.map((id) => TOOLS.find((t) => t.id === id)!);
const TOOL_GROUP_ENDS = new Set<Tool>(['hand', 'text']);
const RAIL_WIDTH = 44;
/** How long zoom commands take to glide to their view. */
const GLIDE_MS = 320;

const CURSORS: Record<Tool, string> = { move: 'default', frame: 'crosshair', rect: 'crosshair', text: 'text', hand: 'grab', comment: 'crosshair' };

function EditorShell({ view }: { view: TabView }) {
  const { doc, actor, undo } = useDoc();
  const pages = usePages();
  const selection = useSelection();
  const canvasRef = useRef<HTMLDivElement>(null);
  const { workspace, surfaces, bridgeStatus } = useWorkspace();
  const [activePageId, setActivePageId] = useState(() => workspace.activePageId(doc.fileId));
  const page = pages.find((p) => p.type === 'page' && p.id === activePageId) ?? pages.find((p) => p.type === 'page');
  const rootId = page && page.type === 'page' ? page.rootId : '';
  // Pan, zoom, drag ticks and the draw preview change every frame of a gesture. They live in small stores
  // that only the canvas and its overlays subscribe to, so the shell and panels do not re-render with them.
  const [viewport] = useState<ViewportStore>(() => new ValueStore<Viewport>(view.viewport));
  const [dragTick] = useState(() => new TickStore());
  const [drawDraft] = useState(() => new ValueStore<DrawDraft | null>(null));
  const [marquee] = useState(() => new ValueStore<Rect | null>(null));
  useEffect(() => {
    view.viewport = viewport.get();
    return viewport.subscribe(() => {
      view.viewport = viewport.get();
    });
  }, [view, viewport]);
  useEffect(() => {
    view.selection = selection.ids;
  }, [view, selection.ids]);
  const [tool, setTool] = useState<Tool>('move');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [collapseSignal, setCollapseSignal] = useState(0);
  const [commentFilter, setCommentFilter] = useState<CommentFilter>(DEFAULT_FILTER);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [copyMenu, setCopyMenu] = useState<CopyMenuState | null>(null);
  const [toast, setToast] = useState('');
  const [widths, setWidths] = usePanelWidths();
  const shownPageId = page?.id ?? activePageId;
  // Agents read the page the tab shows; the workspace remembers it per tab.
  useEffect(() => workspace.setActivePage(doc.fileId, shownPageId), [workspace, doc, shownPageId]);
  const rootRef = useRef(rootId);
  rootRef.current = rootId;

  useEffect(
    () =>
      surfaces.register(doc.fileId, {
        domTools: createDomTools({ doc, canvas: () => canvasRef.current, getSelection: selection.get }),
        thumbnail: () => {
          // The layer chosen with Set as thumbnail while it exists; on another page it is not on screen, so the old image stays.
          const chosen = workspace.library.get(doc.fileId)?.thumbnailNodeId;
          const id = chosen && doc.getNode(chosen) ? chosen : doc.getNode(rootRef.current)?.children[0];
          return captureThumbnail(canvasRef.current, id);
        },
      }),
    [surfaces, workspace, doc, selection.get],
  );

  const setThumbnail = useCallback(
    async (id: string) => {
      const thumbnail = await captureThumbnail(canvasRef.current, id);
      if (!thumbnail) throw new Error('the layer has no size on screen');
      workspace.library.touch(doc.fileId, { thumbnail, thumbnailNodeId: id });
      return 'Thumbnail set';
    },
    [workspace, doc],
  );

  const canvasMiddle = useCallback(() => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 };
  }, []);

  // Zoom commands glide to their view instead of jumping. A pan or zoom by the user mid-way wins at once.
  const glide = useRef<{ frame: number; to: Viewport } | null>(null);
  const glideTo = useCallback(
    (next: (base: Viewport) => Viewport) => {
      const current = glide.current;
      if (current) cancelAnimationFrame(current.frame);
      glide.current = null;
      const from = viewport.get();
      // Repeated presses step on from where the last glide is heading, not from a frame in between.
      const to = next(current ? current.to : from);
      if (typeof requestAnimationFrame !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        viewport.set(to);
        return;
      }
      const mid = canvasMiddle();
      const start = performance.now();
      let shown = from;
      const step = (now: number) => {
        if (viewport.get() !== shown) {
          glide.current = null;
          return;
        }
        const t = Math.min(1, (now - start) / GLIDE_MS);
        shown = blendViewport(from, to, 1 - (1 - t) ** 4, mid);
        viewport.set(shown);
        if (t < 1 && glide.current) glide.current.frame = requestAnimationFrame(step);
        else glide.current = null;
      };
      glide.current = { frame: requestAnimationFrame(step), to };
    },
    [viewport, canvasMiddle],
  );
  useEffect(
    () => () => {
      if (glide.current) cancelAnimationFrame(glide.current.frame);
    },
    [],
  );

  const zoomToFit = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ids = selection.get().length ? selection.get() : doc.requireNode(rootId).children;
    const box = unionRects(ids.map((id) => measureNode(canvas, id, viewport.get())).filter((r): r is Rect => r !== null));
    if (box) glideTo(() => fitRect(box, canvas.getBoundingClientRect()));
  }, [doc, rootId, selection.get, viewport, glideTo]);

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
      // Switching to another app keeps the edit open; only a blur inside the app commits it.
      const onBlur = () => keepEditingAcrossWindowBlur(el) || finish(true);
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

  const viewportCenter = useCallback(() => {
    const box = canvasRef.current?.getBoundingClientRect();
    return screenToWorld(viewport.get(), { x: (box?.width ?? 0) / 2, y: (box?.height ?? 0) / 2 });
  }, [viewport]);

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
      // Both keep the centre of the canvas where it is.
      zoomTo: (zoom) => glideTo((v) => zoomAt(v, canvasMiddle(), zoom / v.zoom)),
      zoomStep: (direction) => glideTo((v) => zoomAt(v, canvasMiddle(), stepZoom(v.zoom, direction) / v.zoom)),
      startRename: setRenamingId,
      collapseLayers: () => setCollapseSignal((n) => n + 1),
      notify: setToast,
      viewportCenter,
      setThumbnail,
    }),
    [doc, actor, undo, rootId, selection.get, selection.set, zoomToFit, glideTo, viewportCenter, canvasMiddle, setThumbnail],
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

  // Files dragged in from the OS land like a paste, centred where they are dropped. The window-wide handler
  // refuses file drops not claimed here, so dragover must preventDefault for the drop to arrive at all.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer!.files);
      if (!files.length) return;
      const box = el.getBoundingClientRect();
      const at = screenToWorld(viewport.get(), { x: e.clientX - box.left, y: e.clientY - box.top });
      // A drop lands where it was dropped, as its own artboard, whatever happens to be selected.
      pasteIntoDoc(doc, actor, { files }, { selection: [], rootId, viewportCenter: at }).then(
        (ids) => ids.length && selection.set(ids),
        (err: unknown) => setToast(err instanceof Error ? err.message : `Could not drop: ${String(err)}`),
      );
    };
    el.addEventListener('dragover', onDragOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragover', onDragOver);
      el.removeEventListener('drop', onDrop);
    };
  }, [doc, actor, selection, rootId, viewport]);

  const placeComment = useCallback(
    (at: { nodeId: string | null; x: number; y: number }) => {
      setThreadId(null);
      setDraft({ pageId: shownPageId, ...at });
    },
    [shownPageId],
  );

  const gestures = useCanvasGestures({ canvasRef, viewport, tool, setTool, rootId, dragTick, startTextEdit, placeComment, onDraw: drawDraft.set, onMarquee: marquee.set });

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
    const v = viewport.get();
    const world = anchorWorld(canvas, thread, v);
    const box = canvas.getBoundingClientRect();
    if (!world || box.width === 0) return;
    const at = worldToScreen(v, world);
    if (at.x < 24 || at.y < 24 || at.x > box.width - 360 || at.y > box.height - 24) viewport.set({ ...v, x: box.width / 2 - world.x * v.zoom - 160, y: box.height / 2 - world.y * v.zoom });
  }, [revealId, doc, shownPageId, viewport]);

  // Stable panel props: the memoized side panels then skip shell re-renders that do not concern them.
  const changePage = useCallback(
    (id: string) => {
      setActivePageId(id);
      selection.set([]);
      setThreadId(null);
      setDraft(null);
    },
    [selection.set],
  );
  const endRename = useCallback(() => setRenamingId(null), []);
  const commentsProps = useMemo(
    () => ({ activePageId: shownPageId, filter: commentFilter, onFilter: setCommentFilter, selectedId: threadId, onSelect: openThread }),
    [shownPageId, commentFilter, threadId, openThread],
  );
  const leftResizer = useMemo(() => <PanelResizer side="left" width={widths.left} onWidth={(left) => setWidths((w) => ({ ...w, left }))} />, [widths.left, setWidths]);
  const rightResizer = useMemo(() => <PanelResizer side="right" width={widths.right} onWidth={(right) => setWidths((w) => ({ ...w, right }))} />, [widths.right, setWidths]);
  const panelTop = useMemo(() => <PanelTop bridgeStatus={bridgeStatus} viewport={viewport} onZoom={(command) => runCommand(command, ctx)} />, [bridgeStatus, viewport, ctx]);
  const noSelection = useMemo(() => (rootId ? <NoSelection pageRootId={rootId} /> : null), [rootId]);

  const createComment = (d: Draft, body: string) => {
    const id = doc.createThread(actor, { ...d, body });
    setDraft(null);
    setThreadId(id);
    setTool('move');
  };

  if (!rootId || !page || page.type !== 'page') return null;

  return (
    <div className="editor">
      <main className="workspace" style={{ gridTemplateColumns: `${widths.left}px ${RAIL_WIDTH}px minmax(0, 1fr) ${widths.right}px` }}>
        <LayersPanel
          activePageId={page.id}
          onPage={changePage}
          renamingId={renamingId}
          onRenameDone={endRename}
          collapseSignal={collapseSignal}
          onContextMenu={setCopyMenu}
          resizer={leftResizer}
          onNotify={setToast}
        />
        <div className="tool-rail" role="toolbar" aria-label="Tools" aria-orientation="vertical">
          {RAIL_TOOLS.map((t) => (
            <Fragment key={t.id}>
              <button
                className={`tool-button ${tool === t.id ? 'is-active' : ''}`}
                aria-pressed={tool === t.id}
                aria-label={`${t.label} (${t.shortcut})`}
                aria-keyshortcuts={t.shortcut}
                data-tip={t.label}
                data-tip-key={t.shortcut}
                data-tip-side="right"
                onClick={() => setTool(t.id)}
              >
                {icons[t.id]}
              </button>
              {TOOL_GROUP_ENDS.has(t.id) && <span className="tool-rail-sep" aria-hidden />}
            </Fragment>
          ))}
        </div>
        <Canvas
          containerRef={canvasRef}
          rootId={rootId}
          viewport={viewport}
          cursor={CURSORS[tool]}
          selectedIds={selection.ids}
          dragTick={dragTick}
          onLabelDown={gestures.onLabelDown}
          onPointerDown={gestures.onPointerDown}
          overlay={
            <>
              <HoverOverlay canvasRef={canvasRef} viewport={viewport} rootId={rootId} tool={tool} selectedIds={selection.ids} dragTick={dragTick} />
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
              <DrawPreview draft={drawDraft} viewport={viewport} />
              <MarqueePreview box={marquee} viewport={viewport} />
            </>
          }
        />
        <RightPanel comments={commentsProps} resizer={rightResizer} pageRootId={rootId} top={panelTop} noSelection={noSelection} />
        <UpdateNotice />
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
