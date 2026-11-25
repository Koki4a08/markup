import { useCallback, useRef, type RefObject } from 'react';
import type { MarkupDoc, NodeSpec, Styles } from '@markup/doc';
import { measureNode, parsePxValue, unionRects, type Rect } from './geometry';
import {
  childIds,
  flowDropTarget,
  freeformMove,
  hitPath,
  hitTest,
  inFlow,
  marqueeCandidates,
  marqueeHits,
  pageLayerStyles,
  pastWrappers,
  pickFromPath,
  resizeRect,
  JOIN_FLOW,
  type DropTarget,
  type Handle,
} from './interactions';
import { FlowPreview } from './flowPreview';
import type { Tool } from './tools';
import { screenToWorld, type Point } from './viewport';
import { useDoc } from '../store/DocProvider';
import { announceLive, endPreview } from './preview';
import { nodeElementIn } from './registry';
import type { TickStore, ViewportStore } from './store';
import { useSelection } from './selection';

const DRAG_THRESHOLD = 3;

export interface DrawDraft {
  kind: 'frame' | 'rect';
  /** True when the box lands on the page itself and becomes an artboard. */
  artboard: boolean;
  rect: Rect;
  name: string;
}

interface GestureOptions {
  canvasRef: RefObject<HTMLDivElement | null>;
  /** Read when a gesture needs it, so pan and zoom never re-create the handlers. */
  viewport: ViewportStore;
  tool: Tool;
  setTool(tool: Tool): void;
  rootId: string;
  /** Bumped while a move or resize previews, so overlays and artboard chrome follow (once per frame). */
  dragTick: TickStore;
  startTextEdit(id: string): void;
  /** Live box while drawing a frame or rectangle (world rect), null when the gesture ends. */
  onDraw?(draft: DrawDraft | null): void;
  /** Live drag-select box (world rect), null when the gesture ends. */
  onMarquee?(box: Rect | null): void;
  /** Comment tool click: the node under the pointer with the offset inside it, or the world point. */
  placeComment(at: { nodeId: string | null; x: number; y: number }): void;
}

const elOf = (canvas: HTMLElement, id: string) => nodeElementIn(canvas, id);

/**
 * Follows one pointer gesture through window events. Pointer up ends it with onUp. Pointer cancel, the window
 * losing focus (Alt+Tab mid-drag never delivers a pointerup) and Escape abort it with onCancel, which must put
 * back whatever the gesture previewed. Every listener goes away whichever way it ends.
 */
export function trackPointer(onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void, onCancel: () => void): void {
  const remove = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('blur', cancel);
    window.removeEventListener('keydown', onKey, true);
  };
  const up = (e: PointerEvent) => {
    remove();
    onUp(e);
  };
  const cancel = () => {
    remove();
    onCancel();
  };
  // Capture phase, so Escape aborts the drag instead of also clearing the selection or closing a panel.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
  window.addEventListener('keydown', onKey, true);
}

