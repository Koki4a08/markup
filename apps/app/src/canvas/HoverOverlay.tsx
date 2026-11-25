import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { measureNode, sameRect, sameRects, type Rect } from './geometry';
import type { DrawDraft } from './gestures';
import { childIds, hitPath, nodeFlags, pickFromPath } from './interactions';
import { useDocTick } from './SelectionOverlay';
import { useStore, useTick, type TickStore, type ValueStore, type ViewportStore } from './store';
import type { Tool } from './tools';
import { screenToWorld, worldToScreen, type Point } from './viewport';
import { useDoc } from '../store/DocProvider';

interface Props {
  canvasRef: RefObject<HTMLDivElement | null>;
  viewport: ViewportStore;
  rootId: string;
  tool: Tool;
  selectedIds: string[];
  dragTick: TickStore;
}

interface Shapes {
  hover: Rect | null;
  children: Rect[];
  all: Rect[];
}

const sameShapes = (a: Shapes, b: Shapes) => sameRect(a.hover, b.hover) && sameRects(a.children, b.children) && sameRects(a.all, b.all);

const isDeepKey = (e: { ctrlKey: boolean; metaKey: boolean }) => e.ctrlKey || e.metaKey;

/**
 * Hover feedback for the move tool: an outline on the node a click would pick, faint outlines on its
 * children, and with Ctrl/⌘ held every layer inside the artboard under the pointer, so small nested
 * layers can be found and clicked directly (a deep click picks the innermost).
 */
export function HoverOverlay({ canvasRef, viewport: viewportStore, rootId, tool, selectedIds, dragTick: dragStore }: Props) {
  const { doc } = useDoc();
  const docTick = useDocTick();
  const viewport = useStore(viewportStore);
  const dragTick = useTick(dragStore);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [deep, setDeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const frame = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onMove = (e: PointerEvent) => {
      setDeep(isDeepKey(e));
      setBusy(e.buttons !== 0);
      const box = canvas.getBoundingClientRect();
      const at = { x: e.clientX - box.left, y: e.clientY - box.top };
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => setPointer(at));
    };
    const onLeave = () => {
      cancelAnimationFrame(frame.current);
      setPointer(null);
    };
    const onUp = () => setBusy(false);
    const onKey = (e: KeyboardEvent) => setDeep(isDeepKey(e));
    const onBlur = () => setDeep(false);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      cancelAnimationFrame(frame.current);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [canvasRef]);

  const [shapes, setShapes] = useState<Shapes>({ hover: null, children: [], all: [] });
  /** Deep-mode outlines of one artboard, kept while the artboard, document and drag state stay the same. */
  const deepCache = useRef<{ artboard: string; docTick: number; dragTick: number; all: Rect[] } | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!deep) deepCache.current = null;
    if (!canvas || !pointer || tool !== 'move' || busy) return setShapes((s) => (s.hover || s.all.length ? { hover: null, children: [], all: [] } : s));
    // One origin read and one measurement per node for the whole pass.
    const origin = canvas.getBoundingClientRect();
    const measured = new Map<string, Rect | null>();
    const rectOf = (id: string) => {
      let r = measured.get(id);
      if (r === undefined) measured.set(id, (r = measureNode(canvas, id, viewport, origin)));
      return r;
    };
    const world = screenToWorld(viewport, pointer);
    const path = hitPath(doc, rootId, world, rectOf);
    const target = pickFromPath(doc, path, selectedIds, deep);
    const visible = (id: string) => {
      const n = nodeFlags(doc, id);
      return !!n && !n.hidden;
    };
    const children = target && nodeFlags(doc, target)?.type === 'frame' ? childIds(doc, target).filter(visible).map(rectOf).filter((r): r is Rect => !!r) : [];
    let all: Rect[] = [];
    if (deep && path[0]) {
      const cached = deepCache.current;
      if (cached && cached.artboard === path[0] && cached.docTick === docTick && cached.dragTick === dragTick) all = cached.all;
      else {
        const walk = (id: string) => {
          for (const c of childIds(doc, id)) {
            if (!visible(c)) continue;
            const r = rectOf(c);
            if (r) all.push(r);
            walk(c);
          }
        };
        walk(path[0]);
        deepCache.current = { artboard: path[0], docTick, dragTick, all };
      }
    }
    const next = { hover: target && !selectedIds.includes(target) ? rectOf(target) : null, children, all };
    setShapes((prev) => (sameShapes(prev, next) ? prev : next));
  }, [canvasRef, pointer, viewport, rootId, tool, selectedIds, deep, busy, doc, docTick, dragTick]);

  const box = (r: Rect, cls: string, key: string | number) => {
    const p = worldToScreen(viewport, r);
    return <div key={key} className={cls} style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: r.width * viewport.zoom, height: r.height * viewport.zoom }} />;
  };

  return (
    <div className={`hover-layer ${deep ? 'is-deep' : ''}`} aria-hidden>
      {shapes.all.map((r, i) => box(r, 'hover-outline is-faint', `a${i}`))}
      {!deep && shapes.children.map((r, i) => box(r, 'hover-outline is-child', `c${i}`))}
      {shapes.hover && box(shapes.hover, 'hover-outline', 'h')}
    </div>
  );
}

/** The frame or rectangle being drawn, shown live as it will be created, with its size. */
export function DrawPreview({ draft: draftStore, viewport: viewportStore }: { draft: ValueStore<DrawDraft | null>; viewport: ViewportStore }) {
  const draft = useStore(draftStore);
  const viewport = useStore(viewportStore);
  if (!draft) return null;
  const p = worldToScreen(viewport, draft.rect);
  const width = draft.rect.width * viewport.zoom;
  const height = draft.rect.height * viewport.zoom;
  return (
    <div className="draw-layer" aria-hidden>
      {draft.artboard && (
        <div className="artboard-label is-selected draw-label" style={{ transform: `translate(${p.x}px, ${p.y - 24}px)` }}>
          <span className="artboard-name">{draft.name}</span>
        </div>
      )}
      <div className={`draw-box is-${draft.artboard ? 'artboard' : draft.kind}`} style={{ transform: `translate(${p.x}px, ${p.y}px)`, width, height }}>
        <span className="size-pill">
          {Math.round(draft.rect.width)} × {Math.round(draft.rect.height)}
        </span>
      </div>
    </div>
  );
}

/** The drag-select box, in screen space above the content. */
export function MarqueePreview({ box: boxStore, viewport: viewportStore }: { box: ValueStore<Rect | null>; viewport: ViewportStore }) {
  const box = useStore(boxStore);
  const viewport = useStore(viewportStore);
  if (!box) return null;
  const p = worldToScreen(viewport, box);
  return (
    <div className="draw-layer" aria-hidden>
      <div className="marquee-box" style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: box.width * viewport.zoom, height: box.height * viewport.zoom }} />
    </div>
  );
}
