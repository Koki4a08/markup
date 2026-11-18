import { useEffect, useRef, useState, type ReactNode } from 'react';
import { parsePxValue } from './geometry';
import { NodeView } from './NodeView';
import { worldToScreen, zoomAt, type Viewport } from './viewport';
import { useChildren, useNode, useWorking } from '../store/hooks';

interface CanvasProps {
  rootId: string;
  viewport: Viewport;
  onViewport: (v: Viewport | ((prev: Viewport) => Viewport)) => void;
  /** Screen-space layer drawn above the content (selection, handles). */
  overlay?: ReactNode;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  cursor?: string;
}

/** Infinite canvas: pans with wheel or Space/H drag, zooms with ctrl/⌘ + wheel at the cursor. */
export function Canvas({ rootId, viewport, onViewport, overlay, onPointerDown, cursor }: CanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  const artboards = useChildren(rootId);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panning = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.01);
        onViewport((v) => zoomAt(v, { x: e.clientX - rect.left, y: e.clientY - rect.top }, factor));
      } else {
        const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
        onViewport((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onViewport]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target)) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpaceHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
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
    onViewport((v) => ({ ...v, x: v.x + e.clientX - start.x, y: v.y + e.clientY - start.y }));
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
      <div className="canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        {artboards.map((id) => (
          <NodeView key={id} id={id} />
        ))}
      </div>
      <div className="canvas-labels">
        {artboards.map((id) => (
          <ArtboardLabel key={id} id={id} viewport={viewport} />
        ))}
      </div>
      {overlay}
    </div>
  );
}

function ArtboardLabel({ id, viewport }: { id: string; viewport: Viewport }) {
  const node = useNode(id);
  const working = useWorking()[id];
  if (!node || node.hidden) return null;
  const p = worldToScreen(viewport, { x: parsePxValue(node.styles.left), y: parsePxValue(node.styles.top) });
  return (
    <div className="artboard-label" style={{ transform: `translate(${p.x}px, ${p.y - 22}px)` }} data-artboard-label={id}>
      <span className="artboard-name">{node.name}</span>
      {working && <span className="working-pill">{working.name} is editing</span>}
    </div>
  );
}

export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
}
