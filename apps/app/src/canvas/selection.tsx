import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface SelectionValue {
  ids: string[];
  set(ids: string[]): void;
  /** Always-current selection, for non-React callers (bridge, commands). */
  get(): string[];
}

const SelectionContext = createContext<SelectionValue | null>(null);

export function SelectionProvider({ children, initial = [] }: { children: ReactNode; initial?: string[] }) {
  const [ids, setIds] = useState<string[]>(initial);
  const ref = useRef<string[]>(initial);
  const set = useCallback((next: string[]) => {
    ref.current = next;
    setIds(next);
  }, []);
  const get = useCallback(() => ref.current, []);
  const value = useMemo(() => ({ ids, set, get }), [ids, set, get]);
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function useSelection(): SelectionValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error('useSelection must be used inside <SelectionProvider>.');
  return ctx;
}
