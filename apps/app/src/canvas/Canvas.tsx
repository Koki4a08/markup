import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { parsePxValue } from './geometry';
import { NodeView } from './NodeView';
import { worldToScreen, zoomAt, type Viewport } from './viewport';
import { useChildren, useDeep, useNode, useWorking } from '../store/hooks';
import { useDoc } from '../store/DocProvider';
import { ensureFontsLoaded, fontFacesUsed } from '../fonts/fontLoader';
import { knownLocalFonts, listLocalFonts } from '../fonts/localFonts';

interface CanvasProps {
  rootId: string;
  viewport: Viewport;
  onViewport: (v: Viewport | ((prev: Viewport) => Viewport)) => void;
  /** Screen-space layer drawn above the content (selection, handles). */
  overlay?: ReactNode;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  cursor?: string;
  containerRef?: RefObject<HTMLDivElement | null>;
}

/** Infinite canvas: pans with wheel or Space/H drag, zooms with ctrl/⌘ + wheel at the cursor. */
export function Canvas({ rootId, viewport, onViewport, overlay, onPointerDown, cursor, containerRef }: CanvasProps) {
  const ownRef = useRef<HTMLDivElement>(null);
  const ref = containerRef ?? ownRef;
  const artboards = useChildren(rootId);
  useFontLoading(rootId);
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

/** First family of each font stack used by the page's nodes, quotes stripped. */
function usedFamilies(doc: ReturnType<typeof useDoc>['doc'], rootId: string): string[] {
  return [...new Set(fontFacesUsed(doc, [rootId]).map((f) => f.family))].sort();
}

/** Loads the Google Fonts the active page uses right away, skipping families already known to be local. */
function useFontLoading(rootId: string) {
  const { doc } = useDoc();
  const families = useDeep(doc.nodes, () => usedFamilies(doc, rootId));
  useEffect(() => {
    if (!families.length) return;
    void ensureFontsLoaded(families, knownLocalFonts());
    void listLocalFonts(); // warms the list when access was already granted; never prompts or blocks
  }, [families]);
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
