import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { isFreshFocus, keepEditingAcrossWindowBlur } from './windowFocus';

/**
 * A name that turns into a text field on double-click (or Enter/F2 when focused). Enter or blur saves,
 * Escape cancels; switching to another app leaves the field open. Keys typed while renaming never reach the canvas shortcuts.
 */
export function InlineRename({
  value,
  onCommit,
  className = '',
  label = 'Name',
  disabled,
  onPointerDown,
  tip,
}: {
  value: string;
  onCommit(name: string): void;
  className?: string;
  label?: string;
  disabled?: boolean;
  /** Tooltip on the resting name. */
  tip?: string;
  onPointerDown?(e: ReactPointerEvent<HTMLSpanElement>): void;
}) {
  const [editing, setEditing] = useState(false);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    setEditing(false);
    const name = next?.trim();
    if (name && name !== value) onCommit(name);
  };
  if (editing && !disabled) {
    return (
      <input
        className={`inline-rename ${className}`}
        aria-label={label}
        defaultValue={value}
        autoFocus
        spellCheck={false}
        onFocus={(e) => isFreshFocus(e.currentTarget) && e.currentTarget.select()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(e.currentTarget.value);
          if (e.key === 'Escape') finish(null);
        }}
        onBlur={(e) => keepEditingAcrossWindowBlur(e.currentTarget) || finish(e.currentTarget.value)}
      />
    );
  }
  return (
    <span className={className} data-tip={disabled ? undefined : tip} onPointerDown={onPointerDown} onDoubleClick={() => {
        if (disabled) return;
        done.current = false;
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}
