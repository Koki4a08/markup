import { icons } from '../panels/icons';
import { useTabs, useWorkspace } from './WorkspaceProvider';

/** Top strip: the dashboard button, then one tab per open file. */
export function FileTabs({ dashboard, onDashboard, onTab, shortcut }: { dashboard: boolean; onDashboard(): void; onTab(): void; shortcut: string }) {
  const { workspace } = useWorkspace();
  const tabs = useTabs();
  return (
    <nav className="file-tabs" aria-label="Open files">
      <button className={`file-tab home-tab ${dashboard ? 'is-active' : ''}`} aria-pressed={dashboard} title={`Files (${shortcut})`} onClick={onDashboard}>
        {icons.home}
        <span className="sr-only">Files</span>
      </button>
      <div className="file-tab-list" role="tablist">
        {tabs.map((tab) => {
          const selected = tab.active && !dashboard;
          return (
            <div key={tab.fileId} className={`file-tab ${selected ? 'is-active' : ''}`}>
              <button
                role="tab"
                aria-selected={selected}
                className="file-tab-name"
                title={tab.name}
                onClick={() => {
                  workspace.activate(tab.fileId);
                  onTab();
                }}
                onAuxClick={(e) => e.button === 1 && workspace.close(tab.fileId)}
              >
                {tab.name}
              </button>
              <button className="icon-button file-tab-close" aria-label={`Close ${tab.name}`} title="Close" onClick={() => workspace.close(tab.fileId)}>
                {icons.close}
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
