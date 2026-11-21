import { useLayoutEffect, useState, type RefObject } from 'react';
import { worldToScreen, type Point } from '../canvas/viewport';
import { useDocTick } from '../canvas/SelectionOverlay';
import { useStore, useTick, type TickStore, type ViewportStore } from '../canvas/store';
import { icons } from '../panels/icons';
import { useDoc } from '../store/DocProvider';
import { anchorWorld } from './anchor';
import { useThreads } from './hooks';
import { isUnread, pinVisible, useSeen, type CommentFilter, type Draft } from './state';
import { ThreadPopover } from './ThreadPopover';

interface Props {
  canvasRef: RefObject<HTMLDivElement | null>;
  viewport: ViewportStore;
  pageId: string;
  filter: CommentFilter;
  selectedId: string | null;
  draft: Draft | null;
  dragTick: TickStore;
  onSelect(id: string | null): void;
  onCancelDraft(): void;
  onCreate(draft: Draft, body: string): void;
}

interface Placed {
  id: string;
  n: number;
  x: number;
  y: number;
}

const POPOVER_WIDTH = 320;

/** Screen-space pins for the page threads, plus the open thread popover or the draft composer. */
export function CommentLayer({ canvasRef, viewport: viewportStore, pageId, filter, selectedId, draft, dragTick: dragStore, onSelect, onCancelDraft, onCreate }: Props) {
  const { doc, actor } = useDoc();
  const tick = useDocTick();
  const viewport = useStore(viewportStore);
  const dragTick = useTick(dragStore);
  const all = useThreads();
  const seen = useSeen(doc.fileId);
  // Pin anchors in world space: measured when threads, the document or a drag change, not on pan or zoom.
  const [anchors, setAnchors] = useState<Placed[]>([]);
  const [draftWorld, setDraftWorld] = useState<Point | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => setCanvasWidth(canvas.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [canvasRef]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const v = viewportStore.get();
    // Pin numbers follow creation order on the page, so filtering never renumbers them.
    const onPage = all.filter((t) => t.pageId === pageId).sort((a, b) => a.createdAt - b.createdAt);
    const next: Placed[] = [];
    onPage.forEach((t, i) => {
      if (!pinVisible(t, filter)) return;
      const w = anchorWorld(canvas, t, v);
      if (!w) return;
      next.push({ id: t.id, n: i + 1, x: w.x, y: w.y });
    });
    setAnchors(next);
    setDraftWorld(draft ? anchorWorld(canvas, draft, v) : null);
  }, [canvasRef, all, filter, viewportStore, pageId, draft, tick, dragTick]);

  const placed = anchors.map((a) => ({ ...a, ...worldToScreen(viewport, a) }));
  const draftAt = draftWorld && worldToScreen(viewport, draftWorld);

  const selected = selectedId ? all.find((t) => t.id === selectedId) : undefined;
  const selectedPin = selected && placed.find((p) => p.id === selected.id);
  const popoverPos = (p: { x: number; y: number }) => ({
    left: canvasWidth > 0 && p.x + 16 + POPOVER_WIDTH > canvasWidth ? p.x - 16 - POPOVER_WIDTH : p.x + 16,
    top: Math.max(8, p.y - 16),
  });

  return (
    <div className="comment-layer">
      {placed.map((p) => {
        const t = all.find((x) => x.id === p.id)!;
        const unread = isUnread(t, seen, actor.id);
        return (
          <button
            key={p.id}
            className={`comment-pin ${t.status === 'resolved' ? 'is-resolved' : ''} ${unread ? 'has-unread' : ''} ${p.id === selectedId ? 'is-selected' : ''}`}
            style={{ transform: `translate(${p.x}px, ${p.y}px)` }}
            aria-label={`Comment thread ${p.n}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onSelect(p.id === selectedId ? null : p.id)}
          >
            {p.n}
          </button>
        );
      })}
      {draft && draftAt && (
        <>
          <span className="comment-pin is-draft" style={{ transform: `translate(${draftAt.x}px, ${draftAt.y}px)` }} aria-hidden="true">
            {icons.plus}
          </span>
          <ThreadPopover thread={null} {...popoverPos(draftAt)} onClose={onCancelDraft} onCreate={(body) => onCreate(draft, body)} />
        </>
      )}
      {!draft && selected && selectedPin && <ThreadPopover key={selected.id} thread={selected} {...popoverPos(selectedPin)} onClose={() => onSelect(null)} onCreate={() => {}} />}
    </div>
  );
}
