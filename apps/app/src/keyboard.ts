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
  | 'wrapInFrame'
  | 'wrapInFlex'
  | 'collapseLayers'
  | 'exportSelection'
  | 'copyPng'
  | 'copyReact'
  | 'copyTailwind';

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

interface Binding {
  code: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
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
  { code: 'KeyF', shift: true, command: 'wrapInFrame' },
  { code: 'KeyA', shift: true, command: 'wrapInFlex' },
  { code: 'KeyL', alt: true, command: 'collapseLayers' },
  { code: 'KeyE', mod: true, shift: true, command: 'exportSelection' },
  { code: 'KeyC', mod: true, shift: true, command: 'copyPng' },
  { code: 'KeyR', alt: true, command: 'copyReact' },
  { code: 'KeyT', alt: true, command: 'copyTailwind' },
];

export function resolveShortcut(e: KeyLike, isMac: boolean): Command | null {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const otherMod = isMac ? e.ctrlKey : e.metaKey;
  if (otherMod) return null;
  const code = e.code || `Key${e.key.toUpperCase()}`;
  const hit = BINDINGS.find((b) => b.code === code && !!b.mod === mod && !!b.shift === e.shiftKey && !!b.alt === e.altKey);
  return hit?.command ?? null;
}

export const isMacPlatform = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
