import { describe, expect, it } from 'vitest';
import { ActorUndo, MarkupDoc, type Actor } from '../src/index';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'Hero' }]);
  return { doc, artboard: artboard! };
}

describe('batch and flags', () => {
  it('batch groups ops into one log entry and one undo step', () => {
    const { doc, artboard } = setup();
    const undo = new ActorUndo(doc, human);
    const [a, b] = doc.insertNodes(human, artboard, [{ type: 'frame' }, { type: 'frame' }]);
    const wrapper = doc.batch(human, 'Wrapped 2 nodes in flex', () => {
      const [w] = doc.insertNodes(human, artboard, [{ type: 'frame', name: 'Flex', styles: { display: 'flex' } }], 0);
      doc.moveNodes(human, [{ nodeId: a!, parentId: w! }, { nodeId: b!, parentId: w! }]);
      return w!;
    });
    const log = doc.log();
    expect(log.at(-1)!.summary).toBe('Wrapped 2 nodes in flex');
    expect(log).toHaveLength(3);
    expect(doc.requireNode(wrapper).children).toEqual([a, b]);
    undo.undo();
    expect(doc.getNode(wrapper)).toBeUndefined();
    expect(doc.requireNode(artboard).children).toEqual([a, b]);
  });

  it('batch result can be reverted as one entry', () => {
    const { doc, artboard } = setup();
    doc.batch(human, 'Two edits', () => {
      doc.updateStyles(human, [{ nodeIds: [artboard], styles: { width: '1px' } }]);
      doc.renameNodes(human, [{ nodeId: artboard, name: 'X' }]);
    });
    doc.revertEntry(human, 2);
    expect(doc.requireNode(artboard)).toMatchObject({ name: 'Hero', styles: {} });
  });

  it('setFlags hides and locks nodes', () => {
    const { doc, artboard } = setup();
    doc.setFlags(human, [artboard], { hidden: true, locked: true });
    expect(doc.requireNode(artboard)).toMatchObject({ hidden: true, locked: true });
    expect(doc.log().at(-1)!.summary).toBe('Changed visibility or lock on 1 node');
    doc.setFlags(human, [artboard], { hidden: false });
    expect(doc.requireNode(artboard)).toMatchObject({ hidden: false, locked: true });
  });
});
