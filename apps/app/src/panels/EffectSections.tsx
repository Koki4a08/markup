import type { MarkupNode, StyleValue } from '@markup/doc';
import { icons } from './icons';
import { common, MIXED, Section, SelectField, type FieldValue } from './fields/fields';
import { ColorField, TextField } from './previewFields';
import {
  FILTER_DEFAULTS,
  NEW_SHADOW,
  OUTLINE_KEYS,
  parseBorder,
  parseFilters,
  parseOutline,
  parseShadows,
  SIDES,
  visibleSides,
  writeBorder,
  writeFilters,
  writeShadows,
  type FilterItem,
  type Shadow,
  type Side,
  type Stroke,
} from './effects';

type Set = (styles: Record<string, StyleValue | null>) => void;

interface Props {
  nodes: MarkupNode[];
  set: Set;
  resolve: (value: string) => string;
}

const STYLE_OPTIONS: [string, string][] = [
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
  ['double', 'Double'],
];

function HeadButton({ kind, label, onClick }: { kind: 'add' | 'remove'; label: string; onClick(): void }) {
  return (
    <button type="button" className="icon-button section-action" aria-label={label} data-tip={label} onClick={onClick}>
      {kind === 'add' ? icons.plus : icons.minus}
    </button>
  );
}

function RowRemove({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button type="button" className="icon-button effect-remove" aria-label={label} data-tip="Remove" onClick={onClick}>
      {icons.minus}
    </button>
  );
}

/** A value shared by every entry, MIXED when they differ; entries without one are skipped. */
const shared = (values: (string | undefined)[]): FieldValue => common(values.filter((v): v is string => v !== undefined));
const pick = <T,>(v: FieldValue, fallback: T): string | T => (v === MIXED || v === undefined ? fallback : String(v));

/* ───────────── Outline ───────────── */

export function OutlineSection({ nodes, set, resolve }: Props) {
  const parsed = nodes.map((n) => parseOutline(n.styles));
  const first = parsed.find(Boolean);
  const clear = Object.fromEntries(OUTLINE_KEYS.map((k) => [k, null]));
  if (!first) return <Section title="Outline" actions={<HeadButton kind="add" label="Add outline" onClick={() => set({ ...clear, outlineWidth: '1px', outlineStyle: 'solid', outlineColor: '#000000' })} />} />;
  const field = (k: 'width' | 'style' | 'color' | 'offset') => shared(parsed.map((p) => p?.[k]));
  const write = (patch: Partial<Stroke & { offset: string }>) => {
    const next = { width: pick(field('width'), first.width ?? '1px'), style: pick(field('style'), first.style ?? 'solid'), color: pick(field('color'), first.color ?? '#000000'), offset: pick(field('offset'), first.offset), ...patch };
    set({ ...clear, outlineWidth: next.width || null, outlineStyle: next.style || null, outlineColor: next.color || null, outlineOffset: next.offset || null });
  };
  return (
    <Section title="Outline" actions={<HeadButton kind="remove" label="Remove outline" onClick={() => set(clear)} />}>
      <ColorField label="Outline color" resolve={resolve} value={field('color')} onCommit={(v) => write({ color: v })} />
      <TextField label="Outline width" unit="px" prefix="W" value={field('width')} placeholder="1" onCommit={(v) => write({ width: v || '1px' })} />
      <SelectField label="Outline style" hideLabel value={field('style')} options={STYLE_OPTIONS} onChange={(v) => write({ style: v })} />
      <TextField label="Outline offset" unit="px" prefix="O" value={field('offset')} placeholder="0" onCommit={(v) => write({ offset: v })} />
    </Section>
  );
}

/* ───────────── Border ───────────── */

const SIDE_PRESETS: Record<string, Side[]> = { all: [...SIDES], Top: ['Top'], Right: ['Right'], Bottom: ['Bottom'], Left: ['Left'], vertical: ['Top', 'Bottom'], horizontal: ['Left', 'Right'] };
const SIDE_OPTIONS: [string, string][] = [
  ['all', 'All sides'],
  ['Top', 'Top'],
  ['Right', 'Right'],
  ['Bottom', 'Bottom'],
  ['Left', 'Left'],
  ['vertical', 'Top and bottom'],
  ['horizontal', 'Left and right'],
];

