import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { freeformMove, hitPath, hitTest, pastWrappers, pickFromPath } from '../src/canvas/interactions';
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

describe('freeformMove', () => {
  const base = { id: 'n', name: 'n', children: [], locked: false, hidden: false };
  const parent = (styles: Record<string, string> = {}) => ({ ...base, id: 'p', type: 'frame' as const, parentId: 'ab', styles });

  it('absolute child moves by delta and makes a static parent its containing block', () => {
    const node = { ...base, type: 'frame' as const, parentId: 'p', styles: { position: 'absolute', left: 10, top: 20 } };
    expect(freeformMove(node, parent(), { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }, { x: 5, y: -5 })).toEqual({
      node: { left: 15, top: 15 },
      parent: { position: 'relative' },
    });
  });

  it('static child of a block frame becomes absolute at its measured spot plus delta', () => {
    const node = { ...base, type: 'frame' as const, parentId: 'p', styles: {} };
    expect(freeformMove(node, parent({ position: 'relative' }), { x: 130, y: 60, width: 50, height: 50 }, { x: 100, y: 40, width: 300, height: 300 }, { x: 10, y: 10 })).toEqual({
      node: { position: 'absolute', left: 40, top: 30 },
    });
  });

  it('artboards move by delta with no parent change', () => {
    const node = { ...base, type: 'frame' as const, parentId: 'root', styles: { position: 'absolute', left: 0, top: 0 } };
    const root = { ...base, id: 'root', type: 'root' as const, parentId: null, styles: {} };
    expect(freeformMove(node, root, { x: 0, y: 0, width: 1, height: 1 }, null, { x: 100, y: 0 })).toEqual({ node: { left: 100, top: 0 } });
  });
});

describe('pickFromPath', () => {
  it('walks the path outermost first and picks like a click would', () => {
    const { doc, rootId, artboard, card, title, rectOf } = setup();
    const path = hitPath(doc, rootId, { x: 35, y: 35 }, rectOf);
    expect(path).toEqual([artboard, card, title]);
    // Nothing selected: an artboard's direct child, as before.
    expect(pickFromPath(doc, path, [], false)).toBe(card);
    // Ctrl/⌘: the innermost layer.
    expect(pickFromPath(doc, path, [], true)).toBe(title);
  });

  it('stays at the selected level: the selected node keeps the pick, and so do its siblings', () => {
    const { doc, rootId, card, title, rectOf } = setup();
    const [sibling] = doc.insertNodes(human, card, [{ type: 'text', text: 'Body' }]);
    const rects: Record<string, Rect> = { [sibling!]: { x: 30, y: 60, width: 100, height: 20 } };
    const rectOf2 = (id: string) => rects[id] ?? rectOf(id);
    const onTitle = hitPath(doc, rootId, { x: 35, y: 35 }, rectOf2);
    const onSibling = hitPath(doc, rootId, { x: 35, y: 65 }, rectOf2);
    expect(pickFromPath(doc, onTitle, [title], false)).toBe(title);
    expect(pickFromPath(doc, onSibling, [title], false)).toBe(sibling);
    // Outside the selected node's parent the pick falls back to the artboard's child.
    expect(pickFromPath(doc, hitPath(doc, rootId, { x: 300, y: 250 }, rectOf2), [title], false)).toBeTruthy();
  });

  it('skips hidden and locked layers', () => {
    const { doc, rootId, artboard, card, rectOf } = setup();
    doc.setFlags(human, [card], { locked: true });
    expect(hitPath(doc, rootId, { x: 35, y: 35 }, rectOf)).toEqual([artboard]);
  });

  it('a click passes lone wrapper frames and lands on the first layer with neighbours; double-click goes on to the text', () => {
    // Artboard > Section > Inner > Row > [Button > [Label], Other]: a page snapshot's nesting.
    const doc = new MarkupDoc();
    const page = doc.pages()[0]!;
    if (page.type !== 'page') throw new Error('unreachable');
    const button = { type: 'frame' as const, name: 'Button', children: [{ type: 'text' as const, text: 'Go' }] };
    const row = { type: 'frame' as const, name: 'Row', children: [button, { type: 'frame' as const, name: 'Other' }] };
    const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'A', children: [{ type: 'frame', name: 'Section', children: [{ type: 'frame', name: 'Inner', children: [row] }] }] }]);
    const byName = (name: string) => [...doc.nodes.keys()].find((id) => doc.requireNode(id).name === name)!;
    const label = doc.requireNode(byName('Button')).children[0]!;
    const path = [artboard!, byName('Section'), byName('Inner'), byName('Row'), byName('Button'), label];
    // Section, Inner and Row are each the only child of their parent: the click lands on the button.
    expect(pickFromPath(doc, path, [], false)).toBe(byName('Button'));
    expect(pickFromPath(doc, path, [byName('Other')], false)).toBe(byName('Button'));
    // A double-click on the selected button steps to its text, which a click then keeps.
    expect(path[pastWrappers(doc, path, path.indexOf(byName('Button')) + 1)]).toBe(label);
    // It never steps onto a leaf: a lone wrapper above the text stays the pick.
    expect(pastWrappers(doc, path, 4)).toBe(4);
    expect(pickFromPath(doc, path, [label], false)).toBe(label);
  });
});
