import { inTauri } from '../export/clipboard';
import { isMacPlatform } from '../commands/keyboard';

/**
 * Makes the webview behave like the inside of a desktop app rather than a web page: no browser
 * context menu, no reload / print / find / caret-browsing keys, no history navigation from mouse
 * side buttons, no middle-click autoscroll, and nothing (a dropped file, a link in a design, a form
 * in pasted HTML) can navigate the window away from the editor.
 *
 * The Rust side switches off WebView2's browser accelerators natively in release builds; these
 * listeners cover dev builds, macOS and Linux, and the behaviour no webview setting reaches.
 */

const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

const CHROME_CONTROL = 'button, [role=button], [role=tab]';
const KEEPS_FOCUS = '[role=dialog], [role=menu], [role=listbox], [aria-modal], .comment-popover, .context-menu, .canvas-menu, .settings-menu, .mcp-panel';

export function isEditable(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el && typeof el.closest === 'function' && !!el.closest(EDITABLE);
}

export interface ShortcutLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Mod+letter chords a browser binds to page actions: reload, print, find, save page, view source, history, downloads. */
const BROWSER_MOD_KEYS = new Set(['KeyR', 'KeyP', 'KeyF', 'KeyG', 'KeyS', 'KeyU', 'KeyH', 'KeyJ', 'KeyO']);
/** Keys a browser acts on alone: reload, find next, caret browsing. */
const BROWSER_KEYS = new Set(['F3', 'F5', 'F7', 'BrowserBack', 'BrowserForward', 'BrowserRefresh', 'BrowserSearch']);

/** True for a key press whose browser default (reload, print, find, back…) has no place in the app. */
export function isBrowserShortcut(e: ShortcutLike, mac: boolean): boolean {
  if (BROWSER_KEYS.has(e.code) || BROWSER_KEYS.has(e.key)) return true;
  // WKWebView has no reload, print or find of its own, and ⌘H, ⌘O… belong to the macOS menu bar.
  if (!mac && e.ctrlKey && !e.metaKey && !e.altKey && BROWSER_MOD_KEYS.has(e.code)) return true;
  // Alt+Left / Alt+Right (⌘[ / ⌘] on macOS) step through history.
  if (!mac && e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) return true;
  if (mac && e.metaKey && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) return true;
  return false;
}

/** Installs the guards; returns a function that removes them. */
export function installNativeBehaviour(options: { desktop?: boolean; mac?: boolean } = {}): () => void {
  const desktop = options.desktop ?? inTauri();
  const mac = options.mac ?? isMacPlatform();
  const off: Array<() => void> = [];
  const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, capture = false) => {
    window.addEventListener(type, fn, capture);
    off.push(() => window.removeEventListener(type, fn, capture));
  };

  // Everywhere, browser or desktop: the editor is one page, and nothing on it may navigate away.
  // A link inside a design is content to edit, not to follow.
  // The app's own download anchors (`download` attribute, used by browser-mode export) still work.
  const LINK = 'a[href]:not([download])';
  on('click', (e) => {
    if ((e.target as Element | null)?.closest?.(LINK)) e.preventDefault();
  });
  on('auxclick', (e) => {
    if ((e.target as Element | null)?.closest?.(LINK)) e.preventDefault();
  });
  on('submit', (e) => e.preventDefault(), true);
  // A toolbar button clicked with the mouse gives focus back, as native toolbars do: otherwise it keeps
  // Delete, Enter and Space for itself and they never reach the canvas. Keyboard focus (Tab) is untouched,
  // and so are menus, dialogs and popovers, which manage their own focus.
  on('click', (e) => {
    if (e.detail === 0) return;
    const control = (e.target as Element | null)?.closest?.(CHROME_CONTROL);
    if (!(control instanceof HTMLElement) || control !== document.activeElement || control.closest(KEEPS_FOCUS)) return;
    control.blur();
  });
  // A file dropped where nothing accepts it would open in place of the app. Handlers that do accept
  // files (the canvas) call preventDefault first; everything else refuses the drop.
  on('dragover', (e) => {
    if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  on('drop', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });

  if (!desktop) return () => off.forEach((f) => f());

  // Desktop only: in a browser tab these are the user's browser, and stay theirs.
  on(
    'keydown',
    (e) => {
      // Ctrl+U underlines in text being edited; elsewhere it is view-source.
      if (isBrowserShortcut(e, mac) && !(e.code === 'KeyU' && isEditable(e.target))) e.preventDefault();
    },
    true,
  );
  // Text fields keep their Cut / Copy / Paste menu; everywhere else the app draws its own or none.
  on('contextmenu', (e) => {
    if (e.defaultPrevented || isEditable(e.target)) return;
    if (window.getSelection()?.toString()) return;
    e.preventDefault();
  });
  // Middle-click would start the browser's autoscroll; side buttons would go back and forward.
  on('mousedown', (e) => {
    if (e.button === 1 && !isEditable(e.target)) e.preventDefault();
  });
  const noHistory = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  on('mouseup', noHistory);
  on('auxclick', noHistory);

  return () => off.forEach((f) => f());
}

type AppWindow = Awaited<ReturnType<typeof loadWindow>>;
const loadWindow = async () => (await import('@tauri-apps/api/window')).getCurrentWindow();
let appWindow: Promise<AppWindow> | null = null;
const desktopWindow = (): Promise<AppWindow> | null => {
  if (!inTauri()) return null;
  appWindow ??= loadWindow();
  return appWindow;
};

/**
 * The desktop window starts hidden so the first thing on screen is the finished UI, not a blank
 * frame. Called once the app has rendered; Rust shows the window anyway if this never runs.
 */
export function revealWindow(): void {
  void desktopWindow()?.then(async (w) => {
    if (await w.isVisible()) return;
    await w.show();
    await w.setFocus();
  }).catch(() => undefined);
}

/** Title in the taskbar, Alt+Tab and the Dock: the open file, like any document app. */
export function setWindowTitle(title: string): void {
  if (typeof document !== 'undefined') document.title = title;
  void desktopWindow()?.then((w) => w.setTitle(title)).catch(() => undefined);
}

/** Chrome colour behind the webview, matching `--chrome` in styles.css, shown while the window resizes. */
const WINDOW_BACKGROUND = { dark: '#0e0e11', light: '#f4f4f5' } as const;

/**
 * Keeps the native window (macOS traffic lights and vibrancy, the colour scheme the webview reports,
 * the backdrop seen while resizing) on the app's theme. `followSystem` hands the choice back to the OS
 * so "System" keeps tracking it.
 */
export function setWindowTheme(theme: 'light' | 'dark', followSystem = false): void {
  void desktopWindow()
    ?.then(async (w) => {
      await w.setTheme(followSystem ? null : theme);
      await w.setBackgroundColor(WINDOW_BACKGROUND[theme]);
    })
    .catch(() => undefined);
}
