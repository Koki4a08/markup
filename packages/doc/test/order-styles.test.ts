import { describe, expect, it } from 'vitest';
import { MarkupDoc, orderStyles, type Actor } from '../src';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

function frame(styles: Record<string, string>) {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [id] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'A', styles }]);
  return { doc, id: id! };
}

describe('orderStyles', () => {
  it('puts shorthands before their longhands, outermost first', () => {
    expect(Object.keys(orderStyles({ backgroundColor: 'red', borderTop: '1px solid', color: 'blue', border: '2px solid', background: 'white' }))).toEqual([
      'border',
      'background',
      'borderTop',
      'backgroundColor',
      'color',
    ]);
  });

  it('a longhand written after its shorthand is read after it, and shows', () => {
    const { doc, id } = frame({ background: 'white' });
    doc.updateStyles(human, [{ nodeIds: [id], styles: { backgroundColor: 'red' } }], undefined, { dialect: 'any' });
    expect(Object.keys(doc.requireNode(id).styles)).toEqual(['background', 'backgroundColor']);
  });

  it('a shorthand written after its longhands replaces them', () => {
    const { doc, id } = frame({ backgroundColor: 'red', rowGap: '4px', borderTopColor: 'blue' });
    doc.updateStyles(human, [{ nodeIds: [id], styles: { background: 'white', gap: '8px', border: '1px solid black' } }], undefined, { dialect: 'any' });
    expect(doc.requireNode(id).styles).toEqual({ background: 'white', gap: '8px', border: '1px solid black' });
  });
});
