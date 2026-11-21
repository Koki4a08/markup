import { useEffect, useState } from 'react';
import { inTauri } from '../export/clipboard';
import { isMacPlatform } from '../commands/keyboard';
import { icons } from '../panels/icons';

type AppWindow = Awaited<ReturnType<typeof loadWindow>>;
const loadWindow = async () => (await import('@tauri-apps/api/window')).getCurrentWindow();

/** How the desktop shell draws its title bar: our own controls on Windows/Linux, macOS traffic lights over the strip. */
export type TitleBar = 'none' | 'custom' | 'mac-overlay';

export function titleBarKind(): TitleBar {
  if (!inTauri()) return 'none';
  return isMacPlatform() ? 'mac-overlay' : 'custom';
}

/** Opens the Windows system menu (Restore, Move, Size, Minimize, Maximize, Close) at the cursor or the window corner. */
export function showSystemMenu(atCursor: boolean): void {
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('show_system_menu', { atCursor }))
    .catch(() => undefined);
}

/** Minimize, maximize/restore and close for the undecorated desktop window. */
export function WindowControls() {
  const [win, setWin] = useState<AppWindow | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;
    void loadWindow().then(async (w) => {
      if (!live) return;
      setWin(w);
      const sync = () => void w.isMaximized().then((m) => live && setMaximized(m), () => undefined);
      sync();
      const offResize = await w.onResized(sync);
      // Like native caption buttons, the title bar dims while another window is active.
      const offFocus = await w.onFocusChanged(({ payload: focused }) => document.documentElement.classList.toggle('is-window-inactive', !focused));
      unlisten = () => {
        offResize();
        offFocus();
        document.documentElement.classList.remove('is-window-inactive');
      };
      if (!live) unlisten();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);

  // Alt+Space opens the system menu, as it does on every Windows window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      showSystemMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="window-controls">
      <button className="window-control" aria-label="Minimize" data-tip="Minimize" onClick={() => void win?.minimize()}>
        {icons.minus}
      </button>
      <button className="window-control" aria-label={maximized ? 'Restore' : 'Maximize'} data-tip={maximized ? 'Restore' : 'Maximize'} onClick={() => void win?.toggleMaximize()}>
        {maximized ? icons.restore : icons.maximize}
      </button>
      <button className="window-control is-close" aria-label="Close window" data-tip="Close" onClick={() => void win?.close()}>
        {icons.windowClose}
      </button>
    </div>
  );
}
