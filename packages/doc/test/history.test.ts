import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ActorUndo, MarkupDoc, type Actor } from '../src/index';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };
const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'Hero' }]);
  return { doc, artboard: artboard! };
}

describe('history', () => {
  it('each op appends one entry with actor and summary', () => {
    const { doc, artboard } = setup();
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { width: '10px' } }]);
    doc.renameNodes(agent, [{ nodeId: artboard, name: 'Hero 2' }], 'Renamed hero');
    const log = doc.log();
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log[0]).toMatchObject({ actor: human, summary: 'Inserted 1 node', reverted: false });
    expect(log[1]).toMatchObject({ actor: agent, summary: 'Updated styles on 1 node' });
    expect(log[2]!.summary).toBe('Renamed hero');
    expect(typeof log[0]!.at).toBe('number');
  });

  it('setWorking does not log', () => {
    const { doc, artboard } = setup();
    doc.setWorking(agent, [artboard], true);
    expect(doc.log()).toHaveLength(1);
  });

  it('undo reverts only own actor', () => {
    const { doc, artboard } = setup();
    const undo = new ActorUndo(doc, human);
    doc.updateStyles(human, [{ nodeIds: [artboard], styles: { width: '100px' } }]);
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { backgroundColor: 'red' } }]);
    expect(undo.undo()).toBe(true);
    const styles = doc.requireNode(artboard).styles;
    expect(styles.width).toBeUndefined();
    expect(styles.backgroundColor).toBe('red');
    undo.destroy();
  });

  it('redo restores', () => {
    const { doc, artboard } = setup();
    const undo = new ActorUndo(doc, human);
    doc.updateStyles(human, [{ nodeIds: [artboard], styles: { width: '100px' } }]);
    undo.undo();
    expect(undo.canRedo()).toBe(true);
    undo.redo();
    expect(doc.requireNode(artboard).styles.width).toBe('100px');
  });

  it('one op is one undo step', () => {
    const { doc, artboard } = setup();
    const undo = new ActorUndo(doc, human);
    doc.updateStyles(human, [{ nodeIds: [artboard], styles: { width: '1px' } }]);
    doc.updateStyles(human, [{ nodeIds: [artboard], styles: { width: '2px' } }]);
    undo.undo();
    expect(doc.requireNode(artboard).styles.width).toBe('1px');
  });

  it('revertEntry keeps entry and marks reverted', () => {
    const { doc, artboard } = setup();
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { backgroundColor: 'red' } }]);
    doc.updateStyles(human, [{ nodeIds: [artboard], styles: { width: '100px' } }]);
    doc.revertEntry(human, 2);
    const styles = doc.requireNode(artboard).styles;
    expect(styles.backgroundColor).toBeUndefined();
    expect(styles.width).toBe('100px');
    const log = doc.log();
    expect(log).toHaveLength(3);
    expect(log[1]).toMatchObject({ seq: 2, reverted: true, revertedBy: human.id });
  });

  it('revert of an inserted subtree removes it', () => {
    const { doc, artboard } = setup();
    const [card] = doc.insertNodes(agent, artboard, [{ type: 'frame', children: [{ type: 'text', text: 'x' }] }]);
    doc.revertEntry(human, 2);
    expect(doc.getNode(card!)).toBeUndefined();
  });

  it('revert twice throws', () => {
    const { doc, artboard } = setup();
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { width: '1px' } }]);
    doc.revertEntry(human, 2);
    expect(() => doc.revertEntry(human, 2)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('log survives sync to a second doc', () => {
    const { doc, artboard } = setup();
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { width: '1px' } }]);
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(doc.ydoc));
    expect(new MarkupDoc({ ydoc }).log()).toEqual(doc.log());
  });

  it('reverting an overwritten entry never undoes a different entry', () => {
    const { doc, artboard } = setup();
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { backgroundColor: 'red' } }]);
    doc.updateStyles(human, [{ nodeIds: [artboard], styles: { backgroundColor: 'blue' } }]);
    doc.updateStyles(human, [{ nodeIds: [artboard], styles: { width: '100px' } }]);
    doc.revertEntry(human, 2);
    expect(doc.requireNode(artboard).styles).toMatchObject({ backgroundColor: 'blue', width: '100px' });
    expect(doc.log().find((e) => e.seq === 4)!.reverted).toBe(false);
    expect(doc.log().find((e) => e.seq === 2)!.reverted).toBe(true);
  });

  it('reverting an insert whose node was deleted keeps later edits', () => {
    const { doc, artboard } = setup();
    const [card] = doc.insertNodes(agent, artboard, [{ type: 'frame', name: 'Card' }]);
    doc.deleteNodes(human, [card!]);
    doc.renameNodes(human, [{ nodeId: artboard, name: 'Renamed' }]);
    doc.revertEntry(human, 2);
    expect(doc.requireNode(artboard).name).toBe('Renamed');
  });

  it('an entry that changed nothing reverts without error', () => {
    const { doc, artboard } = setup();
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { margin: '4px' } }]);
    expect(() => doc.revertEntry(human, 2)).not.toThrow();
    expect(doc.log()[1]!.reverted).toBe(true);
  });
});
