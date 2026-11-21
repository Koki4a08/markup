import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor, type NodeSpec } from '@markup/doc';
import { SYNC_BUDGET } from '../src/canvas/deferred';
import { DeferredNodeView } from '../src/canvas/NodeView';
import { LayersPanel } from '../src/panels/LayersPanel';
import { SelectionProvider, useSelection } from '../src/canvas/selection';
import { DocProvider } from '../src/store/DocProvider';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

const rows = (n: number): NodeSpec[] => Array.from({ length: n }, (_, i) => ({ type: 'text', name: `Row ${i}`, text: `Row ${i}` }) as NodeSpec);

/** A page of many medium artboards: each one light, together heavy. */
function heavyPage(artboards: number, perArtboard: number) {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const ids = doc.insertNodes(
    human,
    page.rootId,
    Array.from({ length: artboards }, (_, i) => ({ type: 'frame', name: `Board ${i}`, styles: { width: 200, height: 200 }, children: rows(perArtboard) }) as NodeSpec),
  );
  return { doc, page, ids };
}

async function settle() {
  for (let i = 0; i < 40; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe('heavy pages', () => {
  it('mounts only a budget of many medium artboards at once, then the rest', async () => {
    // Let any budget spent by an earlier test refill.
    await new Promise((r) => setTimeout(r, 0));
    const perArtboard = 99;
    const count = Math.ceil((SYNC_BUDGET * 3) / (perArtboard + 1));
    const { doc, ids } = heavyPage(count, perArtboard);
    const { container } = render(
      <DocProvider doc={doc} actor={human}>
        {ids.map((id) => (
          <DeferredNodeView key={id} id={id} />
        ))}
      </DocProvider>,
    );
    const mountedAtOnce = ids.filter((id) => container.querySelector(`[data-node-id="${id}"]`)).length;
    expect(mountedAtOnce).toBeGreaterThan(0);
    // The budget's worth, plus the first queued one that act() lets finish before returning.
    expect(mountedAtOnce * (perArtboard + 1)).toBeLessThanOrEqual(SYNC_BUDGET + perArtboard + 1);
    expect(mountedAtOnce).toBeLessThan(count);
    expect(container.querySelectorAll('.layer-placeholder').length).toBe(count - mountedAtOnce);
    await settle();
    expect(container.querySelector('.layer-placeholder')).toBeNull();
    expect(container.querySelectorAll('p').length).toBe(count * perArtboard);
  });

  it('lists only artboards in the layers tree until one is opened or selected', () => {
    const { doc, page, ids } = heavyPage(3, 50);
    const child = doc.getNode(ids[1]!)!.children[7]!;
    let select: (ids: string[]) => void = () => undefined;
    const Capture = () => {
      select = useSelection().set;
      return null;
    };
    const { container } = render(
      <DocProvider doc={doc} actor={human}>
        <SelectionProvider>
          <LayersPanel activePageId={page.id} onPage={() => undefined} renamingId={null} onRenameDone={() => undefined} collapseSignal={0} />
          <Capture />
        </SelectionProvider>
      </DocProvider>,
    );
    expect(container.querySelectorAll('.layer-row').length).toBe(3);
    // Selecting a deep layer (as the canvas does) opens its ancestors.
    act(() => select([child]));
    expect(container.querySelectorAll('.layer-row').length).toBe(3 + 50);
    expect(container.querySelector('.layer-row.is-selected')?.textContent).toContain('Row 7');
  });
});
