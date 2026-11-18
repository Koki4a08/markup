import { useEffect, useRef } from 'react';

export interface CopyMenuState {
  x: number;
  y: number;
}

const ITEMS = [
  { command: 'copyReact', label: 'Copy as React', shortcut: '⌥R' },
  { command: 'copyTailwind', label: 'Copy as Tailwind', shortcut: '⌥T' },
  { command: 'copyPng', label: 'Copy as PNG', shortcut: '⇧⌘C' },
] as const;

export type CopyCommand = (typeof ITEMS)[number]['command'];

/** Canvas right-click menu. Esc, an outside click or choosing an entry closes it; arrow keys move between entries. */
export function CopyMenu({ at, onPick, onClose }: { at: CopyMenuState; onPick(command: CopyCommand): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(i + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  const left = Math.min(at.x, window.innerWidth - 220);
  const top = Math.min(at.y, window.innerHeight - 120);
  return (
    <div ref={ref} className="context-menu" role="menu" aria-label="Copy as" style={{ left, top }}>
      {ITEMS.map((item) => (
        <button
          key={item.command}
          type="button"
          role="menuitem"
          className="row copy-menu-item"
          onClick={() => {
            onClose();
            onPick(item.command);
          }}
        >
          <span>{item.label}</span>
          <kbd>{item.shortcut}</kbd>
        </button>
      ))}
    </div>
  );
}
