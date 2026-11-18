import { useEffect, useMemo, useState } from 'react';
import { ActorUndo, type Actor } from '@markup/doc';
import { Editor } from './Editor';
import { isMacPlatform } from './keyboard';
import { DocProvider } from './store/DocProvider';
import { Dashboard } from './workspace/Dashboard';
import { FileTabs } from './workspace/FileTabs';
import { openLocalWorkspace, restoreTabs, saveTabs } from './workspace/persistence';
import type { Workspace } from './workspace/Workspace';
import { Surfaces, useTabs, useWorkspace, WorkspaceProvider } from './workspace/WorkspaceProvider';

export const LOCAL_USER: Actor = { id: 'local-user', kind: 'human', name: 'You' };

export function App() {
  const surfaces = useMemo(() => new Surfaces(), []);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: Workspace | null = null;
    openLocalWorkspace({ captureThumbnail: (fileId) => surfaces.get(fileId)?.thumbnail() })
      .then(async (ws) => {
        opened = ws;
        if (cancelled) return ws.dispose();
        await restoreTabs(ws);
        if (cancelled) return ws.dispose();
        ws.on('change', () => saveTabs(ws));
        setWorkspace(ws);
        if (import.meta.env.DEV) Object.assign(window, { __markup: { workspace: ws, actor: LOCAL_USER } });
      })
      .catch((e: Error) => setError(`Could not open the local file store: ${e.message}. Reload to try again.`));
    return () => {
      cancelled = true;
      opened?.dispose();
    };
  }, [surfaces]);

  if (error) return <div className="boot-message" role="alert">{error}</div>;
  if (!workspace) return <div className="boot-message">Opening files…</div>;
  return (
    <WorkspaceProvider workspace={workspace} surfaces={surfaces}>
      <Shell />
    </WorkspaceProvider>
  );
}

export function Shell() {
  const { workspace } = useWorkspace();
  const tabs = useTabs();
  const active = tabs.find((t) => t.active);
  const [dashboard, setDashboard] = useState(() => !active);
  const mac = isMacPlatform();
  const shortcut = mac ? '⌘\\' : 'Ctrl+\\';

  // Opening a file (from a tab, the dashboard or an agent's open_file) brings its editor forward.
  const activeId = active?.fileId ?? null;
  useEffect(() => {
    setDashboard(activeId === null);
  }, [activeId]);
  // open() on the tab already in front changes nothing above, but must still leave the dashboard.
  useEffect(() => workspace.on('reveal', () => setDashboard(false)), [workspace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Backslash' || !(mac ? e.metaKey : e.ctrlKey) || e.shiftKey || e.altKey) return;
      e.preventDefault();
      setDashboard((d) => (d && workspace.activeDoc() ? false : true));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mac, workspace]);

  const doc = activeId ? workspace.doc(activeId) : undefined;
  // One undo history per open tab, kept by the workspace so it survives tab switches and the dashboard.
  const undo = doc ? workspace.tabState(doc.fileId, 'undo', () => new ActorUndo(doc, LOCAL_USER), (u) => u.destroy()) : undefined;
  return (
    <div className="app-shell">
      <FileTabs dashboard={dashboard || !doc} onDashboard={() => setDashboard((d) => (d && doc ? false : true))} onTab={() => setDashboard(false)} shortcut={shortcut} />
      {dashboard || !doc ? (
        <Dashboard onOpened={() => setDashboard(false)} />
      ) : (
        <DocProvider key={doc.fileId} doc={doc} actor={LOCAL_USER} undo={undo}>
          <Editor />
        </DocProvider>
      )}
    </div>
  );
}
