import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { LibraryItem } from '@markup/doc';
import { connectBridge, type BridgeStatus, type DomTools } from '../bridge/client';
import type { Tab, Workspace } from './Workspace';

/** What a mounted editor offers for its file: canvas tools for agents, and a thumbnail. */
export interface Surface {
  domTools: Partial<DomTools>;
  thumbnail(): Promise<string | undefined> | undefined;
}

/** Editors on screen, by file id. Created before the workspace so thumbnails can be taken on close. */
export class Surfaces {
  private readonly map = new Map<string, Surface>();
  get(fileId: string): Surface | undefined {
    return this.map.get(fileId);
  }
  register(fileId: string, surface: Surface): () => void {
    this.map.set(fileId, surface);
    return () => {
      if (this.map.get(fileId) === surface) this.map.delete(fileId);
    };
  }
}

interface WorkspaceContextValue {
  workspace: Workspace;
  surfaces: Surfaces;
  bridgeStatus: BridgeStatus;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

/** Owns the one bridge connection of this window; it answers for every tab. */
export function WorkspaceProvider({ workspace, surfaces, children }: { workspace: Workspace; surfaces: Surfaces; children: ReactNode }) {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>('connecting');
  useEffect(() => {
    const bridge = connectBridge({ workspace, domTools: (fileId) => surfaces.get(fileId)?.domTools, onStatus: setBridgeStatus });
    return () => bridge.close();
  }, [workspace, surfaces]);
  return <WorkspaceContext.Provider value={{ workspace, surfaces, bridgeStatus }}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>.');
  return ctx;
}

/** Snapshot that keeps its identity while its JSON is unchanged. */
function useStable<T>(subscribe: (fn: () => void) => () => void, read: () => T): T {
  const cache = useRef<{ key: string; value: T } | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const get = useCallback(() => {
    const value = readRef.current();
    const key = JSON.stringify(value);
    if (!cache.current || cache.current.key !== key) cache.current = { key, value };
    return cache.current.value;
  }, []);
  return useSyncExternalStore(subscribe, get, get);
}

export function useTabs(): Tab[] {
  const { workspace } = useWorkspace();
  const subscribe = useCallback((fn: () => void) => workspace.on('change', fn), [workspace]);
  return useStable(subscribe, () => workspace.tabs());
}

/** Every library item, archived ones included; re-renders on any library change. */
export function useLibraryItems(): LibraryItem[] {
  const { workspace } = useWorkspace();
  const subscribe = useCallback(
    (fn: () => void) => {
      workspace.library.ydoc.on('update', fn);
      return () => workspace.library.ydoc.off('update', fn);
    },
    [workspace],
  );
  return useStable(subscribe, () => workspace.library.all());
}
