import { describe, expect, it, vi } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { IdSetStore } from '../src/panels/idSetStore';
import { TokenUsageIndex } from '../src/panels/tokenUsage';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

describe('IdSetStore', () => {
  it('notifies only the ids whose membership flipped', () => {
    const store = new IdSetStore(['a', 'b']);
    const fa = vi.fn();
    const fb = vi.fn();
    const fc = vi.fn();
    store.subscribe('a', fa);
    store.subscribe('b', fb);
    const offC = store.subscribe('c', fc);
    store.replace(['b', 'c']);
    expect(fa).toHaveBeenCalledTimes(1);
    expect(fb).not.toHaveBeenCalled();
    expect(fc).toHaveBeenCalledTimes(1);
    expect(store.has('a')).toBe(false);
    expect(store.has('c')).toBe(true);
    offC();
    store.toggle('c');
    expect(fc).toHaveBeenCalledTimes(1);
    expect(store.has('c')).toBe(false);
    store.toggle('a');
    expect(fa).toHaveBeenCalledTimes(2);
    expect([...store.current()].sort()).toEqual(['a', 'b']);
  });
});

/** The full-scan result the index must always match. */
function scan(doc: MarkupDoc): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of doc.nodes.keys()) {
    const seen = new Set<string>();
    for (const v of Object.values(doc.getNode(id)!.styles)) if (typeof v === 'string') for (const m of v.matchAll(/var\(\s*(--[\w-]+)/g)) seen.add(m[1]!);
    for (const name of seen) counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

describe('TokenUsageIndex', () => {
  it('tracks var() references incrementally through edits, inserts and deletes', () => {
    const doc = new MarkupDoc();
    const page = doc.pages()[0]!;
    if (page.type !== 'page') throw new Error('unreachable');
    const [a, b] = doc.insertNodes(human, page.rootId, [
      { type: 'frame', name: 'a', styles: { color: 'var(--brand)', backgroundColor: 'var(--brand)' } },
      { type: 'frame', name: 'b', styles: { width: '10px' } },
    ]);
    const index = new TokenUsageIndex(doc);
    doc.nodes.observeDeep((events) => index.apply(events));
    expect(index.snapshot()).toEqual({ '--brand': 1 });
    expect(index.snapshot()).toEqual(scan(doc));

    const before = index.snapshot();
    doc.renameNodes(human, [{ nodeId: b!, name: 'renamed' }]);
    expect(index.snapshot()).toBe(before);

    doc.updateStyles(human, [{ nodeIds: [b!], styles: { color: 'var(--brand)', padding: 'var(--space)' } }], undefined, { dialect: 'any' });
    expect(index.snapshot()).toEqual(scan(doc));
    expect(index.snapshot()['--brand']).toBe(2);

    doc.updateStyles(human, [{ nodeIds: [a!], styles: { color: null, backgroundColor: null } }]);
    expect(index.snapshot()).toEqual(scan(doc));

    doc.insertNodes(human, b!, [{ type: 'frame', name: 'c', styles: { gap: 'var(--space)' } }]);
    expect(index.snapshot()).toEqual(scan(doc));

    doc.deleteNodes(human, [b!]);
    expect(index.snapshot()).toEqual(scan(doc));
    expect(index.snapshot()).toEqual({});
  });
});
