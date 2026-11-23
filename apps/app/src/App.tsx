import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActorUndo, type Actor } from '@markup/doc';
import { Editor } from './editor/Editor';
import { preventAppZoom } from './canvas/navigation';
import { revealWindow, setWindowTitle } from './desktop/native';
import { tabShortcut, tabTarget, type TabCommand } from './desktop/tabShortcuts';
import { inTauri } from './export/clipboard';
import { TooltipLayer } from './ui/Tooltip';
import { isMacPlatform } from './commands/keyboard';
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
        const { done } = await restoreTabs(ws);
        if (cancelled) return ws.dispose();
        // Background tabs are still loading: saving now would drop the ones not open yet if the app reloads.
        let restoring = true;
        ws.on('change', () => {
          if (!restoring) saveTabs(ws);
        });
        void done.then(() => {
          restoring = false;
          if (!cancelled) saveTabs(ws);
        });
        setWorkspace(ws);
        if (import.meta.env.DEV) Object.assign(window, { __markup: { workspace: ws, actor: LOCAL_USER } });
      })
      .catch((e: Error) => setError(`Could not open the local file store: ${e.message}. Reload to try again.`));
    return () => {
      cancelled = true;
      opened?.dispose();
    };
  }, [surfaces]);

  // The desktop window opens hidden; it appears once there is something real to show.
  const ready = !!workspace || !!error;
  useEffect(() => {
    if (ready) revealWindow();
  }, [ready]);

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

  // A pinch or Ctrl+wheel over the panels must not zoom the whole app; the canvas handles its own.
  useEffect(() => preventAppZoom(), []);

  // Tab commands read the current strip through a ref, so the listeners below never go stale.
  const tabState = useRef({ ids: tabs.map((t) => t.fileId), activeId: activeId, dashboard });
  tabState.current = { ids: tabs.map((t) => t.fileId), activeId, dashboard };
  const runTab = useCallback(
    (command: TabCommand) => {
      const { ids, activeId: current, dashboard: onDashboard } = tabState.current;
      if (command.kind === 'close') {
        if (current && !onDashboard) workspace.close(current);
        return;
      }
      if (command.kind === 'new') {
        void workspace.createFile({}).then(
          (created) => workspace.open(created.id),
          (err: unknown) => console.error('Could not create a file', err),
        );
        return;
      }
      const target = tabTarget(ids, onDashboard ? null : current, command);
      if (!target) return;
      workspace.activate(target);
      setDashboard(false);
    },
    [workspace],
  );

  useEffect(() => {
    const desktop = inTauri();
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Backslash' && (mac ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setDashboard((d) => (d && workspace.activeDoc() ? false : true));
        return;
      }
      // In a browser these chords belong to the browser's own tabs.
      if (!desktop) return;
      const command = tabShortcut(e, mac);
      if (!command) return;
      e.preventDefault();
      runTab(command);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mac, workspace, runTab]);

  // macOS File menu (New File ⌘N, Close Tab ⌘W) arrives as events from the native menu bar.
  useEffect(() => {
    if (!inTauri()) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event')
      .then(({ listen }) =>
        listen<string>('menu', ({ payload }) => {
          if (payload === 'close-tab') runTab({ kind: 'close' });
          else if (payload === 'new-file') runTab({ kind: 'new' });
        }),
      )
      .then((off) => (live ? (unlisten = off) : off()))
      .catch(() => undefined);
    return () => {
      live = false;
      unlisten?.();
    };
  }, [runTab]);

  const doc = activeId ? workspace.doc(activeId) : undefined;
  const title = dashboard || !active ? 'Markup' : `${active.name} — Markup`;
  useEffect(() => setWindowTitle(title), [title]);
  // Leaving the editor for the dashboard: refresh this file's card from what is on screen right now.
  const toggleDashboard = () => {
    if (!dashboard && doc) workspace.refreshThumbnail(doc.fileId);
    setDashboard((d) => (d && doc ? false : true));
  };
  // One undo history per open tab, kept by the workspace so it survives tab switches and the dashboard.
  const undo = doc ? workspace.tabState(doc.fileId, 'undo', () => new ActorUndo(doc, LOCAL_USER), (u) => u.destroy()) : undefined;
  return (
    <div className="app-shell">
      <TooltipLayer />
      <FileTabs dashboard={dashboard || !doc} onDashboard={toggleDashboard} onTab={() => setDashboard(false)} shortcut={shortcut} />
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
