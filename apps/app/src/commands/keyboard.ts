export type Command =
  | 'tool:move'
  | 'tool:frame'
  | 'tool:rect'
  | 'tool:text'
  | 'tool:hand'
  | 'tool:comment'
  | 'delete'
  | 'duplicate'
  | 'selectChildren'
  | 'selectParent'
  | 'undo'
  | 'redo'
  | 'rename'
  | 'toggleHidden'
  | 'toggleLocked'
  | 'zoomToFit'
  | 'zoomTo100'
  | 'zoomIn'
  | 'zoomOut'
  | 'wrapInFrame'
  | 'wrapInFlex'
  | 'collapseLayers'
  | 'exportSelection'
  | 'copyPng'
  | 'copyReact'
  | 'copyTailwind'
  | 'pasteOnTop'
  | 'pasteToReplace'
  | 'deselect'
  | 'copy'
  | 'copyLink'
  | 'copyHtml'
  | 'copySvg'
  | 'paste'
  | 'copyStyles'
  | 'pasteStyles'
  | 'removeFlex'
  | 'ungroup'
  | 'bringToFront'
  | 'sendToBack'
  | 'moveForward'
  | 'moveBackward'
  | 'setThumbnail';

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface KeyCombo {
  code: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

interface Binding extends KeyCombo {
  command: Command;
}

/** `mod` is ⌘ on macOS and Ctrl elsewhere. Matched by physical key code so layouts and Shift do not change the meaning. */
const BINDINGS: Binding[] = [
  { code: 'KeyV', command: 'tool:move' },
  { code: 'KeyF', command: 'tool:frame' },
  { code: 'KeyR', command: 'tool:rect' },
  { code: 'KeyT', command: 'tool:text' },
  { code: 'KeyH', command: 'tool:hand' },
  { code: 'KeyC', command: 'tool:comment' },
  { code: 'Backspace', command: 'delete' },
  { code: 'Delete', command: 'delete' },
  { code: 'KeyD', mod: true, command: 'duplicate' },
  { code: 'Enter', command: 'selectChildren' },
  { code: 'Escape', command: 'selectParent' },
  { code: 'Backslash', command: 'selectParent' },
  { code: 'KeyZ', mod: true, command: 'undo' },
  { code: 'KeyZ', mod: true, shift: true, command: 'redo' },
  { code: 'KeyY', mod: true, command: 'redo' },
  { code: 'KeyR', mod: true, command: 'rename' },
  { code: 'KeyH', mod: true, shift: true, command: 'toggleHidden' },
  { code: 'KeyL', mod: true, shift: true, command: 'toggleLocked' },
  { code: 'Digit1', shift: true, command: 'zoomToFit' },
  { code: 'Digit0', mod: true, command: 'zoomTo100' },
  { code: 'Numpad0', mod: true, command: 'zoomTo100' },
  { code: 'Equal', mod: true, command: 'zoomIn' },
  { code: 'NumpadAdd', mod: true, command: 'zoomIn' },
  { code: 'Minus', mod: true, command: 'zoomOut' },
  { code: 'NumpadSubtract', mod: true, command: 'zoomOut' },
  { code: 'KeyF', shift: true, command: 'wrapInFrame' },
  { code: 'KeyA', shift: true, command: 'wrapInFlex' },
  { code: 'KeyL', alt: true, command: 'collapseLayers' },
  { code: 'KeyE', mod: true, shift: true, command: 'exportSelection' },
  { code: 'KeyC', mod: true, shift: true, command: 'copyPng' },
  { code: 'KeyR', alt: true, command: 'copyReact' },
  { code: 'KeyT', alt: true, command: 'copyTailwind' },
  { code: 'KeyV', mod: true, shift: true, command: 'pasteOnTop' },
  { code: 'KeyR', mod: true, shift: true, command: 'pasteToReplace' },
  { code: 'Escape', shift: true, command: 'deselect' },
  { code: 'KeyC', mod: true, command: 'copy' },
  { code: 'KeyL', mod: true, command: 'copyLink' },
  { code: 'KeyC', mod: true, alt: true, command: 'copyStyles' },
  { code: 'KeyV', mod: true, alt: true, command: 'pasteStyles' },
  { code: 'KeyA', shift: true, alt: true, command: 'removeFlex' },
  { code: 'KeyG', mod: true, shift: true, command: 'ungroup' },
  { code: 'BracketRight', command: 'bringToFront' },
  { code: 'BracketLeft', command: 'sendToBack' },
  { code: 'BracketRight', mod: true, command: 'moveForward' },
  { code: 'BracketLeft', mod: true, command: 'moveBackward' },
  // No plain mod+V: the browser's paste event carries the clipboard without a permission prompt.
];

export function resolveShortcut(e: KeyLike, isMac: boolean): Command | null {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const otherMod = isMac ? e.ctrlKey : e.metaKey;
  if (otherMod) return null;
  // Zoom keys go by the character typed, so + and − work on every keyboard layout (with or without Shift).
  if (mod && !e.altKey && (e.key === '+' || e.key === '=')) return 'zoomIn';
  if (mod && !e.altKey && (e.key === '-' || e.key === '_')) return 'zoomOut';
  const code = e.code || `Key${e.key.toUpperCase()}`;
  const hit = BINDINGS.find((b) => b.code === code && !!b.mod === mod && !!b.shift === e.shiftKey && !!b.alt === e.altKey);
  return hit?.command ?? null;
}

export const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const KEY_NAMES: Record<string, string> = { Equal: '+', Minus: '−', NumpadAdd: '+', NumpadSubtract: '−', Escape: 'Esc', Enter: 'Enter', BracketRight: ']', BracketLeft: '[', Backslash: '\\',Backspace: '⌫', Delete: 'Del' };

/** Display text for a key combo: `Ctrl+Shift+C` on Windows and Linux, `⇧⌘C` on macOS. */
export function formatShortcut(combo: KeyCombo, isMac: boolean): string {
  const key = KEY_NAMES[combo.code] ?? combo.code.replace(/^(Key|Digit)/, '');
  if (isMac) return `${combo.alt ? '⌥' : ''}${combo.shift ? '⇧' : ''}${combo.mod ? '⌘' : ''}${key}`;
  return [combo.mod && 'Ctrl', combo.shift && 'Shift', combo.alt && 'Alt', key].filter(Boolean).join('+');
}

/** The first shortcut bound to a command, formatted for the platform; '' when it has none. */
export function shortcutLabel(command: Command, isMac: boolean): string {
  const binding = BINDINGS.find((b) => b.command === command);
  return binding ? formatShortcut(binding, isMac) : '';
}
