import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LibraryItem } from '@markup/doc';
import type { BridgeStatus, DomTools } from '../bridge/client';
import { useStableSnapshot } from '../store/hooks';
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
    // Retries after a failed attempt report 'connecting' again every couple of seconds; both states
    // read as offline, so keep 'offline' instead of re-rendering every consumer on each retry.
    const onStatus = (next: BridgeStatus) => setBridgeStatus((prev) => (next === 'connecting' && prev === 'offline' ? prev : next));
    // The bridge (agent tools, the protocol's zod schemas) loads after the first paint, off the startup path.
    let closed = false;
    let bridge: { close(): void } | undefined;
    void import('../bridge/client').then(
      ({ connectBridge }) => {
        if (!closed) bridge = connectBridge({ workspace, domTools: (fileId) => surfaces.get(fileId)?.domTools, onStatus });
      },
      (err: unknown) => {
        console.error('Could not load the agent bridge', err);
        if (!closed) setBridgeStatus('offline');
      },
    );
    return () => {
      closed = true;
      bridge?.close();
    };
  }, [workspace, surfaces]);
  const value = useMemo(() => ({ workspace, surfaces, bridgeStatus }), [workspace, surfaces, bridgeStatus]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside <WorkspaceProvider>.');
  return ctx;
}

const NO_DEPS: readonly unknown[] = [];

export function useTabs(): Tab[] {
  const { workspace } = useWorkspace();
  // Tab names come from the library, which renames without a workspace 'change'.
  const subscribe = useCallback(
    (fn: () => void) => {
      const off = workspace.on('change', fn);
      workspace.library.ydoc.on('update', fn);
      return () => {
        off();
        workspace.library.ydoc.off('update', fn);
      };
    },
    [workspace],
  );
  return useStableSnapshot(subscribe, () => workspace.tabs(), NO_DEPS);
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
  return useStableSnapshot(subscribe, () => workspace.library.all(), NO_DEPS);
}
