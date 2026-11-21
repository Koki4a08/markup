import { useCallback, useSyncExternalStore } from 'react';

/**
 * A set of ids with per-id subscriptions: replacing the set notifies only the ids whose membership
 * flipped, so a list of rows re-renders just the rows that changed (selection, collapse, rename).
 */
export class IdSetStore {
  private ids: ReadonlySet<string>;
  private listeners = new Map<string, Set<() => void>>();

  constructor(initial: Iterable<string> = []) {
    this.ids = new Set(initial);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** The current ids; treat as read-only. */
  current(): ReadonlySet<string> {
    return this.ids;
  }

  replace(next: Iterable<string>): void {
    const prev = this.ids;
    const set = new Set(next);
    this.ids = set;
    const changed: string[] = [];
    for (const id of prev) if (!set.has(id)) changed.push(id);
    for (const id of set) if (!prev.has(id)) changed.push(id);
    for (const id of changed) {
      const fns = this.listeners.get(id);
      if (fns) for (const fn of [...fns]) fn();
    }
  }

  toggle(id: string): void {
    const next = new Set(this.ids);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.replace(next);
  }

  subscribe(id: string, fn: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(fn);
    return () => {
      const s = this.listeners.get(id);
      if (!s) return;
      s.delete(fn);
      if (!s.size) this.listeners.delete(id);
    };
  }
}

/** Whether id is in the store; re-renders only when that id's membership flips. */
export function useIdIn(store: IdSetStore, id: string): boolean {
  const subscribe = useCallback((fn: () => void) => store.subscribe(id, fn), [store, id]);
  const get = useCallback(() => store.has(id), [store, id]);
  return useSyncExternalStore(subscribe, get, get);
}
