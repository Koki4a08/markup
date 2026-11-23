import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { measureNode, sameRects, unionRects, type Rect } from './geometry';
import type { Handle } from './interactions';
import { useStore, useTick, type TickStore, type ViewportStore } from './store';
import { worldToScreen } from './viewport';
import { useDoc } from '../store/DocProvider';
import { subscribePreview } from './preview';
import { layoutTick, watchLayout } from './layoutTick';

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

const handlePos = (h: Handle, r: { width: number; height: number }) => ({
  left: h.includes('w') ? 0 : h.includes('e') ? r.width : r.width / 2,
  top: h.includes('n') ? 0 : h.includes('s') ? r.height : r.height / 2,
});

/** Re-renders after every document transaction so measured rects follow layout changes. */
export function useDocTick(): number {
  const { doc } = useDoc();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    doc.ydoc.on('afterTransaction', bump);
    // Live previews move nodes without a transaction; overlays re-measure for those too.
    const unsubscribe = subscribePreview(bump);
    // So do font and image loads and inline text edits, which change layout outside the document.
    watchLayout();
    const unsubscribeLayout = layoutTick.subscribe(bump);
    return () => {
      doc.ydoc.off('afterTransaction', bump);
      unsubscribe();
      unsubscribeLayout();
    };
  }, [doc]);
  return tick;
}

interface Props {
  canvasRef: RefObject<HTMLDivElement | null>;
  ids: string[];
  viewport: ViewportStore;
  /** Bumped by gestures while dragging so the overlay follows the live preview. */
  dragTick: TickStore;
  onHandleDown?: (handle: Handle, e: React.PointerEvent) => void;
}

export function SelectionOverlay({ canvasRef, ids, viewport: viewportStore, dragTick: dragStore, onHandleDown }: Props) {
  const tick = useDocTick();
  const viewport = useStore(viewportStore);
  const dragTick = useTick(dragStore);
  const [rects, setRects] = useState<Rect[]>([]);

  // World rects do not depend on pan or zoom: measured only when the selection, document or a drag changes,
  // and projected to the screen from the current viewport at render.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const v = viewportStore.get();
    const origin = canvas.getBoundingClientRect();
    const next = ids.map((id) => measureNode(canvas, id, v, origin)).filter((r): r is Rect => r !== null);
    setRects((prev) => (sameRects(prev, next) ? prev : next));
  }, [canvasRef, ids, viewportStore, tick, dragTick]);

  const box = unionRects(rects);
  if (!box) return null;
  const tl = worldToScreen(viewport, box);
  const screen = { width: box.width * viewport.zoom, height: box.height * viewport.zoom };

  return (
    <div className="selection-layer">
      {rects.length > 1 &&
        rects.map((r, i) => {
          const p = worldToScreen(viewport, r);
          return <div key={i} className="selection-item" style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: r.width * viewport.zoom, height: r.height * viewport.zoom }} />;
        })}
      <div className="selection-box" style={{ transform: `translate(${tl.x}px, ${tl.y}px)`, width: screen.width, height: screen.height }}>
        {onHandleDown &&
          HANDLES.map((h) => (
            <div
              key={h}
              className={`handle handle-${h}`}
              style={handlePos(h, screen)}
              onPointerDown={(e) => {
                e.stopPropagation();
                onHandleDown(h, e);
              }}
            />
          ))}
        <div className="size-pill">
          {Math.round(box.width)} × {Math.round(box.height)}
        </div>
      </div>
    </div>
  );
}
