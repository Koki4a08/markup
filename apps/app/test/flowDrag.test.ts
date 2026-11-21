import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { flowDropIndex, flowDropTarget, layoutAxis, pageLayerStyles } from '../src/canvas/interactions';
import type { Rect } from '../src/canvas/geometry';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

/**
 * Artboard 0,0 400x400 (column) > [Header 0,0 400x50 (text), Row 0,50 400x100 (flex row) > [A 0,50 100x100, B 100,50 100x100], Footer 0,150 400x50 (text)]
 */
function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [
    {
      type: 'frame',
      name: 'Artboard',
      styles: { display: 'flex', flexDirection: 'column' },
      children: [
        { type: 'text', name: 'Header', text: 'Header' },
        {
          type: 'frame',
          name: 'Row',
          styles: { display: 'flex', flexDirection: 'row' },
          children: [
            { type: 'frame', name: 'A', styles: { width: '100px', height: '100px' } },
            { type: 'frame', name: 'B', styles: { width: '100px', height: '100px' } },
          ],
        },
        { type: 'text', name: 'Footer', text: 'Footer' },
      ],
    },
  ]);
  const [header, row, footer] = doc.requireNode(artboard!).children as [string, string, string];
  const [a, b] = doc.requireNode(row).children as [string, string];
  const rects: Record<string, Rect> = {
    [artboard!]: { x: 0, y: 0, width: 400, height: 400 },
    [header]: { x: 0, y: 0, width: 400, height: 50 },
    [row]: { x: 0, y: 50, width: 400, height: 100 },
    [a]: { x: 0, y: 50, width: 100, height: 100 },
    [b]: { x: 100, y: 50, width: 100, height: 100 },
    [footer]: { x: 0, y: 150, width: 400, height: 50 },
  };
  const rectOf = (id: string) => rects[id] ?? null;
  return { doc, rootId: page.rootId, artboard: artboard!, header, row, footer, a, b, rectOf };
}

describe('layoutAxis', () => {
  it('reads flex direction, treats grid as rows and block flow as a column', () => {
    expect(layoutAxis({ display: 'flex' })).toBe('row');
    expect(layoutAxis({ display: 'inline-flex', flexDirection: 'column-reverse' })).toBe('column');
    expect(layoutAxis({ display: 'grid' })).toBe('row');
    expect(layoutAxis({})).toBe('column');
  });
});

describe('flowDropIndex', () => {
  it('follows wrapped rows line by line', () => {
    const rects = [
      { x: 0, y: 0, width: 100, height: 50 },
      { x: 100, y: 0, width: 100, height: 50 },
      { x: 0, y: 50, width: 100, height: 50 },
    ];
    expect(flowDropIndex(rects, { x: 120, y: 10 }, 'row')).toBe(1);
    expect(flowDropIndex(rects, { x: 190, y: 10 }, 'row')).toBe(2);
    expect(flowDropIndex(rects, { x: 10, y: 60 }, 'row')).toBe(2);
    expect(flowDropIndex(rects, { x: 90, y: 60 }, 'row')).toBe(3);
  });
});

describe('flowDropTarget', () => {
  it('reorders inside a flex row', () => {
    const { doc, rootId, row, a, b, rectOf } = setup();
    expect(flowDropTarget(doc, rootId, { x: 190, y: 100 }, [a], rectOf)).toEqual({ kind: 'flow', parentId: row, beforeId: null, axis: 'row' });
    expect(flowDropTarget(doc, rootId, { x: 120, y: 100 }, [b], rectOf)).toEqual({ kind: 'flow', parentId: row, beforeId: null, axis: 'row' });
    expect(flowDropTarget(doc, rootId, { x: 20, y: 100 }, [b], rectOf)).toEqual({ kind: 'flow', parentId: row, beforeId: a, axis: 'row' });
  });

  it('moves a layer out of its frame into the artboard flow', () => {
    const { doc, rootId, artboard, footer, a, rectOf } = setup();
    expect(flowDropTarget(doc, rootId, { x: 200, y: 160 }, [a], rectOf)).toEqual({ kind: 'flow', parentId: artboard, beforeId: footer, axis: 'column' });
  });

  it('drops next to a frame near its edge and into it in its middle', () => {
    const { doc, rootId, artboard, row, header, rectOf } = setup();
    // Row's top edge band on the artboard's column axis.
    expect(flowDropTarget(doc, rootId, { x: 300, y: 55 }, [header], rectOf)).toMatchObject({ parentId: artboard });
    expect(flowDropTarget(doc, rootId, { x: 300, y: 100 }, [header], rectOf)).toMatchObject({ parentId: row, beforeId: null });
  });

  it('never drops a layer into itself', () => {
    const { doc, rootId, artboard, row, rectOf } = setup();
    expect(flowDropTarget(doc, rootId, { x: 50, y: 100 }, [row], rectOf)).toMatchObject({ parentId: artboard });
  });

  it('off every artboard the layer goes onto the page', () => {
    const { doc, rootId, a, rectOf } = setup();
    expect(flowDropTarget(doc, rootId, { x: 900, y: 900 }, [a], rectOf)).toEqual({ kind: 'root' });
  });

  it('skips absolutely placed siblings when picking the slot', () => {
    const { doc, rootId, row, a, b, rectOf } = setup();
    doc.updateStyles(human, [{ nodeIds: [a], styles: { position: 'absolute', left: 0, top: 0 } }]);
    expect(flowDropTarget(doc, rootId, { x: 120, y: 100 }, [], rectOf)).toEqual({ kind: 'flow', parentId: row, beforeId: b, axis: 'row' });
  });
});

describe('pageLayerStyles', () => {
  it('places the layer where it was dropped and pins a layout-given width', () => {
    expect(pageLayerStyles({ width: '100%' }, { x: 10, y: 20, width: 300, height: 40 }, { x: 5, y: 5 })).toMatchObject({ position: 'absolute', left: 15, top: 25, width: '300px' });
    expect(pageLayerStyles({ width: '120px' }, { x: 0, y: 0, width: 120, height: 40 }, { x: 0, y: 0 })).not.toHaveProperty('width');
  });
});

describe('FlowPreview', () => {
  it('shows an unregistered copy at the drop point, hides the original and puts everything back', async () => {
    const { FlowPreview } = await import('../src/canvas/flowPreview');
    document.body.innerHTML = '<div id="a"><div data-node-id="x" style="position:absolute;left:5px"><span data-node-id="y"></span></div></div><div id="b"><i id="i"></i></div>';
    const original = document.querySelector<HTMLElement>('[data-node-id="x"]')!;
    const b = document.getElementById('b')!;
    const preview = new FlowPreview([original], false);
    preview.place(b, document.getElementById('i'));
    const ghost = b.firstElementChild as HTMLElement;
    expect(ghost.hasAttribute('data-drag-ghost')).toBe(true);
    expect(ghost.querySelector('[data-node-id]')).toBeNull();
    expect(ghost.style.position).toBe('');
    expect(original.style.display).toBe('none');
    expect(b.hasAttribute('data-drop-target')).toBe(true);
    preview.clear();
    expect(b.innerHTML).toBe('<i id="i"></i>');
    expect(b.hasAttribute('data-drop-target')).toBe(false);
    expect(original.style.display).toBe('');
  });
});