function presetOf(sides: Side[]): string {
  const key = sides.join(',');
  return Object.entries(SIDE_PRESETS).find(([, s]) => s.join(',') === key)?.[0] ?? 'custom';
}

export function BorderSection({ nodes, set, resolve }: Props) {
  const parsed = nodes.map((n) => parseBorder(n.styles));
  const drawn = parsed.map(visibleSides);
  const firstIndex = drawn.findIndex((d) => d.length > 0);
  if (firstIndex < 0) return <Section title="Border" actions={<HeadButton kind="add" label="Add border" onClick={() => set(writeBorder(Object.fromEntries(SIDES.map((s) => [s, { width: '1px', style: 'solid', color: '#000000' }]))))} />} />;
  const sides = parsed[firstIndex]!;
  const shown = drawn[firstIndex]!;
  const strokes = parsed.flatMap((p, i) => drawn[i]!.map((s) => p[s]));
  const field = (k: keyof Stroke) => shared(strokes.map((s) => s[k]));
  const preset = common(drawn.map(presetOf));
  // Writes keep each drawn side's own values, changing only what was edited.
  const write = (on: Side[], patch: Stroke = {}) => {
    const base = sides[shown[0]!];
    set(writeBorder(Object.fromEntries(on.map((s) => [s, { ...(shown.includes(s) ? sides[s] : base), ...patch }]))));
  };
  return (
    <Section title="Border" actions={<HeadButton kind="remove" label="Remove border" onClick={() => set(writeBorder({}))} />}>
      <ColorField label="Border color" resolve={resolve} value={field('color')} onCommit={(v) => write(shown, { color: v || '#000000' })} />
      <TextField label="Border width" unit="px" prefix="W" value={field('width')} placeholder="1" onCommit={(v) => write(shown, { width: v || '1px' })} />
      <SelectField label="Border style" hideLabel value={field('style')} options={STYLE_OPTIONS} onChange={(v) => write(shown, { style: v })} />
      <SelectField
        label="Border sides"
        hideLabel
        span={2}
        value={preset}
        options={preset === 'custom' ? [...SIDE_OPTIONS, ['custom', 'Custom']] : SIDE_OPTIONS}
        onChange={(v) => SIDE_PRESETS[v] && write(SIDE_PRESETS[v]!)}
      />
    </Section>
  );
}

/* ───────────── Shadows ───────────── */

/**
 * Shadows; on text layers (`text`) the shadow follows the glyphs (text-shadow), as a design tool's drop shadow on
 * text does, and has no spread.
 */
export function ShadowSection({ nodes, set, resolve, inset, text = false }: Props & { inset: boolean; text?: boolean }) {
  const title = inset ? 'Inner shadow' : 'Shadow';
  const prop = text ? 'textShadow' : 'boxShadow';
  const value = common(nodes.map((n) => n.styles[prop]));
  const all = value === MIXED ? null : parseShadows(value);
  const write = (list: Shadow[]) => set({ [prop]: writeShadows(list, text) });
  const fresh: Shadow = inset ? { ...NEW_SHADOW, inset: true, y: '2px', blur: '4px', color: 'rgba(0, 0, 0, 0.15)' } : NEW_SHADOW;
  const add = <HeadButton kind="add" label={`Add ${title.toLowerCase()}`} onClick={() => write([...(all ?? []), fresh])} />;
  if (!all) {
    return (
      <Section title={title} actions={add}>
        <p className="section-note is-wide">Layers have different shadows. Adding one replaces them.</p>
      </Section>
    );
  }
  const rows = all.map((s, i) => ({ s, i })).filter((r) => r.s.inset === inset);
  const edit = (i: number, patch: Partial<Shadow>) => write(all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <Section title={title} actions={add}>
      {rows.map(({ s, i }, k) => {
        const name = rows.length > 1 ? `${title} ${k + 1}` : title;
        return (
          <div className="effect-layer is-wide" key={i}>
            <div className="effect-head">
              <ColorField label={`${name} color`} resolve={resolve} value={s.color} onCommit={(v) => edit(i, { color: v || 'rgba(0, 0, 0, 0.25)' })} />
              <RowRemove label={`Remove ${name.toLowerCase()}`} onClick={() => write(all.filter((_, j) => j !== i))} />
            </div>
            <div className="effect-nums">
              <TextField label={`${name} X`} unit="px" prefix="X" value={s.x} placeholder="0" onCommit={(v) => edit(i, { x: v || '0px' })} />
              <TextField label={`${name} Y`} unit="px" prefix="Y" value={s.y} placeholder="0" onCommit={(v) => edit(i, { y: v || '0px' })} />
              <TextField label={`${name} blur`} unit="px" prefix="B" value={s.blur} placeholder="0" onCommit={(v) => edit(i, { blur: v || '0px' })} />
              {!text && <TextField label={`${name} spread`} unit="px" prefix="S" value={s.spread} placeholder="0" onCommit={(v) => edit(i, { spread: v || '0px' })} />}
            </div>
          </div>
        );
      })}
    </Section>
  );
}

