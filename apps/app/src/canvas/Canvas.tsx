import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { MarkupDoc } from '@markup/doc';
import { measureElement, parsePxValue, sameRect, type Rect } from './geometry';
import { useDocTick } from './SelectionOverlay';
import { InlineRename } from '../ui/InlineRename';
import { DeferredNodeView } from './NodeView';
import { nodeElementIn } from './registry';
import { useStore, useTick, type TickStore, type ViewportStore } from './store';
import { attachNavigation } from './navigation';
import { worldToScreen, type Viewport } from './viewport';
import { useChildren, useNode, useWorking } from '../store/hooks';
import { useDoc } from '../store/DocProvider';
import { ensureFontsLoaded, fontFacesUsed } from '../fonts/fontLoader';
import { knownLocalFonts, listLocalFonts } from '../fonts/localFonts';

interface CanvasProps {
  rootId: string;
  /** Pan and zoom; the canvas reads and writes it without re-rendering whoever owns the store. */
  viewport: ViewportStore;
  /** Screen-space layer drawn above the content (selection, handles). */
  overlay?: ReactNode;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  cursor?: string;
  containerRef?: RefObject<HTMLDivElement | null>;
  /** Selected node ids; the labels of selected artboards are highlighted. */
  selectedIds?: string[];
  /** Bumped while a gesture previews a move or resize, so artboard chrome follows the live position. */
  dragTick?: TickStore;
  /** Pointer down on an artboard's title: select and drag that artboard. */
  onLabelDown?: (id: string, e: React.PointerEvent) => void;
}

/** How long after the last wheel or pan event the world layer stays promoted to its own compositor layer. */
const MOTION_IDLE_MS = 150;

