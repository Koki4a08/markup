import { beforeEach, describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '../src/index';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [
    { type: 'frame', name: 'Hero', styles: { left: 0, top: 0, width: '1440px', height: '900px' } },
  ]);
  return { doc, rootId: page.rootId, artboard: artboard! };
}

describe('node ops', () => {
  let doc: MarkupDoc;
  let rootId: string;
  let artboard: string;
  beforeEach(() => ({ doc, rootId, artboard } = setup()));

  it('insertNodes builds nested tree', () => {
    const [card] = doc.insertNodes(human, artboard, [
      { type: 'frame', name: 'Card', children: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] },
    ]);
    const node = doc.requireNode(card!);
    expect(node.children).toHaveLength(2);
    for (const childId of node.children) expect(doc.requireNode(childId).parentId).toBe(card);
    expect(doc.requireNode(card!).parentId).toBe(artboard);
  });

  it('index clamps to [0, childCount]', () => {
    const [a] = doc.insertNodes(human, artboard, [{ type: 'frame', name: 'A' }]);
    const [b] = doc.insertNodes(human, artboard, [{ type: 'frame', name: 'B' }], 99);
    const [c] = doc.insertNodes(human, artboard, [{ type: 'frame', name: 'C' }], 0);
    expect(doc.requireNode(artboard).children).toEqual([c, a, b]);
  });

  it('moveNodes before/after/parentId keeps ids and reports affected parents', () => {
    const [a, b, c] = doc.insertNodes(human, artboard, [
      { type: 'frame', name: 'A' },
      { type: 'frame', name: 'B' },
      { type: 'frame', name: 'C', children: [] },
    ]);
    const res = doc.moveNodes(human, [{ nodeId: a!, after: b! }]);
    expect(doc.requireNode(artboard).children).toEqual([b, a, c]);
    expect(res.results[0]).toEqual({ nodeId: a, parentId: artboard, index: 1 });
    const res2 = doc.moveNodes(human, [{ nodeId: b!, parentId: c! }]);
    expect(doc.requireNode(b!).parentId).toBe(c);
    expect(res2.affectedParents[artboard]).toEqual([a, c]);
    expect(res2.affectedParents[c!]).toEqual([b]);
    doc.moveNodes(human, [{ nodeId: b!, before: a! }]);
    expect(doc.requireNode(artboard).children).toEqual([b, a, c]);
  });

  it('moveNodes rejects cycle', () => {
    const [outer] = doc.insertNodes(human, artboard, [{ type: 'frame', name: 'Outer', children: [{ type: 'frame', name: 'Inner' }] }]);
    const inner = doc.requireNode(outer!).children[0]!;
    expect(() => doc.moveNodes(human, [{ nodeId: outer!, parentId: inner }])).toThrow(expect.objectContaining({ code: 'CYCLE' }));
  });

  it("parentId 'root' resolves to the node's page root", () => {
    const [a] = doc.insertNodes(human, artboard, [{ type: 'frame', name: 'A' }]);
    doc.moveNodes(human, [{ nodeId: a!, parentId: 'root' }]);
    expect(doc.requireNode(a!).parentId).toBe(rootId);
  });

  it('moveNodes into a text node throws INVALID_PARENT', () => {
    const [t, f] = doc.insertNodes(human, artboard, [{ type: 'text', text: 'x' }, { type: 'frame' }]);
    expect(() => doc.moveNodes(human, [{ nodeId: f!, parentId: t! }])).toThrow(expect.objectContaining({ code: 'INVALID_PARENT' }));
  });

  it('moveNodes is sequential', () => {
    const [a, b, c] = doc.insertNodes(human, artboard, [{ type: 'frame' }, { type: 'frame' }, { type: 'frame' }]);
    doc.moveNodes(human, [
      { nodeId: a!, parentId: b! },
      { nodeId: b!, parentId: c! },
    ]);
    expect(doc.requireNode(c!).children).toEqual([b]);
    expect(doc.requireNode(b!).children).toEqual([a]);
  });

  it('cannot move or delete root', () => {
    expect(() => doc.deleteNodes(human, [rootId])).toThrow(expect.objectContaining({ code: 'IS_ROOT' }));
    expect(() => doc.moveNodes(human, [{ nodeId: rootId, parentId: artboard }])).toThrow(expect.objectContaining({ code: 'IS_ROOT' }));
  });

  it('deleteNodes removes descendants', () => {
    const [card] = doc.insertNodes(human, artboard, [{ type: 'frame', children: [{ type: 'text', text: 'a' }, { type: 'frame', children: [{ type: 'text', text: 'b' }] }] }]);
    const before = doc.nodeCount();
    doc.deleteNodes(human, [card!]);
    expect(doc.nodeCount()).toBe(before - 4);
    expect(doc.requireNode(artboard).children).toEqual([]);
  });

  it('duplicateNodes maps every descendant', () => {
    const [card] = doc.insertNodes(human, artboard, [{ type: 'frame', children: [{ type: 'text', text: 'a' }, { type: 'frame', children: [{ type: 'text', text: 'b' }] }] }]);
    const [res] = doc.duplicateNodes(human, [{ id: card! }]);
    expect(res!.sourceId).toBe(card);
    expect(Object.keys(res!.descendantIdMap)).toHaveLength(3);
    const all = [res!.newId, ...Object.values(res!.descendantIdMap)];
    expect(new Set(all).size).toBe(4);
    expect(all).not.toContain(card);
    expect(doc.requireNode(artboard).children).toEqual([card, res!.newId]);
    expect(doc.requireNode(res!.newId).children).toHaveLength(2);
  });

  it('duplicated artboard is placed clear of the source', () => {
    const [res] = doc.duplicateNodes(human, [{ id: artboard }]);
    const left = Number(doc.requireNode(res!.newId).styles.left);
    expect(left).toBeGreaterThanOrEqual(0 + 1440 + 80);
  });

  it('renameNodes truncates to 50', () => {
    doc.renameNodes(human, [{ nodeId: artboard, name: 'x'.repeat(80) }]);
    expect(doc.requireNode(artboard).name).toHaveLength(50);
  });

  it('updateStyles null removes property', () => {
    doc.updateStyles(human, [{ nodeIds: [artboard], styles: { backgroundColor: '#fff', height: null } }]);
    const styles = doc.requireNode(artboard).styles;
    expect(styles.backgroundColor).toBe('#fff');
    expect(styles.height).toBeUndefined();
  });

  it('setText on frame throws INVALID_ARGUMENT', () => {
    expect(() => doc.setText(human, [{ nodeId: artboard, html: 'hi' }])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('setText replaces text html', () => {
    const [t] = doc.insertNodes(human, artboard, [{ type: 'text', text: 'old' }]);
    doc.setText(human, [{ nodeId: t!, html: 'new <b>bold</b>' }]);
    expect(doc.requireNode(t!).text).toBe('new <b>bold</b>');
  });

  it('artboardOf returns the top-level frame', () => {
    const [card] = doc.insertNodes(human, artboard, [{ type: 'frame', children: [{ type: 'text', text: 'a' }] }]);
    const text = doc.requireNode(card!).children[0]!;
    expect(doc.artboardOf(text)).toBe(artboard);
    expect(doc.artboardOf(rootId)).toBeNull();
  });

  it('setWorking marks and clears artboards', () => {
    const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };
    doc.setWorking(agent, [artboard], true);
    expect(doc.working()).toEqual({ [artboard]: agent });
    doc.setWorking(agent, 'all', false);
    expect(doc.working()).toEqual({});
  });

  it('every op records actor as transaction origin', () => {
    const origins: unknown[] = [];
    doc.ydoc.on('afterTransaction', (t) => origins.push(t.origin));
    const [a] = doc.insertNodes(human, artboard, [{ type: 'frame' }]);
    doc.updateStyles(human, [{ nodeIds: [a!], styles: { width: '10px' } }]);
    doc.renameNodes(human, [{ nodeId: a!, name: 'A' }]);
    doc.duplicateNodes(human, [{ id: a! }]);
    doc.moveNodes(human, [{ nodeId: a!, parentId: 'root' }]);
    doc.deleteNodes(human, [a!]);
    expect(origins.length).toBeGreaterThanOrEqual(6);
    for (const o of origins) expect(o).toBe(human);
  });

  it('clearWorking drops indicators left by agents that never finished, without logging', () => {
    const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };
    doc.setWorking(agent, [artboard], true);
    const logLength = doc.log().length;
    doc.clearWorking();
    expect(doc.working()).toEqual({});
    expect(doc.log()).toHaveLength(logLength);
  });
});
