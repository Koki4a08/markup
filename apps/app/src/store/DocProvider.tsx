import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { ActorUndo, type Actor, type MarkupDoc } from '@markup/doc';

interface DocContextValue {
  doc: MarkupDoc;
  actor: Actor;
  undo: ActorUndo;
}

const DocContext = createContext<DocContextValue | null>(null);

/** undo, when given, is owned by the caller (e.g. kept per tab by the workspace); otherwise one is made and destroyed here. */
export function DocProvider({ doc, actor, undo: given, children }: { doc: MarkupDoc; actor: Actor; undo?: ActorUndo; children: ReactNode }) {
  const own = useMemo(() => (given ? null : new ActorUndo(doc, actor)), [doc, actor, given]);
  useEffect(() => () => own?.destroy(), [own]);
  const undo = given ?? own!;
  const value = useMemo(() => ({ doc, actor, undo }), [doc, actor, undo]);
  return <DocContext.Provider value={value}>{children}</DocContext.Provider>;
}

export function useDoc(): DocContextValue {
  const ctx = useContext(DocContext);
  if (!ctx) throw new Error('useDoc must be used inside <DocProvider>.');
  return ctx;
}