/** Infinite canvas: pans with wheel, trackpad, two fingers or Space/H drag; zooms with pinch or ctrl/⌘ + wheel at the cursor. */
export function Canvas({ rootId, viewport: viewportStore, overlay, onPointerDown, cursor, containerRef, selectedIds, dragTick: dragStore, onLabelDown }: CanvasProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = containerRef ?? ownRef;
  const worldRef = useRef<HTMLDivElement>(null);
  const viewport = useStore(viewportStore);
  const dragTick = useTick(dragStore);
  const artboards = useChildren(rootId);
  const working = useWorking();
  const rects = useArtboardRects(artboards, ref, viewportStore, dragTick);
  useFontLoading(rootId);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panning = useRef<{ x: number; y: number } | null>(null);
  const motionTimer = useRef(0);

  // will-change only while the view moves, so pans and zooms composite and content re-rasters crisply after.
  // Toggled on the element directly: going through React state would re-render on every event.
  const markMoving = () => {
    const world = worldRef.current;
    if (!world) return;
    world.classList.add('is-moving');
    clearTimeout(motionTimer.current);
    motionTimer.current = window.setTimeout(() => world.classList.remove('is-moving'), MOTION_IDLE_MS);
  };
  useEffect(() => () => clearTimeout(motionTimer.current), []);

  // Wheel, trackpad pan and pinch, Safari gesture events and two-finger touch: see navigation.ts.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attachNavigation(el, { update: (fn) => viewportStore.set(fn), moving: markMoving });
  }, [viewportStore]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Alt+Space is the window's system menu, whose loop swallows the keyup: never the hand tool.
      if (e.code === 'Space' && !e.altKey && !e.ctrlKey && !e.metaKey && !isTyping(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpaceHeld(false);
    // Space released in another app never sends keyup here; leaving the window drops the hand tool and any pan.
    const blur = () => {
      setSpaceHeld(false);
      panning.current = null;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (spaceHeld || e.button === 1 || cursor === 'grab') {
      panning.current = { x: e.clientX, y: e.clientY };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    onPointerDown?.(e);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = panning.current;
    if (!start) return;
    panning.current = { x: e.clientX, y: e.clientY };
    markMoving();
    viewportStore.set((v) => ({ ...v, x: v.x + e.clientX - start.x, y: v.y + e.clientY - start.y }));
  };

  const endPan = () => {
    panning.current = null;
  };

  return (
    <div
      ref={ref}
      className="canvas"
      style={{ cursor: spaceHeld || cursor === 'grab' ? (panning.current ? 'grabbing' : 'grab') : cursor }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
    >
      <div className="canvas-backdrop" aria-hidden>
        {artboards.map((id) => (
          <ArtboardBackdrop key={id} id={id} viewport={viewport} rect={rects.get(id) ?? null} working={!!working[id]} />
        ))}
      </div>
      <div ref={worldRef} className="canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        {/* Heavy artboards (opening a big file, pasting one) mount one by one behind a shimmer. */}
        {artboards.map((id) => (
          <DeferredNodeView key={id} id={id} />
        ))}
      </div>
      <div className="canvas-agent-fx" aria-hidden>
        {artboards.map((id) => (working[id] ? <AgentSweep key={id} id={id} viewport={viewport} rect={rects.get(id) ?? null} /> : null))}
      </div>
      <div className="canvas-labels">
        {artboards.map((id) => (
          <ArtboardLabel key={id} id={id} viewport={viewport} selected={!!selectedIds?.includes(id)} rect={rects.get(id) ?? null} working={working[id]} onDown={onLabelDown} />
        ))}
      </div>
      {overlay}
    </div>
  );
}

/** First family of each font stack used by the page's nodes, quotes stripped. */
function usedFamilies(doc: MarkupDoc, rootId: string): string[] {
  return [...new Set(fontFacesUsed(doc, [rootId]).map((f) => f.family))].sort();
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** How long a burst of edits is coalesced before the page is walked again for the fonts it uses. */
const FONT_SCAN_DELAY_MS = 100;
const NO_FAMILIES: string[] = [];

/**
 * Loads the Google Fonts the active page uses right away, skipping families already known to be local.
 * The page walk runs off the render path: once per page, then at most once per burst of edits.
 */
function useFontLoading(rootId: string) {
  const { doc } = useDoc();
  const [families, setFamilies] = useState<string[]>(NO_FAMILIES);
  useEffect(() => {
    let timer = 0;
    const scan = () => {
      timer = 0;
      const next = usedFamilies(doc, rootId);
      setFamilies((prev) => (sameList(prev, next) ? prev : next));
    };
    scan();
    const onChange = () => {
      if (!timer) timer = window.setTimeout(scan, FONT_SCAN_DELAY_MS);
    };
    doc.nodes.observeDeep(onChange);
    return () => {
      doc.nodes.unobserveDeep(onChange);
      clearTimeout(timer);
    };
  }, [doc, rootId]);
  useEffect(() => {
    if (!families.length) return;
    void ensureFontsLoaded(families, knownLocalFonts());
    void listLocalFonts(); // warms the list when access was already granted; never prompts or blocks
  }, [families]);
}

const NO_RECTS: ReadonlyMap<string, Rect> = new Map();

/**
 * World-space rect of every artboard as rendered, so margins, translate and the live drag preview all
 * count, not just the stored left/top. Measured once per artboard per change (document transaction,
 * preview, drag frame, or a size change the ResizeObserver reports) and shared by backdrop and label.
 */
function useArtboardRects(ids: string[], containerRef: RefObject<HTMLDivElement | null>, viewportStore: ViewportStore, dragTick: number): ReadonlyMap<string, Rect> {
  const docTick = useDocTick();
  const [resized, setResized] = useState(0);
  const [rects, setRects] = useState(NO_RECTS);
  const observer = useRef<{ ro: ResizeObserver; els: Map<string, Element> } | null>(null);

  useLayoutEffect(() => {
    const canvas = containerRef.current;
    if (!canvas) return;
    if (!observer.current && typeof ResizeObserver !== 'undefined') observer.current = { ro: new ResizeObserver(() => setResized((n) => n + 1)), els: new Map() };
    const watch = observer.current;
    const origin = canvas.getBoundingClientRect();
    const viewport = viewportStore.get();
    const next = new Map<string, Rect>();
    const live = new Set(ids);
    for (const id of ids) {
      const el = nodeElementIn(canvas, id);
      // Each artboard element is observed once; only a new element (or a new artboard) is (re)observed.
      if (watch && watch.els.get(id) !== el) {
        const old = watch.els.get(id);
        if (old) watch.ro.unobserve(old);
        if (el) {
          watch.ro.observe(el);
          watch.els.set(id, el);
        } else watch.els.delete(id);
      }
      if (el) next.set(id, measureElement(el, origin, viewport));
    }
    if (watch)
      for (const [id, el] of watch.els)
        if (!live.has(id)) {
          watch.ro.unobserve(el);
          watch.els.delete(id);
        }
    setRects((prev) => (prev.size === next.size && [...next].every(([id, r]) => sameRect(prev.get(id), r)) ? prev : next));
  }, [containerRef, ids, viewportStore, docTick, dragTick, resized]);

  useEffect(
    () => () => {
      observer.current?.ro.disconnect();
      observer.current = null;
    },
    [],
  );
  return rects;
}

/**
 * Drop shadow (and, while an agent edits it, a violet ring) behind one artboard. Drawn in screen space
 * under the world so it never becomes part of the design DOM that agents read and exports copy.
 */
function ArtboardBackdrop({ id, viewport, rect, working }: { id: string; viewport: Viewport; rect: Rect | null; working: boolean }) {
  const node = useNode(id);
  if (!node || node.hidden || !rect?.width || !rect.height) return null;
  const p = worldToScreen(viewport, rect);
  const radius = parsePxValue(node.styles.borderRadius) * viewport.zoom;
  return (
    <div
      className={`artboard-backdrop ${working ? 'is-working' : ''}`}
      style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: rect.width * viewport.zoom, height: rect.height * viewport.zoom, borderRadius: radius || undefined }}
    />
  );
}

/**
 * Soft light band that drifts across an artboard every few seconds while an agent edits it. Drawn above
 * the world in screen space (pointer-events off), so it never touches the design DOM or exports.
 */
function AgentSweep({ id, viewport, rect }: { id: string; viewport: Viewport; rect: Rect | null }) {
  const node = useNode(id);
  if (!node || node.hidden || !rect?.width || !rect.height) return null;
  const p = worldToScreen(viewport, rect);
  const radius = parsePxValue(node.styles.borderRadius) * viewport.zoom;
  return (
    <div
      className="agent-sweep"
      style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: rect.width * viewport.zoom, height: rect.height * viewport.zoom, borderRadius: radius || undefined }}
    />
  );
}

