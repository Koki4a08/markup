import type { ShortcutLike } from './native';

/** What a tab shortcut asks for. `goto` takes a 0-based index; -1 means the last tab. */
export type TabCommand = { kind: 'close' } | { kind: 'new' } | { kind: 'cycle'; step: 1 | -1 } | { kind: 'goto'; index: number };

/**
 * Desktop tab shortcuts, as in any tabbed editor: Ctrl+W / Ctrl+F4 close, Ctrl+Tab and Ctrl+PageDown
 * cycle (with Shift, or PageUp, backwards), Ctrl+1…8 jump and Ctrl+9 goes to the last tab, Ctrl+N makes
 * a file. On macOS, ⌘W and ⌘N belong to the File menu (which sends them back as menu events), and
 * cycling stays on Control+Tab because ⌘Tab is the system app switcher.
 */
export function tabShortcut(e: ShortcutLike, mac: boolean): TabCommand | null {
  if (e.altKey) return null;
  if (e.ctrlKey && !e.metaKey && e.code === 'Tab') return { kind: 'cycle', step: e.shiftKey ? -1 : 1 };
  if (!mac && e.ctrlKey && !e.shiftKey && (e.code === 'PageDown' || e.code === 'PageUp')) return { kind: 'cycle', step: e.code === 'PageDown' ? 1 : -1 };
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.shiftKey) return null;
  if (!mac && (e.code === 'KeyW' || e.code === 'F4')) return { kind: 'close' };
  if (!mac && e.code === 'KeyN') return { kind: 'new' };
  const digit = /^Digit([1-9])$/.exec(e.code);
  if (digit) return { kind: 'goto', index: digit[1] === '9' ? -1 : Number(digit[1]) - 1 };
  return null;
}

/** The tab a cycle or goto lands on, or null when there is nowhere to go. */
export function tabTarget(ids: readonly string[], activeId: string | null, command: TabCommand): string | null {
  if (!ids.length) return null;
  if (command.kind === 'goto') return command.index === -1 ? ids[ids.length - 1]! : (ids[command.index] ?? null);
  if (command.kind !== 'cycle') return null;
  const at = activeId ? ids.indexOf(activeId) : -1;
  if (at === -1) return ids[command.step === 1 ? 0 : ids.length - 1]!;
  return ids[(at + command.step + ids.length) % ids.length]!;
}
