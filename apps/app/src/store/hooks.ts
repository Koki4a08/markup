import { useCallback, useRef, useSyncExternalStore, type DependencyList } from 'react';
import type * as Y from 'yjs';
import type { LogEntry, MarkupDoc, MarkupNode, PageEntry } from '@markup/doc';
import { useDoc } from './DocProvider';
import { structurallyEqual } from './equal';

type Subscribe = (onChange: () => void) => () => void;

interface SnapshotCache<T> {
  value: T;
  version: number;
  subscribe: Subscribe;
  deps: DependencyList;
}

function sameDeps(a: DependencyList, b: DependencyList): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * useSyncExternalStore with a version-gated cache: read() runs again only after the subscription
 * fired, the subscribe identity changed, or deps changed, and a result structurally equal to the
 * previous one keeps the previous identity.
 *
 * read may close over values beyond what subscribe tracks; list those in deps. Without deps the
 * read is assumed to depend on anything, so it runs once per render (and after each change).
 */
export function useStableSnapshot<T>(subscribe: Subscribe, read: () => T, deps?: DependencyList): T {
  const version = useRef(0);
  const cache = useRef<SnapshotCache<T> | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  // A fresh token per render when no deps were given: every render then counts as a change of inputs.
  const depsRef = useRef<DependencyList>(deps ?? [{}]);
  depsRef.current = deps ?? [{}];

  const versioned = useCallback<Subscribe>(
    (onChange) => {
      const unsubscribe = subscribe(() => {
        version.current++;
        onChange();
      });
      // Changes between render and subscribing were not seen; React checks the snapshot right after this.
      version.current++;
      return unsubscribe;
    },
    [subscribe],
  );

  const getSnapshot = useCallback(() => {
    const c = cache.current;
    if (c && c.version === version.current && c.subscribe === subscribeRef.current && sameDeps(c.deps, depsRef.current)) return c.value;
    const read = readRef.current();
    const value = c && structurallyEqual(c.value, read) ? c.value : read;
    cache.current = { value, version: version.current, subscribe: subscribeRef.current, deps: depsRef.current };
    return value;
  }, []);
  return useSyncExternalStore(versioned, getSnapshot, getSnapshot);
}

/** Snapshot of a Yjs type, re-read after deep changes to it; deps lists any other input read uses (see useStableSnapshot). */
export function useDeep<T>(type: Y.AbstractType<any>, read: () => T, deps?: DependencyList): T {
  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      type.observeDeep(onChange);
      return () => type.unobserveDeep(onChange);
    },
    [type],
  );
  return useStableSnapshot(subscribe, read, deps);
}

type NodesMap = MarkupDoc['nodes'];

/**
 * One doc.nodes observer per nodes map, fanned out by changed key. Yjs removes handlers with an
 * array filter, so one observer per hook made unmounting N nodes O(N^2).
 */
const keyListeners = new WeakMap<NodesMap, Map<string, Set<() => void>>>();

function onNodeKey(nodes: NodesMap, id: string, fn: () => void): () => void {
  let byId = keyListeners.get(nodes);
  if (!byId) {
    const map = new Map<string, Set<() => void>>();
    byId = map;
    keyListeners.set(nodes, map);
    nodes.observe((e) => {
      for (const key of e.keysChanged) {
        const set = map.get(key);
        if (set) for (const f of [...set]) f();
      }
    });
  }
  let set = byId.get(id);
  if (!set) byId.set(id, (set = new Set()));
  set.add(fn);
  const owner = byId;
  return () => {
    const s = owner.get(id);
    if (!s) return;
    s.delete(fn);
    if (!s.size) owner.delete(id);
  };
}

/** Calls onChange when the node's own map changes deeply, or when it is added to / removed from the document. */
function subscribeNode(doc: MarkupDoc, id: string, onChange: () => void): () => void {
  // A closure per subscription, so unobserving never removes another subscription's handler.
  const fire = () => onChange();
  let current: Y.Map<unknown> | undefined;
  const attach = () => {
    const next = doc.nodes.get(id);
    if (next === current) return;
    current?.unobserveDeep(fire);
    current = next;
    current?.observeDeep(fire);
  };
  attach();
  const off = onNodeKey(doc.nodes, id, () => {
    attach();
    onChange();
  });
  return () => {
    off();
    current?.unobserveDeep(fire);
  };
}

const NO_DEPS: DependencyList = [];

/** Re-renders when this node's own map changes, or when it is added to / removed from the document. */
export function useNode(id: string): MarkupNode | undefined {
  const { doc } = useDoc();
  const subscribe = useCallback<Subscribe>((onChange) => subscribeNode(doc, id, onChange), [doc, id]);
  return useStableSnapshot(subscribe, () => doc.getNode(id), NO_DEPS);
}

const EMPTY: string[] = [];

export function useChildren(id: string): string[] {
  return useNode(id)?.children ?? EMPTY;
}

export function usePages(): PageEntry[] {
  const { doc } = useDoc();
  return useDeep(doc.pagesArr, () => doc.pages(), [doc]);
}

export function useLog(): LogEntry[] {
  const { doc } = useDoc();
  return useDeep(doc.ydoc.getArray('log'), () => doc.log(), [doc]);
}

export function useWorking() {
  const { doc } = useDoc();
  return useDeep(doc.ydoc.getMap('working'), () => doc.working(), [doc]);
}

/** Snapshots of several nodes; re-reads when any of them changes, or is added to / removed from the document. */
export function useNodes(ids: string[]): MarkupNode[] {
  const { doc } = useDoc();
  const key = ids.join(',');
  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      const offs = [...new Set(key ? key.split(',') : [])].map((id) => subscribeNode(doc, id, onChange));
      return () => {
        for (const off of offs) off();
      };
    },
    [doc, key],
  );
  return useStableSnapshot(subscribe, () => (key ? key.split(',') : []).map((id) => doc.getNode(id)).filter((n): n is MarkupNode => !!n), NO_DEPS);
}
