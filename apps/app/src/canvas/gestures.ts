import { useCallback, type RefObject } from 'react';
import type { MarkupDoc, NodeSpec, Styles } from '@markup/doc';
import { measureNode, parsePxValue, type Rect } from './geometry';
import { flexDropIndex, hitTest, resizeRect, type Handle } from './interactions';
import type { Tool } from './tools';
import { screenToWorld, type Point, type Viewport } from './viewport';
import { useDoc } from '../store/DocProvider';
import { useSelection } from '../selection';

const DRAG_THRESHOLD = 3;

interface GestureOptions {
  canvasRef: RefObject<HTMLDivElement | null>;
  viewport: Viewport;
  tool: Tool;
  setTool(tool: Tool): void;
  rootId: string;
  bumpDrag(): void;
  startTextEdit(id: string): void;
}

const elOf = (canvas: HTMLElement, id: string) => canvas.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);

/** Pointer-driven editing: select, move, resize, draw frames and rectangles, place text. Each gesture commits one op. */
export function useCanvasGestures(o: GestureOptions) {
  const { doc, actor } = useDoc();
  const selection = useSelection();

  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const rect = o.canvasRef.current!.getBoundingClientRect();
      return screenToWorld(o.viewport, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    },
    [o.canvasRef, o.viewport],
  );

  const rectOf = useCallback((id: string) => measureNode(o.canvasRef.current!, id, o.viewport), [o.canvasRef, o.viewport]);

  const track = (onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void) => {
    const up = (e: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      onUp(e);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !o.canvasRef.current) return;
    const start = toWorld(e);
    if (o.tool === 'frame' || o.tool === 'rect') return drawBox(start, o.tool);
    if (o.tool === 'text') return placeText(start);
    const hit = hitTest(doc, o.rootId, start, { deep: e.metaKey || e.ctrlKey, rectOf });
    if (!hit) return selection.set([]);
    if (e.detail === 2 && doc.getNode(hit)?.type === 'text') return o.startTextEdit(hit);
    const current = selection.get();
    if (e.shiftKey) return selection.set(current.includes(hit) ? current.filter((id) => id !== hit) : [...current, hit]);
    const ids = current.includes(hit) ? current : [hit];
    selection.set(ids);
    moveSelection(ids, start, e.altKey);
  };

  const parentInfo = (doc: MarkupDoc, id: string) => {
    const node = doc.requireNode(id);
    const parent = doc.requireNode(node.parentId!);
    const freeform = parent.type === 'root' || node.styles.position === 'absolute' || parent.styles.display !== 'flex';
    return { node, parent, freeform, axis: parent.styles.flexDirection === 'row' || parent.styles.flexDirection === 'row-reverse' ? 'row' : ('column' as 'row' | 'column') };
  };

  const moveSelection = (ids: string[], start: Point, duplicate: boolean) => {
    const canvas = o.canvasRef.current!;
    let moved = false;
    let delta = { x: 0, y: 0 };
    track(
      (ev) => {
        const p = toWorld(ev);
        delta = { x: p.x - start.x, y: p.y - start.y };
        if (!moved && Math.hypot(delta.x, delta.y) * o.viewport.zoom < DRAG_THRESHOLD) return;
        moved = true;
        for (const id of ids) {
          const el = elOf(canvas, id);
          if (el) el.style.translate = `${delta.x}px ${delta.y}px`;
        }
        o.bumpDrag();
      },
      (ev) => {
        for (const id of ids) elOf(canvas, id)?.style.removeProperty('translate');
        o.bumpDrag();
        if (!moved) return;
        const pointer = toWorld(ev);
        const summary = `${duplicate ? 'Duplicated and moved' : 'Moved'} ${ids.length} node${ids.length === 1 ? '' : 's'}`;
        const finalIds = doc.batch(actor, summary, () => {
          const targets = duplicate ? doc.duplicateNodes(actor, ids.map((id) => ({ id }))).map((r) => r.newId) : ids;
          targets.forEach((id, i) => {
            const { node, parent, freeform, axis } = parentInfo(doc, id);
            if (freeform) {
              const source = doc.requireNode(ids[i]!);
              doc.updateStyles(actor, [
                { nodeIds: [id], styles: { left: Math.round(parsePxValue(source.styles.left) + delta.x), top: Math.round(parsePxValue(source.styles.top) + delta.y) } },
              ]);
              return;
            }
            const siblings = parent.children.filter((s) => s !== node.id && !ids.includes(s));
            const rects = siblings.map((s) => rectOf(s)).filter((r): r is Rect => !!r);
            const index = flexDropIndex(rects, pointer, axis);
            const before = siblings[index];
            doc.moveNodes(actor, [before ? { nodeId: id, before } : { nodeId: id, parentId: parent.id }]);
          });
          return targets;
        });
        selection.set(finalIds);
      },
    );
  };

  const onHandleDown = (handle: Handle, e: React.PointerEvent) => {
    const [id] = selection.get();
    const canvas = o.canvasRef.current;
    if (!id || !canvas) return;
    const startRect = rectOf(id);
    const el = elOf(canvas, id);
    if (!startRect || !el) return;
    const start = toWorld(e);
    const { node, freeform } = parentInfo(doc, id);
    let next = startRect;
    track(
      (ev) => {
        const p = toWorld(ev);
        next = resizeRect(startRect, handle, p.x - start.x, p.y - start.y);
        el.style.width = `${next.width}px`;
        el.style.height = `${next.height}px`;
        if (freeform) {
          el.style.left = `${parsePxValue(node.styles.left) + next.x - startRect.x}px`;
          el.style.top = `${parsePxValue(node.styles.top) + next.y - startRect.y}px`;
        }
        o.bumpDrag();
      },
      () => {
        if (next === startRect) return;
        const styles: Styles = { width: `${Math.round(next.width)}px`, height: `${Math.round(next.height)}px` };
        if (freeform) {
          styles.left = Math.round(parsePxValue(node.styles.left) + next.x - startRect.x);
          styles.top = Math.round(parsePxValue(node.styles.top) + next.y - startRect.y);
        }
        doc.updateStyles(actor, [{ nodeIds: [id], styles }], `Resized "${node.name}"`);
      },
    );
  };

  /** Container a new node drops into: the deepest frame under the point, or the page root. */
  const containerAt = (p: Point): string => {
    let id = hitTest(doc, o.rootId, p, { deep: true, rectOf });
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
    const [id] = doc.insertNodes(actor, parentId, [{ ...spec, styles }]);
    return id!;
  };

  const drawBox = (start: Point, kind: 'frame' | 'rect') => {
    let end = start;
    track(
      (ev) => {
        end = toWorld(ev);
      },
      () => {
        const dragged = Math.hypot(end.x - start.x, end.y - start.y) * o.viewport.zoom >= DRAG_THRESHOLD;
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
    );
  };

  const placeText = (p: Point) => {
    const id = insertAt(containerAt(p), { x: p.x, y: p.y, width: 0, height: 0 }, { type: 'text', name: 'Text', text: 'Text', styles: { fontSize: '16px', color: '#18181b' } });
    selection.set([id]);
    o.setTool('move');
    requestAnimationFrame(() => o.startTextEdit(id));
  };

  return { onPointerDown, onHandleDown };
}