const DOT_ROWS = 3;
const DOT_COLS = 14;
/** Stable per-dot jitter so the field twinkles unevenly but renders the same every time. */
const DOTS = Array.from({ length: DOT_ROWS * DOT_COLS }, (_, i) => {
  const col = i % DOT_COLS;
  const jitter = (Math.sin(i * 12.9898) * 43758.5453) % 1;
  const r = Math.abs(jitter);
  return { delay: col * 85 + r * 700, duration: 1300 + r * 900 };
});

/** Twinkling dot field shown next to an artboard's name while an agent edits it. */
function AgentDots({ name }: { name: string }) {
  return (
    <span className="agent-working" title={`${name} is editing`}>
      <span className="agent-dots" aria-hidden>
        {DOTS.map((d, i) => (
          <i key={i} style={{ animationDelay: `${d.delay}ms`, animationDuration: `${d.duration}ms` }} />
        ))}
      </span>
      <span className="agent-working-name">{name} is editing</span>
    </span>
  );
}

function ArtboardLabel({
  id,
  viewport,
  selected,
  rect,
  working,
  onDown,
}: {
  id: string;
  viewport: Viewport;
  selected: boolean;
  rect: Rect | null;
  working?: { name: string };
  onDown?: (id: string, e: React.PointerEvent) => void;
}) {
  const { doc, actor } = useDoc();
  const node = useNode(id);
  if (!node || node.hidden) return null;
  // Before the first measurement (and in tests without layout) fall back to the stored position.
  const p = worldToScreen(viewport, rect ?? { x: parsePxValue(node.styles.left), y: parsePxValue(node.styles.top) });
  const width = rect ? rect.width * viewport.zoom : undefined;
  return (
    <div className={`artboard-label ${selected ? 'is-selected' : ''}`} style={{ transform: `translate(${p.x}px, ${p.y - 24}px)`, maxWidth: width && width > 40 ? width : undefined }} data-artboard-label={id}>
      <InlineRename
        className="artboard-name"
        label="Artboard name"
        value={node.name}
        onPointerDown={onDown && ((e) => onDown(id, e))}
        onCommit={(name) => doc.renameNodes(actor, [{ nodeId: id, name }])}
      />
      {working && <AgentDots name={working.name} />}
    </div>
  );
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}

const CONTROL = 'button, a[href], [role=button], [role=tab], [role=menuitem]';
const OWN_KEYS = new Set(['Enter', ' ', 'Backspace', 'Delete']);

/**
 * True when a focused control should keep this key for itself. Inside comment UI every key stays local;
 * on other buttons, tabs and links only the keys they act on do (Enter, Space, Backspace, Delete), so tool letters and modifier chords still work.
 */
export function controlOwnsKey(target: EventTarget | null, e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.closest('.comment-popover, .comments-panel')) return true;
  return !!el.closest(CONTROL) && !e.metaKey && !e.ctrlKey && !e.altKey && OWN_KEYS.has(e.key);
}