/* ───────────── Filters ───────────── */

const FILTER_OPTIONS: [string, string][] = [
  ['blur', 'Layer blur'],
  ['backdrop:blur', 'Background blur'],
  ['brightness', 'Brightness'],
  ['contrast', 'Contrast'],
  ['saturate', 'Saturation'],
  ['grayscale', 'Grayscale'],
  ['hue-rotate', 'Hue rotate'],
  ['invert', 'Invert'],
  ['sepia', 'Sepia'],
  ['opacity', 'Opacity'],
  ['drop-shadow', 'Drop shadow'],
];

const kindOf = (f: FilterItem) => (f.prop === 'backdropFilter' ? `backdrop:${f.fn}` : f.fn);

export function FiltersSection({ nodes, set }: Omit<Props, 'resolve'>) {
  const value = common(nodes.map((n) => `${n.styles.filter ?? ''}|${n.styles.backdropFilter ?? ''}`));
  const list = value === MIXED ? null : parseFilters(nodes[0]!.styles);
  const write = (next: FilterItem[]) => set(writeFilters(next));
  const add = <HeadButton kind="add" label="Add filter" onClick={() => write([...(list ?? []), { prop: 'filter', fn: 'blur', arg: FILTER_DEFAULTS.blur! }])} />;
  if (!list) {
    return (
      <Section title="Filters" actions={add}>
        <p className="section-note is-wide">Layers have different filters. Adding one replaces them.</p>
      </Section>
    );
  }
  return (
    <Section title="Filters" actions={add}>
      {list.map((f, i) => {
        const kind = kindOf(f);
        const options = FILTER_OPTIONS.some(([k]) => k === kind) ? FILTER_OPTIONS : [...FILTER_OPTIONS, [kind, kind.replace('backdrop:', 'Background ')] as [string, string]];
        const edit = (patch: Partial<FilterItem>) => write(list.map((g, j) => (j === i ? { ...g, ...patch } : g)));
        return (
          <div className="filter-row is-wide" key={i}>
            <SelectField
              label={`Filter ${i + 1} type`}
              hideLabel
              value={kind}
              options={options}
              onChange={(v) => {
                const backdrop = v.startsWith('backdrop:');
                const fn = v.replace('backdrop:', '');
                edit({ prop: backdrop ? 'backdropFilter' : 'filter', fn, arg: fn === f.fn ? f.arg : (FILTER_DEFAULTS[fn] ?? f.arg) });
              }}
            />
            <TextField label={`Filter ${i + 1} amount`} hideLabel value={f.arg} placeholder={FILTER_DEFAULTS[f.fn]} unit={f.fn === 'blur' ? 'px' : f.fn === 'hue-rotate' ? 'deg' : ''} onCommit={(v) => edit({ arg: v || (FILTER_DEFAULTS[f.fn] ?? '0') })} />
            <RowRemove label={`Remove filter ${i + 1}`} onClick={() => write(list.filter((_, j) => j !== i))} />
          </div>
        );
      })}
    </Section>
  );
}
