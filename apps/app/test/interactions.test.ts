import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { hitTest } from '../src/canvas/interactions';
import type { Rect } from '../src/canvas/geometry';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

/** Artboard 0,0 400x300 > Card 20,20 200x100 > Title 30,30 100x20. */
function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'A', children: [{ type: 'frame', name: 'Card', children: [{ type: 'text', text: 'Title' }] }] }]);
  const card = doc.requireNode(artboard!).children[0]!;
  const title = doc.requireNode(card).children[0]!;
  const rects: Record<string, Rect> = {
    [artboard!]: { x: 0, y: 0, width: 400, height: 300 },
    [card]: { x: 20, y: 20, width: 200, height: 100 },
    [title]: { x: 30, y: 30, width: 100, height: 20 },
  };
  const rectOf = (id: string) => rects[id] ?? null;
  return { doc, rootId: page.rootId, artboard: artboard!, card, title, rectOf };
}

describe('hitTest', () => {
  it('hitTest shallow returns artboard child', () => {
    const { doc, rootId, card, rectOf } = setup();
    expect(hitTest(doc, rootId, { x: 35, y: 35 }, { deep: false, rectOf })).toBe(card);
  });

  it('hitTest deep returns leaf', () => {
    const { doc, rootId, title, rectOf } = setup();
    expect(hitTest(doc, rootId, { x: 35, y: 35 }, { deep: true, rectOf })).toBe(title);
  });

  it('empty artboard area returns the artboard, outside returns null', () => {
    const { doc, rootId, artboard, rectOf } = setup();
    expect(hitTest(doc, rootId, { x: 300, y: 250 }, { deep: false, rectOf })).toBe(artboard);
    expect(hitTest(doc, rootId, { x: 900, y: 900 }, { deep: false, rectOf })).toBeNull();
  });

  it('hitTest skips locked and hidden', () => {
    const { doc, rootId, artboard, card, rectOf } = setup();
    doc.setFlags(human, [card], { locked: true });
    expect(hitTest(doc, rootId, { x: 35, y: 35 }, { deep: true, rectOf })).toBe(artboard);
    doc.setFlags(human, [card], { locked: false, hidden: true });
    expect(hitTest(doc, rootId, { x: 35, y: 35 }, { deep: true, rectOf })).toBe(artboard);
  });
});
