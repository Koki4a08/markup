import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { StyleValue } from '@markup/doc';
import { endPreview } from '../../canvas/preview';
import { SegmentThumb } from '../../ui/SegmentThumb';
import { ColorPicker } from '../ColorPicker';

export const MIXED = Symbol('mixed');
export type FieldValue = StyleValue | undefined | typeof MIXED;

/** The shared value of a style across nodes, MIXED when they differ. */
export function common<T>(values: T[]): T | typeof MIXED | undefined {
  if (values.length === 0) return undefined;
  const first = values[0];
  return values.every((v) => v === first) ? first : MIXED;
}

const display = (v: FieldValue) => (v === MIXED || v === undefined ? '' : String(v).replace(/px$/, ''));
const NUMBER = /^-?\d+(\.\d+)?$/;

function Label({ label, children, hideLabel, className = '' }: { label: string; children: (id: string) => ReactNode; hideLabel?: boolean; className?: string }) {
  const id = useId();
  return (
    <div className={`field ${className}`}>
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
  unit?: 'px' | 'deg' | '';
  placeholder?: string;
  hideLabel?: boolean;
  /**
   * Short glyph or letter drawn inside the input, in place of the visible label. Dragging it sideways
   * scrubs a numeric value (Shift for steps of 10), like a design tool's number field.
   */
  prefix?: ReactNode;
  /** Number of the section grid's two columns this field spans. */
  span?: 1 | 2;
  /** Step for arrow keys and scrubbing; decimals allowed (opacity uses 0.01). */
  step?: number;
  /**
   * Shows a value on the canvas while it is typed or scrubbed, before it is committed. Escape (or
   * leaving the value unchanged) ends the preview and restores the node.
   */
  onPreview?(value: string): void;
}

/** Text input that commits on Enter or blur; ↑/↓ step numbers (Shift ×10). */
export function TextField({ label, value, onCommit, unit = '', placeholder, hideLabel, prefix, span, step = 1, onPreview }: TextProps) {
  const [draft, setDraft] = useState(display(value));
  const scrub = useRef<{ x: number; start: number; moved: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(display(value)), [value]);
  const withUnit = (v: string) => (unit && NUMBER.test(v) ? `${v}${unit}` : v);
  const commit = (raw: string) => {
    const v = raw.trim();
    if (onPreview) endPreview();
    if (v === display(value)) return;
    onCommit(withUnit(v));
  };
  const preview = (raw: string) => {
    const v = raw.trim();
    if (!onPreview) return;
    if (!v || v === display(value)) endPreview();
    else onPreview(withUnit(v));
  };
  const decimals = String(step).split('.')[1]?.length ?? 0;
  const nudge = (base: number, by: number) => String(Number((base + by).toFixed(decimals)));
  const numeric = NUMBER.test(draft) || (draft === '' && (placeholder === undefined || NUMBER.test(placeholder)));
  const base = () => (NUMBER.test(draft) ? Number(draft) : NUMBER.test(placeholder ?? '') ? Number(placeholder) : 0);

  return (
    <Label label={label} hideLabel={hideLabel || !!prefix} className={span === 2 ? 'is-wide' : ''}>
      {(id) => (
        <div className={`input-wrap ${prefix ? 'has-prefix' : ''}`}>
          {prefix && (
            <span
              className={`field-prefix ${numeric ? 'is-scrubbable' : ''}`}
              aria-hidden
              data-tip={numeric ? `${label}: drag to change` : label}
              onPointerDown={(e) => {
                if (!numeric || e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                scrub.current = { x: e.clientX, start: base(), moved: false };
              }}
              onPointerMove={(e) => {
                const s = scrub.current;
                if (!s) return;
                const steps = Math.trunc((e.clientX - s.x) / 2);
                if (!steps && !s.moved) return;
                s.moved = true;
                const next = nudge(s.start, steps * step * (e.shiftKey ? 10 : 1));
                setDraft(next);
                preview(next);
              }}
              onPointerUp={() => {
                const s = scrub.current;
                scrub.current = null;
                if (s?.moved) commit(inputRef.current?.value ?? draft);
                else inputRef.current?.focus();
              }}
              onPointerCancel={() => {
                scrub.current = null;
                setDraft(display(value));
                if (onPreview) endPreview();
              }}
            >
              {prefix}
            </span>
          )}
          <input
            id={id}
            ref={inputRef}
            className="field-input"
            value={draft}
            placeholder={value === MIXED ? 'Mixed' : placeholder}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              preview(e.target.value);
            }}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value);
              if (e.key === 'Escape') {
                setDraft(display(value));
                if (onPreview) endPreview();
              }
              if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && NUMBER.test(draft)) {
                e.preventDefault();
                const next = nudge(Number(draft), (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1));
                setDraft(next);
                commit(next);
              }
            }}
          />
        </div>
      )}
    </Label>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  hideLabel,
  span,
}: {
  label: string;
  value: FieldValue;
  options: [string, string][];
  onChange(value: string): void;
  hideLabel?: boolean;
  span?: 1 | 2;
}) {
  return (
    <Label label={label} hideLabel={hideLabel} className={span === 2 ? 'is-wide' : ''}>
      {(id) => (
        <select id={id} className="field-input" value={value === MIXED || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value)}>
          {(value === MIXED || value === undefined) && <option value="">{value === MIXED ? 'Mixed' : '-'}</option>}
          {/* A stored value the list does not name still shows as itself, not as the first option. */}
          {value !== MIXED && value !== undefined && !options.some(([v]) => v === String(value)) && <option value={String(value)}>{String(value)}</option>}
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

export interface SegmentOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

/** A row of mutually exclusive buttons (radio group); icon-only segments name themselves in a tooltip. */
export function SegmentedField({ label, value, options, onChange, span = 2 }: { label: string; value: FieldValue; options: SegmentOption[]; onChange(value: string): void; span?: 1 | 2 }) {
  return (
    <div className={`segmented is-field ${span === 2 ? 'is-wide' : ''}`} role="radiogroup" aria-label={label}>
      <SegmentThumb />
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.icon ? o.label : undefined}
            data-tip={o.icon ? o.label : undefined}
            className={`segment ${on ? 'is-active' : ''} ${o.icon ? 'is-icon' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.icon ?? o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Colour value with a swatch that opens the colour picker; the text field takes any CSS colour. */
export function ColorField({
  label,
  value,
  onCommit,
  onPreview,
  span = 2,
  resolve,
  placeholder = 'None',
  fallback,
}: {
  label: string;
  value: FieldValue;
  onCommit(value: string): void;
  onPreview?(value: string): void;
  span?: 1 | 2;
  resolve?: (value: string) => string;
  placeholder?: string;
  /** The colour shown (and picked from) while the value is unset, when unset still paints something. */
  fallback?: string;
}) {
  // A token reference (var(--brand)) shows the colour it resolves to.
  const unset = value === MIXED || value === undefined || value === '';
  const swatch = unset ? fallback || 'transparent' : (resolve?.(String(value)) ?? String(value));
  const empty = swatch === 'transparent';
  const [picking, setPicking] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className={`color-field ${span === 2 ? 'is-wide' : ''}`}>
      <button
        ref={button}
        type="button"
        className={`swatch ${empty && !picking ? 'is-empty' : ''} ${open ? 'is-open' : ''}`}
        aria-label={`${label} picker`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={open ? undefined : 'Pick a colour'}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="swatch-fill" style={{ background: picking ?? swatch }} />
      </button>
      {open && button.current && (
        <ColorPicker
          anchor={button.current}
          label={label}
          value={empty ? null : swatch}
          onPreview={(v) => {
            setPicking(v);
            onPreview?.(v);
          }}
          onCommit={(v) => {
            endPreview();
            setPicking(null);
            onCommit(v);
          }}
          onClose={() => {
            endPreview();
            setPicking(null);
            setOpen(false);
          }}
        />
      )}
      <TextField label={label} value={value} onCommit={onCommit} onPreview={onPreview} placeholder={placeholder} hideLabel />
    </div>
  );
}

/** An inspector section; without children it collapses to its header, like an empty Figma section with its + button. */
export function Section({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  const empty = children === undefined || children === null || children === false || (Array.isArray(children) && children.every((c) => c === null || c === false || c === undefined));
  return (
    <section className={`inspector-section ${empty ? 'is-collapsed' : ''}`} aria-label={title}>
      <div className="section-head">
        <h3 className="section-title">{title}</h3>
        {actions}
      </div>
      {!empty && <div className="section-grid">{children}</div>}
    </section>
  );
}
