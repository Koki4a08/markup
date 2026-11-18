import { useCallback, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import type { LogEntry, MarkupNode, PageEntry } from '@markup/doc';
import { useDoc } from './DocProvider';

type Subscribe = (onChange: () => void) => () => void;

/** useSyncExternalStore with a JSON-keyed cache so unchanged snapshots keep their identity. */
function useStableSnapshot<T>(subscribe: Subscribe, read: () => T): T {
  const cache = useRef<{ key: string; value: T } | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const getSnapshot = useCallback(() => {
    const value = readRef.current();
    const key = JSON.stringify(value) ?? 'undefined';
    if (!cache.current || cache.current.key !== key) cache.current = { key, value };
    return cache.current.value;
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useDeep<T>(type: Y.AbstractType<any>, read: () => T): T {
  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      type.observeDeep(onChange);
      return () => type.unobserveDeep(onChange);
    },
    [type],
  );
  return useStableSnapshot(subscribe, read);
}

/** Re-renders when this node's own map changes, or when it is added to / removed from the document. */
export function useNode(id: string): MarkupNode | undefined {
  const { doc } = useDoc();
  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      let current: Y.Map<unknown> | undefined;
      const attach = () => {
        const next = doc.nodes.get(id);
        if (next === current) return;
        current?.unobserveDeep(onChange);
        current = next;
        current?.observeDeep(onChange);
      };
      const onNodes = (e: Y.YMapEvent<Y.Map<unknown>>) => {
        if (!e.keysChanged.has(id)) return;
        attach();
        onChange();
      };
      attach();
      doc.nodes.observe(onNodes);
      return () => {
        doc.nodes.unobserve(onNodes);
        current?.unobserveDeep(onChange);
      };
    },
    [doc, id],
  );
  return useStableSnapshot(subscribe, () => doc.getNode(id));
}

const EMPTY: string[] = [];

export function useChildren(id: string): string[] {
  return useNode(id)?.children ?? EMPTY;
}

export function usePages(): PageEntry[] {
  const { doc } = useDoc();
  return useDeep(doc.pagesArr, () => doc.pages());
}

export function useLog(): LogEntry[] {
  const { doc } = useDoc();
  return useDeep(doc.ydoc.getArray('log'), () => doc.log());
}

export function useWorking() {
  const { doc } = useDoc();
  return useDeep(doc.ydoc.getMap('working'), () => doc.working());
}

/** Snapshots of several nodes; re-reads after every document transaction. */
export function useNodes(ids: string[]): MarkupNode[] {
  const { doc } = useDoc();
  const key = ids.join(',');
  const subscribe = useCallback<Subscribe>(
    (onChange) => {
      doc.ydoc.on('afterTransaction', onChange);
      return () => doc.ydoc.off('afterTransaction', onChange);
    },
    [doc],
  );
  return useStableSnapshot(subscribe, () => (key ? key.split(',') : []).map((id) => doc.getNode(id)).filter((n): n is MarkupNode => !!n));
}
