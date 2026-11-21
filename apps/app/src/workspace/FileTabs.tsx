import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { icons } from '../panels/icons';
import { showSystemMenu, titleBarKind, WindowControls } from './WindowControls';
import { SettingsMenu } from '../ui/SettingsMenu';
import { useTabs, useWorkspace } from './WorkspaceProvider';

/**
 * Top strip: the dashboard button, then one tab per open file. In the desktop shell it is also the
 * window's title bar: empty space drags the window, and it carries the window controls.
 */
export function FileTabs({ dashboard, onDashboard, onTab, shortcut }: { dashboard: boolean; onDashboard(): void; onTab(): void; shortcut: string }) {
  const { workspace } = useWorkspace();
  const tabs = useTabs();
  const bar = titleBarKind();
  const listRef = useRef<HTMLDivElement>(null);
  const activeId = tabs.find((t) => t.active)?.fileId;

  // A vertical wheel scrolls the strip sideways, and the active tab is always brought into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || list.scrollWidth <= list.clientWidth) return;
      e.preventDefault();
      list.scrollLeft += e.deltaY;
    };
    list.addEventListener('wheel', onWheel, { passive: false });
    return () => list.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => {
    const el = activeId ? listRef.current?.querySelector<HTMLElement>(`[data-file-tab="${CSS.escape(activeId)}"]`) : null;
    el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  // Arrow keys move between tabs (one Tab stop for the whole strip), Home/End jump to the ends.
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
    const step = keys[e.key];
    if (step === undefined || e.altKey || e.ctrlKey || e.metaKey || !tabs.length) return;
    e.preventDefault();
    const at = tabs.findIndex((t) => t.fileId === (e.target as HTMLElement).closest<HTMLElement>('[data-file-tab]')?.dataset.fileTab);
    const next = step === -Infinity ? 0 : step === Infinity ? tabs.length - 1 : Math.min(tabs.length - 1, Math.max(0, at + step));
    const tab = tabs[next]!;
    workspace.activate(tab.fileId);
    onTab();
    listRef.current?.querySelector<HTMLElement>(`[data-file-tab="${CSS.escape(tab.fileId)}"] [role=tab]`)?.focus();
  };
  const focusable = (fileId: string) => fileId === (activeId ?? tabs[0]?.fileId);

  return (
    <nav
      className={`file-tabs title-bar-${bar}`}
      aria-label="Open files"
      data-tauri-drag-region={bar === 'none' ? undefined : true}
      onContextMenu={(e) => {
        // Right-click on the bare title bar opens the window's system menu, as on a native caption.
        if (bar !== 'custom' || !(e.target as HTMLElement).hasAttribute('data-tauri-drag-region')) return;
        e.preventDefault();
        showSystemMenu(true);
      }}
    >
      <button className={`file-tab home-tab ${dashboard ? 'is-active' : ''}`} aria-pressed={dashboard} aria-label="Files" data-tip="Files" data-tip-key={shortcut} onClick={onDashboard}>
        {icons.home}
      </button>
      <div className="file-tab-list" role="tablist" ref={listRef} onKeyDown={onListKey}>
        {tabs.map((tab) => {
          const selected = tab.active && !dashboard;
          return (
            <div key={tab.fileId} className={`file-tab ${selected ? 'is-active' : ''}`} data-file-tab={tab.fileId}>
              <button
                role="tab"
                tabIndex={focusable(tab.fileId) ? 0 : -1}
                aria-selected={selected}
                className="file-tab-name"
                onClick={() => {
                  workspace.activate(tab.fileId);
                  onTab();
                }}
                onAuxClick={(e) => e.button === 1 && workspace.close(tab.fileId)}
              >
                {tab.name}
              </button>
              <button className="icon-button file-tab-close" aria-label={`Close ${tab.name}`} data-tip="Close tab" onClick={() => workspace.close(tab.fileId)}>
                {icons.close}
              </button>
            </div>
          );
        })}
      </div>
      <div className="title-bar-drag" data-tauri-drag-region={bar === 'none' ? undefined : true} />
      <SettingsMenu />
      {bar === 'custom' && <WindowControls />}
    </nav>
  );
}
