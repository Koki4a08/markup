import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { MarkupDoc } from '@markup/doc';

const VAR_REF = /var\(\s*(--[\w-]+)/g;

/** Token names a node's styles reference through var(--name), read straight from its Y.Map (no snapshot). */
function tokensOf(doc: MarkupDoc, id: string): Set<string> {
  const seen = new Set<string>();
  const styles = doc.nodes.get(id)?.get('styles') as Y.Map<unknown> | undefined;
  styles?.forEach((v) => {
    if (typeof v !== 'string') return;
    for (const m of v.matchAll(VAR_REF)) seen.add(m[1]!);
  });
  return seen;
}

/**
 * How many layers reference each token, kept up to date incrementally: a change re-scans only the
 * nodes it touched, instead of every node in the document.
 */
export class TokenUsageIndex {
  private perNode = new Map<string, Set<string>>();
  private counts: Record<string, number> = {};

  constructor(private readonly doc: MarkupDoc) {
    this.rebuild();
  }

  /** Current counts; the same object until a change alters them. */
  snapshot = (): Record<string, number> => this.counts;

  /** Full re-scan. Returns whether the counts changed. */
  rebuild(): boolean {
    this.perNode.clear();
    const counts: Record<string, number> = {};
    for (const id of this.doc.nodes.keys()) {
      const names = tokensOf(this.doc, id);
      if (names.size) this.perNode.set(id, names);
      for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
    }
    return this.publish(counts);
  }

  /** Applies a doc.nodes observeDeep batch. Returns whether the counts changed. */
  apply(events: Y.YEvent<any>[]): boolean {
    const dirty = new Set<string>();
    for (const e of events) {
      if (e.target === this.doc.nodes) for (const key of (e as Y.YMapEvent<unknown>).keysChanged) dirty.add(key);
      else if (typeof e.path[0] === 'string') dirty.add(e.path[0]);
    }
    if (!dirty.size) return false;
    const counts = { ...this.counts };
    for (const id of dirty) {
      for (const name of this.perNode.get(id) ?? []) {
        const n = (counts[name] ?? 0) - 1;
        if (n > 0) counts[name] = n;
        else delete counts[name];
      }
      const names = tokensOf(this.doc, id);
      if (names.size) this.perNode.set(id, names);
      else this.perNode.delete(id);
      for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
    }
    return this.publish(counts);
  }

  private publish(counts: Record<string, number>): boolean {
    const prev = this.counts;
    const keys = Object.keys(counts);
    if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === counts[k])) return false;
    this.counts = counts;
    return true;
  }
}

/** Live token usage counts for the document, updated off the render path. */
export function useTokenUsage(doc: MarkupDoc): Record<string, number> {
  const index = useMemo(() => new TokenUsageIndex(doc), [doc]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      const handler = (events: Y.YEvent<any>[]) => {
        if (index.apply(events)) onChange();
      };
      doc.nodes.observeDeep(handler);
      // Catch changes made between building the index during render and subscribing.
      if (index.rebuild()) onChange();
      return () => doc.nodes.unobserveDeep(handler);
    },
    [doc, index],
  );
  return useSyncExternalStore(subscribe, index.snapshot, index.snapshot);
}
