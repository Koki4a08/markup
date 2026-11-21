import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '../src/index';

const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(agent, page.rootId, [{ type: 'frame', name: 'Hero' }]);
  const [text] = doc.insertNodes(agent, artboard!, [{ type: 'text', text: 'old' }]);
  return { doc, artboard: artboard!, text: text!, logLength: doc.log().length };
}

describe('failed operations change nothing', () => {
  it('updateStyles with a missing id applies nothing and logs nothing', () => {
    const { doc, artboard, logLength } = setup();
    expect(() => doc.updateStyles(agent, [{ nodeIds: [artboard, 'missing'], styles: { width: '5px' } }])).toThrow(expect.objectContaining({ code: 'NODE_NOT_FOUND' }));
    expect(doc.requireNode(artboard).styles.width).toBeUndefined();
    expect(doc.log()).toHaveLength(logLength);
  });

  it('setText with a non-text node leaves the text node unchanged', () => {
    const { doc, artboard, text } = setup();
    expect(() => doc.setText(agent, [{ nodeId: text, html: 'new' }, { nodeId: artboard, html: 'x' }])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(doc.requireNode(text).text).toBe('old');
  });

  it('renameNodes with a missing id renames nothing', () => {
    const { doc, artboard } = setup();
    expect(() => doc.renameNodes(agent, [{ nodeId: artboard, name: 'New' }, { nodeId: 'missing', name: 'x' }])).toThrow();
    expect(doc.requireNode(artboard).name).toBe('Hero');
  });

  it('writeHtml with an unknown clone inserts nothing', () => {
    const { doc, artboard } = setup();
    const before = doc.nodeCount();
    expect(() => doc.writeHtml(agent, artboard, '<div></div><x-markup-clone node-id="nope"></x-markup-clone>', 'insert-children')).toThrow();
    expect(doc.nodeCount()).toBe(before);
  });

  it('moveNodes with a bad later move applies nothing', () => {
    const { doc, artboard, text } = setup();
    const [box] = doc.insertNodes(agent, artboard, [{ type: 'frame' }]);
    expect(() => doc.moveNodes(agent, [{ nodeId: text, parentId: box! }, { nodeId: 'missing', parentId: box! }])).toThrow();
    expect(doc.requireNode(text).parentId).toBe(artboard);
  });

  it('a failure the checks miss is still logged as partial', () => {
    const { doc, artboard, logLength } = setup();
    expect(() =>
      doc.batch(agent, 'Two steps', () => {
        doc.renameNodes(agent, [{ nodeId: artboard, name: 'Step 1' }]);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(doc.log()).toHaveLength(logLength + 1);
    expect(doc.log().at(-1)!.summary).toBe('Two steps (failed partway)');
  });
});
