import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { ActorUndo, type Actor, type MarkupDoc } from '@markup/doc';

interface DocContextValue {
  doc: MarkupDoc;
  actor: Actor;
  undo: ActorUndo;
}

const DocContext = createContext<DocContextValue | null>(null);

export function DocProvider({ doc, actor, children }: { doc: MarkupDoc; actor: Actor; children: ReactNode }) {
  const undo = useMemo(() => new ActorUndo(doc, actor), [doc, actor]);
  useEffect(() => () => undo.destroy(), [undo]);
  const value = useMemo(() => ({ doc, actor, undo }), [doc, actor, undo]);
  return <DocContext.Provider value={value}>{children}</DocContext.Provider>;
}

export function useDoc(): DocContextValue {
  const ctx = useContext(DocContext);
  if (!ctx) throw new Error('useDoc must be used inside <DocProvider>.');
  return ctx;
}