/** Pointer-driven editing: select, move, resize, draw frames and rectangles, place text. Each gesture commits one op. */
export function useCanvasGestures(o: GestureOptions) {
  const { doc, actor } = useDoc();
  const selection = useSelection();

  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const rect = o.canvasRef.current!.getBoundingClientRect();
      return screenToWorld(o.viewport.get(), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
    [o.canvasRef, o.viewport],
  );

  const rectOf = useCallback((id: string) => measureNode(o.canvasRef.current!, id, o.viewport.get()), [o.canvasRef, o.viewport]);

  /** rectOf for one hit-test pass: the canvas origin is read once and each node measured once. */
  const passRectOf = () => {
    const canvas = o.canvasRef.current!;
    const origin = canvas.getBoundingClientRect();
    const viewport = o.viewport.get();
    const measured = new Map<string, Rect | null>();
    return (id: string) => {
      let r = measured.get(id);
      if (r === undefined) measured.set(id, (r = measureNode(canvas, id, viewport, origin)));
      return r;
    };
  };

  // Chrome reports detail 0 on pointerdown (it counts clicks only on mouse events), so count them here.
  const lastDown = useRef({ t: 0, x: 0, y: 0, n: 0 });
  const clickCount = (e: React.PointerEvent): number => {
    if (e.detail > 0) return e.detail;
    const prev = lastDown.current;
    const again = e.timeStamp - prev.t < 500 && Math.abs(e.clientX - prev.x) < 5 && Math.abs(e.clientY - prev.y) < 5;
    lastDown.current = { t: e.timeStamp, x: e.clientX, y: e.clientY, n: again ? prev.n + 1 : 1 };
    return lastDown.current.n;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !o.canvasRef.current) return;
    const clicks = clickCount(e);
    const start = toWorld(e);
    if (o.tool === 'frame' || o.tool === 'rect') return drawBox(start, o.tool);
    if (o.tool === 'text') return placeText(start);
    if (o.tool === 'comment') return placeComment(start);
    const path = hitPath(doc, o.rootId, start, passRectOf());
    let hit = pickFromPath(doc, path, selection.get(), e.metaKey || e.ctrlKey);
    if (!hit) return selectBox(start, o.rootId, e.shiftKey, null);
    if (clicks === 2) {
      if (doc.getNode(hit)?.type === 'text') return o.startTextEdit(hit);
      // Double-click a frame: step one level into it, to the child under the pointer (past lone wrappers).
      const next = path.indexOf(hit) + 1;
      const inner = next < path.length ? path[pastWrappers(doc, path, next)] : undefined;
      if (inner) {
        hit = inner;
        selection.set([inner]);
        if (doc.getNode(inner)?.type === 'text') return;
      }
    }
    const current = selection.get();
    // Pressed on an artboard's empty area: a drag draws a selection box over its layers, a click still picks it.
    if (clicks === 1 && !e.altKey && !current.includes(hit) && onBackground(path, hit)) return selectBox(start, path[0]!, e.shiftKey, hit);
    if (e.shiftKey) return selection.set(current.includes(hit) ? current.filter((id) => id !== hit) : [...current, hit]);
    const ids = current.includes(hit) ? current : [hit];
    selection.set(ids);
    moveSelection(ids, start, e.altKey);
  };

  /** The pick is the deepest layer under the pointer and is the artboard itself or a lone wrapper inside it. */
  const onBackground = (path: string[], hit: string): boolean => {
    const at = path.indexOf(hit);
    if (at !== path.length - 1) return false;
    for (let i = 1; i <= at; i++) if (childIds(doc, path[i - 1]!).length !== 1) return false;
    return true;
  };

  /**
   * Drag-select: the box picks every layer of `scopeId` it touches (artboards and loose layers on the page,
   * an artboard's layers inside one), live as it grows. Shift adds to the selection. Released without a drag
   * it is a click: `clickPick` is selected (or toggled with Shift), or on the empty page the selection clears.
   * Escape puts the selection back.
   */
  const selectBox = (start: Point, scopeId: string, additive: boolean, clickPick: string | null) => {
    const before = selection.get();
    if (!clickPick && !additive) selection.set([]);
    const candidates = marqueeCandidates(doc, o.rootId, scopeId);
    // Measured once up front: nothing reflows while the box is drawn, and panning mid-drag keeps world rects valid.
    const measure = passRectOf();
    const rects = new Map(candidates.map((id) => [id, measure(id)]));
    let moved = false;
    let last: string[] | null = null;
    trackPointer(
      (ev) => {
        const p = toWorld(ev);
        if (!moved && Math.hypot(p.x - start.x, p.y - start.y) * o.viewport.get().zoom < DRAG_THRESHOLD) return;
        moved = true;
        const box = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) };
        o.onMarquee?.(box);
        const hits = marqueeHits(candidates, (id) => rects.get(id) ?? null, box);
        if (last && hits.length === last.length && hits.every((id, i) => id === last![i])) return;
        last = hits;
        selection.set(additive ? [...before, ...hits.filter((id) => !before.includes(id))] : hits);
      },
      () => {
        o.onMarquee?.(null);
        if (moved || !clickPick) return;
        if (additive) selection.set(before.includes(clickPick) ? before.filter((id) => id !== clickPick) : [...before, clickPick]);
        else selection.set([clickPick]);
      },
      () => {
        o.onMarquee?.(null);
        selection.set(before);
      },
    );
  };

  /** Whether a layer is placed by left/top (an artboard, a loose page layer, an absolutely positioned layer) rather than by its parent's layout. */
  const parentInfo = (doc: MarkupDoc, id: string) => {
    const node = doc.requireNode(id);
    const parent = doc.requireNode(node.parentId!);
    return { node, parent, freeform: parent.type === 'root' || !inFlow(node.styles) };
  };

  /**
   * Dragging edits the HTML, not a pixel offset. A layer inside an artboard moves through the tree: its copy
   * is shown live where it will land (siblings reflow around it, see FlowPreview) and the drop reorders it
   * among its siblings or moves it into another frame. Dropped off every artboard it becomes a loose page
   * layer. Artboards and loose layers move freely on the page, and an absolutely positioned layer moves by
   * left/top while the pointer stays over its parent; dragged into another container it joins that flow.
   */
  const moveSelection = (ids: string[], start: Point, duplicate: boolean) => {
    const canvas = o.canvasRef.current!;
    const startRects = ids.map((id) => rectOf(id));
    // Resolved once: the rendered elements stay the same for the whole gesture.
    const els = ids.map((id) => elOf(canvas, id)).filter((el): el is HTMLElement => !!el);
    const onPage = ids.some((id) => doc.getNode(id)?.parentId === o.rootId);
    const absoluteIn = ids.every((id) => !inFlow(doc.getNode(id)?.styles ?? {})) ? doc.getNode(ids[0]!)?.parentId : undefined;
    const sameParent = !!absoluteIn && ids.every((id) => doc.getNode(id)?.parentId === absoluteIn);
    const preview = new FlowPreview(els, duplicate);
    let moved = false;
    let delta = { x: 0, y: 0 };
    /** Where the drop goes; null moves the layers freely by left/top. */
    let target: DropTarget | null = null;
    const resolve = (p: Point): DropTarget | null => {
      if (onPage) return null;
      const rects = passRectOf();
      if (sameParent) {
        const r = rects(absoluteIn!);
        if (r && p.x >= r.x && p.y >= r.y && p.x <= r.x + r.width && p.y <= r.y + r.height) return null;
      }
      return flowDropTarget(doc, o.rootId, p, ids, rects, duplicate);
    };
    const translate = (on: boolean) => {
      for (const el of els) {
        if (on) el.style.translate = `${delta.x}px ${delta.y}px`;
        else el.style.removeProperty('translate');
      }
    };
    const clearPreview = () => {
      preview.clear();
      canvas.classList.remove('is-flow-dragging');
      translate(false);
      // Also any element re-created mid-gesture, which els would not hold.
      for (const id of ids) elOf(canvas, id)?.style.removeProperty('translate');
      o.dragTick.bumpNow();
    };
    trackPointer(
      (ev) => {
        const p = toWorld(ev);
        delta = { x: p.x - start.x, y: p.y - start.y };
        if (!moved && Math.hypot(delta.x, delta.y) * o.viewport.get().zoom < DRAG_THRESHOLD) return;
        moved = true;
        target = resolve(p);
        const container = target?.kind === 'flow' ? elOf(canvas, target.parentId) : null;
        if (target?.kind === 'flow' && container) {
          translate(false);
          preview.place(container, target.beforeId ? elOf(canvas, target.beforeId) : null);
          canvas.classList.add('is-flow-dragging');
        } else {
          preview.clear();
          canvas.classList.remove('is-flow-dragging');
          translate(true);
        }
        o.dragTick.bump();
      },
      () => {
        const drop = target;
        clearPreview();
        if (!moved) return;
        const summary = `${duplicate ? 'Duplicated and moved' : 'Moved'} ${ids.length} node${ids.length === 1 ? '' : 's'}`;
        const finalIds = doc.batch(actor, summary, () => {
          const targets = duplicate ? doc.duplicateNodes(actor, ids.map((id) => ({ id }))).map((r) => r.newId) : ids;
          if (!drop) {
            targets.forEach((id, i) => {
              const { parent } = parentInfo(doc, id);
              const source = doc.requireNode(ids[i]!);
              const move = freeformMove(source, parent, startRects[i] ?? { x: 0, y: 0, width: 0, height: 0 }, parent.type === 'root' ? null : rectOf(parent.id), delta);
              doc.updateStyles(actor, [{ nodeIds: [id], styles: move.node }, ...(move.parent ? [{ nodeIds: [parent.id], styles: move.parent }] : [])]);
            });
          } else if (drop.kind === 'root') {
            doc.moveNodes(actor, targets.map((id) => ({ nodeId: id, parentId: o.rootId })));
            doc.updateStyles(
              actor,
              targets.map((id, i) => ({ nodeIds: [id], styles: pageLayerStyles(doc.requireNode(id).styles, startRects[i] ?? null, delta) })),
            );
          } else {
            doc.moveNodes(actor, targets.map((id) => (drop.beforeId ? { nodeId: id, before: drop.beforeId } : { nodeId: id, parentId: drop.parentId })));
            const lifted = targets.filter((id) => !inFlow(doc.requireNode(id).styles));
            if (lifted.length) doc.updateStyles(actor, [{ nodeIds: lifted, styles: JOIN_FLOW }]);
          }
          return targets;
        });
        selection.set(finalIds);
      },
      // Nothing was written yet: dropping the preview is the whole revert.
      clearPreview,
    );
  };

  /**
   * Resizes the selection from a handle. One layer takes the new box; several scale together inside their
   * union box, each keeping its share of it (a flow child keeps its place and only changes size).
   */
  const onHandleDown = (handle: Handle, e: React.PointerEvent) => {
    const canvas = o.canvasRef.current;
    if (!canvas) return;
    const items = selection
      .get()
      .map((id) => ({ id, rect: rectOf(id), el: elOf(canvas, id), ...parentInfo(doc, id) }))
      .filter((it): it is typeof it & { rect: Rect; el: HTMLElement } => !!it.rect && !!it.el);
    const startBox = unionRects(items.map((it) => it.rect));
    if (!items.length || !startBox) return;
    const start = toWorld(e);
    let next = startBox;
    // Each layer's rect inside the resized box, scaled from where it sat in the starting one.
    const fit = (r: Rect): Rect => {
      const sx = startBox.width ? next.width / startBox.width : 1;
      const sy = startBox.height ? next.height / startBox.height : 1;
      return { x: next.x + (r.x - startBox.x) * sx, y: next.y + (r.y - startBox.y) * sy, width: Math.max(1, r.width * sx), height: Math.max(1, r.height * sy) };
    };
    // The inline values the preview overwrites, put back if the resize is aborted (a commit re-renders them).
    const before = items.map(({ el }) => ({ width: el.style.width, height: el.style.height, left: el.style.left, top: el.style.top }));
    // Panels and overlays hear about the live size once per frame, however fast pointer events arrive.
    let frame = 0;
    const publish = () => {
      frame = 0;
      for (const it of items) {
        const r = fit(it.rect);
        announceLive([it.id], { width: `${Math.round(r.width)}px`, height: `${Math.round(r.height)}px` });
      }
      o.dragTick.bumpNow();
    };
    const stopPreview = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      endPreview();
    };
    trackPointer(
      (ev) => {
        const p = toWorld(ev);
        next = resizeRect(startBox, handle, p.x - start.x, p.y - start.y);
        for (const it of items) {
          const r = fit(it.rect);
          it.el.style.width = `${r.width}px`;
          it.el.style.height = `${r.height}px`;
          if (it.freeform) {
            it.el.style.left = `${parsePxValue(it.node.styles.left) + r.x - it.rect.x}px`;
            it.el.style.top = `${parsePxValue(it.node.styles.top) + r.y - it.rect.y}px`;
          }
        }
        if (frame) return;
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(publish);
        else publish();
      },
      () => {
        stopPreview();
        if (next === startBox) return;
        const updates = items.map((it) => {
          const r = fit(it.rect);
          const styles: Styles = { width: `${Math.round(r.width)}px`, height: `${Math.round(r.height)}px` };
          if (it.freeform) {
            styles.left = Math.round(parsePxValue(it.node.styles.left) + r.x - it.rect.x);
            styles.top = Math.round(parsePxValue(it.node.styles.top) + r.y - it.rect.y);
          }
          return { nodeIds: [it.id], styles };
        });
        doc.updateStyles(actor, updates, items.length === 1 ? `Resized "${items[0]!.node.name}"` : `Resized ${items.length} nodes`);
      },
      () => {
        stopPreview();
        items.forEach((it, i) => Object.assign(it.el.style, before[i]));
        o.dragTick.bumpNow();
      },
    );
  };

  /** Container a new node drops into: the deepest frame under the point, or the page root. */
  const containerAt = (p: Point): string => {
    let id = hitTest(doc, o.rootId, p, { deep: true, rectOf: passRectOf() });
    while (id && doc.requireNode(id).type !== 'frame') id = doc.requireNode(id).parentId;
    return id ?? o.rootId;
  };

  const insertAt = (parentId: string, worldRect: Rect, spec: NodeSpec): string => {
    const parent = doc.requireNode(parentId);
    const styles: Styles = { ...spec.styles };
    if (parent.type === 'root') Object.assign(styles, { position: 'absolute', left: Math.round(worldRect.x), top: Math.round(worldRect.y) });
    else if (parent.styles.display !== 'flex') {
      const parentRect = rectOf(parentId)!;
      Object.assign(styles, { position: 'absolute', left: Math.round(worldRect.x - parentRect.x), top: Math.round(worldRect.y - parentRect.y) });
    }
    const needsContainingBlock = parent.type !== 'root' && styles.position === 'absolute' && parent.styles.position === undefined;
    return doc.batch(actor, `Inserted ${spec.name ?? spec.type}`, () => {
      if (needsContainingBlock) doc.updateStyles(actor, [{ nodeIds: [parentId], styles: { position: 'relative' } }]);
      const [id] = doc.insertNodes(actor, parentId, [{ ...spec, styles }]);
      return id!;
    });
  };

  const drawBox = (start: Point, kind: 'frame' | 'rect') => {
    let end = start;
    const parentAtStart = containerAt(start);
    const artboard = parentAtStart === o.rootId;
    const draftName = artboard ? `Artboard ${doc.requireNode(o.rootId).children.length + 1}` : kind === 'rect' ? 'Rectangle' : 'Frame';
    trackPointer(
      (ev) => {
        end = toWorld(ev);
        // Shift draws a square.
        if (ev.shiftKey) {
          const side = Math.max(Math.abs(end.x - start.x), Math.abs(end.y - start.y));
          end = { x: start.x + Math.sign(end.x - start.x || 1) * side, y: start.y + Math.sign(end.y - start.y || 1) * side };
        }
        const live = Math.hypot(end.x - start.x, end.y - start.y) * o.viewport.get().zoom >= DRAG_THRESHOLD;
        o.onDraw?.(
          live
            ? { kind, artboard, name: draftName, rect: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) } }
            : null,
        );
      },
      () => {
        o.onDraw?.(null);
        const dragged = Math.hypot(end.x - start.x, end.y - start.y) * o.viewport.get().zoom >= DRAG_THRESHOLD;
        const parentId = containerAt(start);
        const isArtboard = parentId === o.rootId;
        const size = dragged ? { width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) } : isArtboard ? { width: 1440, height: 900 } : { width: 100, height: 100 };
        const rect = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), ...size };
        const styles: Styles = { width: `${Math.round(rect.width)}px`, height: `${Math.round(rect.height)}px` };
        if (isArtboard) Object.assign(styles, { display: 'flex', flexDirection: 'column', backgroundColor: '#ffffff' });
        else if (kind === 'rect') styles.backgroundColor = '#d4d4d8';
        const name = isArtboard ? `Artboard ${doc.requireNode(o.rootId).children.length + 1}` : kind === 'rect' ? 'Rectangle' : 'Frame';
        const id = insertAt(parentId, rect, { type: 'frame', name, styles });
        selection.set([id]);
        o.setTool('move');
      },
      // Aborted: drop the draft box, insert nothing and keep the tool armed.
      () => o.onDraw?.(null),
    );
  };

  const placeComment = (p: Point) => {
    const hit = hitTest(doc, o.rootId, p, { deep: true, rectOf: passRectOf() });
    const r = hit ? rectOf(hit) : null;
    o.placeComment(hit && r ? { nodeId: hit, x: p.x - r.x, y: p.y - r.y } : { nodeId: null, x: p.x, y: p.y });
  };

  const placeText = (p: Point) => {
    const id = insertAt(containerAt(p), { x: p.x, y: p.y, width: 0, height: 0 }, { type: 'text', name: 'Text', text: 'Text', styles: { fontSize: '16px', color: '#18181b' } });
    selection.set([id]);
    o.setTool('move');
    requestAnimationFrame(() => o.startTextEdit(id));
  };

  /** Pressing an artboard's title selects that artboard and drags it, wherever its content sits. */
  const onLabelDown = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0 || o.tool !== 'move' || !o.canvasRef.current || doc.getNode(id)?.locked) return;
    e.stopPropagation();
    const current = selection.get();
    if (e.shiftKey) return selection.set(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
    const ids = current.includes(id) ? current : [id];
    selection.set(ids);
    moveSelection(ids, toWorld(e), e.altKey);
  };

  return { onPointerDown, onHandleDown, onLabelDown };
}
