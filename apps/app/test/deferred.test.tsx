import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor, type NodeSpec } from '@markup/doc';
import { finishReveal, HEAVY_SUBTREE, isHeavy, revealsSettled, scheduleReveal } from '../src/canvas/deferred';
import { DeferredNodeView } from '../src/canvas/NodeView';
import { DocProvider } from '../src/store/DocProvider';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

const rows = (n: number): NodeSpec[] => Array.from({ length: n }, (_, i) => ({ type: 'text', name: `Row ${i}`, text: `Row ${i}` }) as NodeSpec);

function setup(childCount: number) {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'Big', styles: { width: 400, height: 300 }, children: rows(childCount) } as NodeSpec]);
  return { doc, rootId: page.rootId, artboard: artboard! };
}

/** Lets the queued transitions and the macrotask between reveals run. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('deferred layers', () => {
  it('counts descendants up to the limit', () => {
    // The artboard's own count excludes itself: HEAVY_SUBTREE - 1 rows stay light.
    const edge = setup(HEAVY_SUBTREE - 1);
    expect(isHeavy(edge.doc, edge.artboard)).toBe(false);
    const big = setup(HEAVY_SUBTREE);
    expect(isHeavy(big.doc, big.artboard)).toBe(true);
    const small = setup(3);
    expect(isHeavy(small.doc, small.artboard)).toBe(false);
  });

  it('mounts a small artboard at once', () => {
    const { doc, artboard } = setup(3);
    const { container } = render(
      <DocProvider doc={doc} actor={human}>
        <DeferredNodeView id={artboard} />
      </DocProvider>,
    );
    expect(container.querySelector('.layer-placeholder')).toBeNull();
    expect(container.querySelector(`[data-node-id="${artboard}"]`)).not.toBeNull();
  });

  it('shows a sized placeholder for a heavy artboard, then its layers', async () => {
    const { doc, artboard } = setup(HEAVY_SUBTREE + 10);
    let container!: HTMLElement;
    act(() => {
      ({ container } = render(
        <DocProvider doc={doc} actor={human}>
          <DeferredNodeView id={artboard} />
        </DocProvider>,
      ));
    });
    await settle();
    expect(container.querySelector('.layer-placeholder')).toBeNull();
    expect(container.querySelectorAll('p').length).toBe(HEAVY_SUBTREE + 10);
  });

  it('renders a sized placeholder while its reveal waits in the queue', async () => {
    // Another layer is mounting: this one waits behind it.
    const blocker = scheduleReveal(() => undefined);
    const { doc, artboard } = setup(HEAVY_SUBTREE + 10);
    const { container } = render(
      <DocProvider doc={doc} actor={human}>
        <DeferredNodeView id={artboard} />
      </DocProvider>,
    );
    const placeholder = container.querySelector<HTMLElement>('.layer-placeholder');
    expect(placeholder).not.toBeNull();
    expect(placeholder!.style.width).toBe('400px');
    expect(placeholder!.style.height).toBe('300px');
    expect(container.querySelector('p')).toBeNull();
    finishReveal(blocker);
    await settle();
    expect(container.querySelector('.layer-placeholder')).toBeNull();
    expect(container.querySelectorAll('p').length).toBe(HEAVY_SUBTREE + 10);
  });

  it('defers a heavy subtree added later, and revealsSettled waits for it', async () => {
    const { doc, artboard } = setup(1);
    const { container } = render(
      <DocProvider doc={doc} actor={human}>
        <DeferredNodeView id={artboard} />
      </DocProvider>,
    );
    let pasted = '';
    act(() => {
      pasted = doc.insertNodes(human, artboard, [{ type: 'frame', name: 'Pasted', children: rows(HEAVY_SUBTREE + 5) } as NodeSpec])[0]!;
    });
    await settle();
    await revealsSettled();
    expect(container.querySelector(`[data-node-id="${pasted}"]`)).not.toBeNull();
    expect(container.querySelector('.layer-placeholder')).toBeNull();
  });
});
