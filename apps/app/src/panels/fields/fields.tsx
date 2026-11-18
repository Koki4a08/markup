import { useEffect, useId, useState, type ReactNode } from 'react';
import type { StyleValue } from '@markup/doc';

export const MIXED = Symbol('mixed');
export type FieldValue = StyleValue | undefined | typeof MIXED;

/** The shared value of a style across nodes, MIXED when they differ. */
export function common<T>(values: T[]): T | typeof MIXED | undefined {
  if (values.length === 0) return undefined;
  const first = values[0];
  return values.every((v) => v === first) ? first : MIXED;
}

const display = (v: FieldValue) => (v === MIXED || v === undefined ? '' : String(v).replace(/px$/, ''));

function Label({ label, children, hideLabel }: { label: string; children: (id: string) => ReactNode; hideLabel?: boolean }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'field-label'}>
        {label}
      </label>
      {children(id)}
    </div>
  );
}

interface TextProps {
  label: string;
  value: FieldValue;
  onCommit(value: string): void;
  /** Bare numbers get this unit on commit (px for lengths). */
  unit?: 'px' | '';
  placeholder?: string;
  hideLabel?: boolean;
}

/** Text input that commits on Enter or blur; ↑/↓ step numbers (Shift ×10). */
export function TextField({ label, value, onCommit, unit = '', placeholder, hideLabel }: TextProps) {
  const [draft, setDraft] = useState(display(value));
  useEffect(() => setDraft(display(value)), [value]);
  const commit = (raw: string) => {
    const v = raw.trim();
    if (v === display(value)) return;
    onCommit(unit && /^-?\d+(\.\d+)?$/.test(v) ? `${v}${unit}` : v);
  };
  return (
    <Label label={label} hideLabel={hideLabel}>
      {(id) => (
        <input
          id={id}
          className="field-input"
          value={draft}
          placeholder={value === MIXED ? 'Mixed' : placeholder}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(e.currentTarget.value);
            if (e.key === 'Escape') setDraft(display(value));
            if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && /^-?\d+(\.\d+)?$/.test(draft)) {
              e.preventDefault();
              const next = String(Number(draft) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
              setDraft(next);
              commit(next);
            }
          }}
        />
      )}
    </Label>
  );
}

export function SelectField({ label, value, options, onChange }: { label: string; value: FieldValue; options: [string, string][]; onChange(value: string): void }) {
  return (
    <Label label={label}>
      {(id) => (
        <select id={id} className="field-input" value={value === MIXED || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value)}>
          {(value === MIXED || value === undefined) && <option value="">{value === MIXED ? 'Mixed' : '—'}</option>}
          {options.map(([v, text]) => (
            <option key={v} value={v}>
              {text}
            </option>
          ))}
        </select>
      )}
    </Label>
  );
}

export function ColorField({ label, value, onCommit }: { label: string; value: FieldValue; onCommit(value: string): void }) {
  const swatch = value === MIXED || value === undefined ? 'transparent' : String(value);
  return (
    <div className="color-field">
      <span className="swatch" style={{ background: swatch }} aria-hidden />
      <TextField label={label} value={value} onCommit={onCommit} placeholder="none" />
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="inspector-section" aria-label={title}>
      <h3 className="section-title">{title}</h3>
      <div className="section-grid">{children}</div>
    </section>
  );
}
