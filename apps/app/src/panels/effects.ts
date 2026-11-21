import type { Styles, StyleValue } from '@markup/doc';

/** Parsing and writing of the CSS behind the Outline, Border, Shadow and Filters sections. */

/** Splits on a separator outside parentheses and quotes. */
export function splitTopLevel(value: string, sep: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const LENGTH = /^-?(\d+\.?\d*|\.\d+)(px|em|rem|%|vw|vh|pt)?$/i;
const isLength = (t: string) => LENGTH.test(t) || /^(thin|medium|thick)$/i.test(t);
const BORDER_STYLES = ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double', 'groove', 'ridge', 'inset', 'outset'];
const isStyleWord = (t: string) => BORDER_STYLES.includes(t.toLowerCase());
const str = (v: StyleValue | undefined) => (v === undefined || v === null ? undefined : String(v));

/* ───────────── Stroke (border / outline) ───────────── */

export interface Stroke {
  width?: string;
  style?: string;
  color?: string;
}

/** `1px solid red` → its parts; order-free, like CSS. */
export function parseStrokeShorthand(value: string): Stroke {
  const out: Stroke = {};
  const color: string[] = [];
  for (const t of splitTopLevel(value, ' ')) {
    if (!out.width && isLength(t)) out.width = t;
    else if (!out.style && isStyleWord(t)) out.style = t.toLowerCase();
    else color.push(t);
  }
  if (color.length) out.color = color.join(' ');
  return out;
}

export const strokeShorthand = (s: Stroke) => [s.width ?? '1px', s.style ?? 'solid', s.color ?? '#000000'].join(' ');

const visible = (s: Stroke) => !!s.style && s.style !== 'none' && s.style !== 'hidden' && !/^0(px)?$/.test(s.width ?? '');

export const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;
export type Side = (typeof SIDES)[number];

/** 1–4 value box shorthand (`1px 2px`) → per side. */
function box(value: string): Record<Side, string> {
  const [t, r = t, b = t, l = r] = splitTopLevel(value, ' ') as [string, string?, string?, string?];
  return { Top: t, Right: r!, Bottom: b!, Left: l! };
}

/** Every key that can carry a border, radius excluded. */
export const BORDER_KEYS = ['border', 'borderWidth', 'borderStyle', 'borderColor', ...SIDES.flatMap((s) => [`border${s}`, `border${s}Width`, `border${s}Style`, `border${s}Color`])];

/** The effective border of each side, from shorthands up to longhands (more specific wins). */
export function parseBorder(styles: Styles): Record<Side, Stroke> {
  const sides = Object.fromEntries(SIDES.map((s) => [s, {} as Stroke])) as Record<Side, Stroke>;
  const all = str(styles.border);
  if (all) for (const s of SIDES) Object.assign(sides[s], parseStrokeShorthand(all));
  for (const [key, part] of [['borderWidth', 'width'], ['borderStyle', 'style'], ['borderColor', 'color']] as const) {
    const v = str(styles[key]);
    if (v) {
      const per = box(v);
      for (const s of SIDES) sides[s][part] = per[s];
    }
  }
  for (const s of SIDES) {
    const v = str(styles[`border${s}`]);
    if (v) sides[s] = { ...sides[s], ...parseStrokeShorthand(v) };
    for (const part of ['Width', 'Style', 'Color'] as const) {
      const p = str(styles[`border${s}${part}`]);
      if (p) sides[s][part.toLowerCase() as keyof Stroke] = p;
    }
  }
  return sides;
}

export const visibleSides = (sides: Record<Side, Stroke>): Side[] => SIDES.filter((s) => visible(sides[s]));

/** Styles that draw exactly these sides; one `border` shorthand when all four match. */
export function writeBorder(sides: Partial<Record<Side, Stroke>>): Record<string, StyleValue | null> {
  const out: Record<string, StyleValue | null> = Object.fromEntries(BORDER_KEYS.map((k) => [k, null]));
  const drawn = SIDES.filter((s) => sides[s]);
  const lines = drawn.map((s) => strokeShorthand(sides[s]!));
  if (drawn.length === 4 && lines.every((l) => l === lines[0])) out.border = lines[0]!;
  else drawn.forEach((s, i) => (out[`border${s}`] = lines[i]!));
  return out;
}

export const OUTLINE_KEYS = ['outline', 'outlineWidth', 'outlineStyle', 'outlineColor', 'outlineOffset'];

export function parseOutline(styles: Styles): (Stroke & { offset?: string }) | null {
  const s: Stroke & { offset?: string } = str(styles.outline) ? parseStrokeShorthand(str(styles.outline)!) : {};
  if (str(styles.outlineWidth)) s.width = str(styles.outlineWidth);
  if (str(styles.outlineStyle)) s.style = str(styles.outlineStyle);
  if (str(styles.outlineColor)) s.color = str(styles.outlineColor);
  if (str(styles.outlineOffset)) s.offset = str(styles.outlineOffset);
  return visible(s) ? s : null;
}

/* ───────────── Shadows ───────────── */

export interface Shadow {
  inset: boolean;
  x: string;
  y: string;
  blur: string;
  spread: string;
  color: string;
}

export const NEW_SHADOW: Shadow = { inset: false, x: '0px', y: '4px', blur: '12px', spread: '0px', color: 'rgba(0, 0, 0, 0.25)' };

export function parseShadows(value: StyleValue | undefined): Shadow[] {
  const v = str(value)?.trim();
  if (!v || v === 'none') return [];
  return splitTopLevel(v, ',').map((part) => {
    const lengths: string[] = [];
    const color: string[] = [];
    let inset = false;
    for (const t of splitTopLevel(part, ' ')) {
      if (t.toLowerCase() === 'inset') inset = true;
      else if (LENGTH.test(t)) lengths.push(t);
      else color.push(t);
    }
    const [x = '0px', y = '0px', blur = '0px', spread = '0px'] = lengths;
    return { inset, x, y, blur, spread, color: color.join(' ') || 'currentColor' };
  });
}

/** box-shadow, or with `text` a text-shadow (no inset or spread: either would make the browser drop it). */
export function writeShadows(list: Shadow[], text = false): StyleValue | null {
  if (!list.length) return null;
  if (text) return list.map((s) => `${s.x} ${s.y} ${s.blur} ${s.color}`).join(', ');
  return list.map((s) => `${s.inset ? 'inset ' : ''}${s.x} ${s.y} ${s.blur} ${s.spread} ${s.color}`).join(', ');
}

/* ───────────── Filters ───────────── */

export type FilterProp = 'filter' | 'backdropFilter';

export interface FilterItem {
  prop: FilterProp;
  fn: string;
  arg: string;
}

export const FILTER_DEFAULTS: Record<string, string> = {
  blur: '4px',
  brightness: '100%',
  contrast: '100%',
  grayscale: '100%',
  'hue-rotate': '90deg',
  invert: '100%',
  opacity: '100%',
  saturate: '150%',
  sepia: '100%',
  'drop-shadow': '0px 4px 8px rgba(0, 0, 0, 0.25)',
};

export function parseFilters(styles: Styles): FilterItem[] {
  const out: FilterItem[] = [];
  for (const prop of ['filter', 'backdropFilter'] as const) {
    const v = str(styles[prop]);
    if (!v || v.trim() === 'none') continue;
    for (const m of v.matchAll(/([a-z-]+)\(((?:[^()]|\([^()]*\))*)\)/gi)) out.push({ prop, fn: m[1]!.toLowerCase(), arg: m[2]!.trim() });
  }
  return out;
}

export function writeFilters(list: FilterItem[]): Record<FilterProp, StyleValue | null> {
  const join = (prop: FilterProp) => {
    const items = list.filter((f) => f.prop === prop);
    return items.length ? items.map((f) => `${f.fn}(${f.arg})`).join(' ') : null;
  };
  return { filter: join('filter'), backdropFilter: join('backdropFilter') };
}
