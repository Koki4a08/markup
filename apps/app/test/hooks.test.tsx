import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { MarkupDoc, type Actor, type MarkupNode } from '@markup/doc';
import { DocProvider } from '../src/store/DocProvider';
import { structurallyEqual } from '../src/store/equal';
import { useDeep, useNode, useNodes } from '../src/store/hooks';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [a, b] = doc.insertNodes(human, page.rootId, [
    { type: 'frame', name: 'a', styles: { width: '10px' } },
    { type: 'frame', name: 'b', styles: { width: '20px' } },
  ]);
  return { doc, rootId: page.rootId, a: a!, b: b! };
}

describe('structurallyEqual', () => {
  it('compares like JSON without serializing', () => {
    expect(structurallyEqual({ a: 1, b: ['x', { c: 'y' }] }, { b: ['x', { c: 'y' }], a: 1 })).toBe(true);
    expect(structurallyEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(structurallyEqual({ a: 1, u: undefined }, { a: 1 })).toBe(true);
    expect(structurallyEqual({ a: 1 }, { a: 1, n: null })).toBe(false);
    expect(structurallyEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(structurallyEqual([], {})).toBe(false);
    expect(structurallyEqual(undefined, undefined)).toBe(true);
    expect(structurallyEqual(undefined, null)).toBe(false);
    expect(structurallyEqual(NaN, NaN)).toBe(true);
    expect(structurallyEqual(new Date(1), new Date(1))).toBe(true);
    expect(structurallyEqual(new Date(1), new Date(2))).toBe(false);
  });
});

describe('store hooks', () => {
  it('useNode follows its node, keeps identity across unrelated edits and re-renders', () => {
    const { doc, a, b } = setup();
    const seen: (MarkupNode | undefined)[] = [];
    let rerender = () => {};
    function Probe() {
      const [, set] = useState(0);
      rerender = () => set((n) => n + 1);
      seen.push(useNode(a));
      return null;
    }
    render(
      <DocProvider doc={doc} actor={human}>
        <Probe />
      </DocProvider>,
    );
    const first = seen.at(-1)!;
    expect(first.styles.width).toBe('10px');
    act(() => doc.updateStyles(human, [{ nodeIds: [b], styles: { width: '30px' } }]));
    act(() => rerender());
    expect(seen.at(-1)).toBe(first);
    act(() => doc.updateStyles(human, [{ nodeIds: [a], styles: { width: '40px' } }]));
    expect(seen.at(-1)!.styles.width).toBe('40px');
    act(() => doc.deleteNodes(human, [a]));
    expect(seen.at(-1)).toBeUndefined();
  });

  it('useNode switches nodes when its id changes', () => {
    const { doc, a, b } = setup();
    let names: (string | undefined)[] = [];
    function Probe({ id }: { id: string }) {
      names.push(useNode(id)?.name);
      return null;
    }
    const view = render(
      <DocProvider doc={doc} actor={human}>
        <Probe id={a} />
      </DocProvider>,
    );
    expect(names.at(-1)).toBe('a');
    names = [];
    view.rerender(
      <DocProvider doc={doc} actor={human}>
        <Probe id={b} />
      </DocProvider>,
    );
    expect(names.every((n) => n === 'b')).toBe(true);
    act(() => doc.renameNodes(human, [{ nodeId: b, name: 'b2' }]));
    expect(names.at(-1)).toBe('b2');
  });

  it('many useNode subscribers on one id all update and unmount cleanly', () => {
    const { doc, a } = setup();
    const widths: Record<number, string | undefined> = {};
    function Probe({ i }: { i: number }) {
      widths[i] = useNode(a)?.styles.width as string | undefined;
      return null;
    }
    const view = render(
      <DocProvider doc={doc} actor={human}>
        {[0, 1, 2].map((i) => (
          <Probe key={i} i={i} />
        ))}
      </DocProvider>,
    );
    act(() => doc.updateStyles(human, [{ nodeIds: [a], styles: { width: '50px' } }]));
    expect(Object.values(widths)).toEqual(['50px', '50px', '50px']);
    view.unmount();
    expect(() => doc.updateStyles(human, [{ nodeIds: [a], styles: { width: '60px' } }])).not.toThrow();
  });

  it('useNodes re-reads only the listed nodes and follows the id list', () => {
    const { doc, rootId, a, b } = setup();
    const seen: MarkupNode[][] = [];
    function Probe({ ids }: { ids: string[] }) {
      seen.push(useNodes(ids));
      return null;
    }
    const view = render(
      <DocProvider doc={doc} actor={human}>
        <Probe ids={[a]} />
      </DocProvider>,
    );
    const first = seen.at(-1)!;
    act(() => doc.updateStyles(human, [{ nodeIds: [b], styles: { width: '30px' } }]));
    expect(seen.at(-1)).toBe(first);
    view.rerender(
      <DocProvider doc={doc} actor={human}>
        <Probe ids={[a, b]} />
      </DocProvider>,
    );
    expect(seen.at(-1)!.map((n) => n.styles.width)).toEqual(['10px', '30px']);
    act(() => doc.updateStyles(human, [{ nodeIds: [b], styles: { width: '35px' } }]));
    expect(seen.at(-1)!.map((n) => n.styles.width)).toEqual(['10px', '35px']);
    const [c] = doc.insertNodes(human, rootId, [{ type: 'frame', name: 'c', styles: {} }]);
    view.rerender(
      <DocProvider doc={doc} actor={human}>
        <Probe ids={[a, c!]} />
      </DocProvider>,
    );
    expect(seen.at(-1)!.map((n) => n.name)).toEqual(['a', 'c']);
    act(() => doc.deleteNodes(human, [c!]));
    expect(seen.at(-1)!.map((n) => n.name)).toEqual(['a']);
  });

  it('useDeep re-reads when its deps change, and on every render without deps', () => {
    const { doc, a, b } = setup();
    let withDeps: string | undefined;
    let withoutDeps: string | undefined;
    let outside = 'x';
    function Probe({ id }: { id: string }) {
      withDeps = useDeep(doc.nodes, () => doc.getNode(id)?.name, [id]);
      withoutDeps = useDeep(doc.nodes, () => `${doc.getNode(id)?.name}:${outside}`);
      return null;
    }
    const view = render(<Probe id={a} />);
    expect(withDeps).toBe('a');
    view.rerender(<Probe id={b} />);
    expect(withDeps).toBe('b');
    outside = 'y';
    view.rerender(<Probe id={b} />);
    expect(withoutDeps).toBe('b:y');
    act(() => doc.renameNodes(human, [{ nodeId: b, name: 'bb' }]));
    expect(withDeps).toBe('bb');
    expect(withoutDeps).toBe('bb:y');
  });
});
