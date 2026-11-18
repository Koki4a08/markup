/** Computed style → Markup dialect declarations. Pure: reads only through CSSStyleDeclaration.getPropertyValue. */

export type Decl = [prop: string, value: string];

export const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);
/** Values the paste side would drop, or that could smuggle in CSS escapes. */
const UNSAFE_VALUE = /\\|javascript:|vbscript:|expression\(|-moz-binding|behavior\s*:|@import|image-set\(|[<>{}]/i;
const SAFE_URL = /^(https?:|data:image\/(png|jpe?g|gif|webp|avif)[;,])/i;

export const get = (cs: CSSStyleDeclaration, prop: string): string => (cs.getPropertyValue(prop) || '').trim();
export const num = (v: string): number => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};
export const px = (n: number): string => `${round(n)}px`;
/** Width for a text layer: rounded up so re-rendered text never wraps earlier than on the page. */
export const textWidth = (n: number): string => `${Math.ceil(round(n))}px`;

export const isTransparent = (color: string): boolean =>
  !color || color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color) || /\/\s*0\)$/.test(color);

export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const padding = (cs: CSSStyleDeclaration): Edges =>
  Object.fromEntries(SIDES.map((s) => [s, num(get(cs, `padding-${s}`))])) as unknown as Edges;

export const borders = (cs: CSSStyleDeclaration): Edges =>
  Object.fromEntries(SIDES.map((s) => [s, borderVisible(cs, s) ? num(get(cs, `border-${s}-width`)) : 0])) as unknown as Edges;

const borderVisible = (cs: CSSStyleDeclaration, side: string) => {
  const style = get(cs, `border-${side}-style`);
  return num(get(cs, `border-${side}-width`)) > 0 && style !== 'none' && style !== 'hidden' && style !== '';
};

export const hasPadding = (cs: CSSStyleDeclaration): boolean => Object.values(padding(cs)).some((v) => v > 0);

/** Whether the element paints a box of its own (so it must stay a frame, not collapse into a text layer). */
export function isBoxy(cs: CSSStyleDeclaration): boolean {
  if (!isTransparent(get(cs, 'background-color'))) return true;
  const bg = get(cs, 'background-image');
  if (bg && bg !== 'none') return true;
  if (SIDES.some((s) => borderVisible(cs, s))) return true;
  const shadow = get(cs, 'box-shadow');
  if (shadow && shadow !== 'none') return true;
  const backdrop = get(cs, 'backdrop-filter');
  return !!backdrop && backdrop !== 'none';
}

export const clips = (cs: CSSStyleDeclaration): boolean =>
  ['overflow-x', 'overflow-y'].some((p) => /^(hidden|clip|auto|scroll)$/.test(get(cs, p)));

/** Rotation in degrees from the computed transform matrix; scale and skew are not carried over. */
export function rotation(cs: CSSStyleDeclaration): number {
  const m = /^matrix\(([^)]+)\)$/.exec(get(cs, 'transform'));
  if (!m) return 0;
  const [a = 1, b = 0] = m[1]!.split(',').map((s) => parseFloat(s));
  const deg = round((Math.atan2(b, a) * 180) / Math.PI);
  return Math.abs(deg) < 0.01 ? 0 : deg;
}

/** Box decoration a frame (or image) keeps: fills, borders, corners, shadows, effects. Background images are async (images.ts). */
export function boxDecls(cs: CSSStyleDeclaration): Decl[] {
  const out: Decl[] = [];
  const bg = get(cs, 'background-color');
  if (!isTransparent(bg)) out.push(['background-color', bg]);
  for (const s of SIDES) {
    if (borderVisible(cs, s)) out.push([`border-${s}`, `${get(cs, `border-${s}-width`)} ${get(cs, `border-${s}-style`)} ${get(cs, `border-${s}-color`)}`]);
  }
  for (const c of CORNERS) {
    const r = get(cs, `border-${c}-radius`);
    if (r && !/^0(px)?( 0(px)?)?$/.test(r)) out.push([`border-${c}-radius`, r]);
  }
  for (const p of ['box-shadow', 'filter', 'backdrop-filter']) {
    const v = get(cs, p);
    if (v && v !== 'none' && !/url\(/i.test(v)) out.push([p, v]);
  }
  const opacity = get(cs, 'opacity');
  if (opacity && num(opacity) < 1) out.push(['opacity', opacity]);
  const blend = get(cs, 'mix-blend-mode');
  if (blend && blend !== 'normal') out.push(['mix-blend-mode', blend]);
  if (clips(cs)) out.push(['overflow', 'hidden']);
  const deg = rotation(cs);
  if (deg) out.push(['transform', `rotate(${deg}deg)`]);
  return out;
}

/** First font family; named families are quoted with plain quotes, generic keywords stay bare. */
/** Splits a computed font-family list on top-level commas (quoted names may contain commas). */
function splitFamilies(value: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.replace(/\\/g, '').trim()).filter(Boolean);
}

/**
 * The whole font stack, so a family missing on the viewer's machine (e.g. -apple-system on Windows) falls back
 * the way the page does. Generic and single-identifier names stay bare; others get plain single quotes (the app's
 * paste sanitiser drops any declaration with a backslash).
 */
export function fontStack(value: string): string {
  return splitFamilies(value)
    .filter((f) => !f.includes("'"))
    .map((f) => (GENERIC_FAMILIES.has(f.toLowerCase()) || /^-?[a-zA-Z_][\w-]*$/.test(f) ? f : `'${f}'`))
    .join(', ');
}

const TEXT_ALIGN: Record<string, string> = { left: 'left', right: 'right', center: 'center', justify: 'justify', end: 'right', '-webkit-center': 'center', '-webkit-right': 'right' };

/** Typography for a text layer. */
export function textDecls(cs: CSSStyleDeclaration): Decl[] {
  const out: Decl[] = [];
  const add = (prop: string, value: string, skip: string[] = []) => {
    if (value && !skip.includes(value)) out.push([prop, value]);
  };
  add('color', get(cs, 'color'));
  add('font-family', fontStack(get(cs, 'font-family')));
  add('font-size', get(cs, 'font-size'));
  add('font-weight', get(cs, 'font-weight'));
  add('font-style', get(cs, 'font-style'), ['normal']);
  add('line-height', get(cs, 'line-height'), ['normal']);
  add('letter-spacing', get(cs, 'letter-spacing'), ['normal', '0px']);
  add('text-align', TEXT_ALIGN[get(cs, 'text-align')] ?? '');
  add('text-transform', get(cs, 'text-transform'), ['none']);
  add('text-decoration', decorationLine(cs), ['none']);
  add('white-space', get(cs, 'white-space'), ['normal']);
  add('font-feature-settings', get(cs, 'font-feature-settings'), ['normal']);
  add('font-variation-settings', get(cs, 'font-variation-settings'), ['normal']);
  return out;
}

const decorationLine = (cs: CSSStyleDeclaration) => get(cs, 'text-decoration-line') || (get(cs, 'text-decoration').split(' ')[0] ?? '');

/** Formatting an inline span keeps inside a text layer: whatever differs from the text layer itself. */
export function inlineDecls(cs: CSSStyleDeclaration, base: CSSStyleDeclaration): Decl[] {
  const out: Decl[] = [];
  for (const p of ['color', 'font-weight', 'font-style']) {
    const v = get(cs, p);
    if (v && v !== get(base, p)) out.push([p, v]);
  }
  const line = decorationLine(cs);
  if (line && line !== 'none' && line !== decorationLine(base)) out.push(['text-decoration', line]);
  return out;
}

/** Flex container properties Markup keeps, including padding. */
export function flexDecls(cs: CSSStyleDeclaration): Decl[] {
  const out: Decl[] = [['display', 'flex'], ['flex-direction', get(cs, 'flex-direction') || 'row']];
  const wrap = get(cs, 'flex-wrap');
  if (wrap && wrap !== 'nowrap') out.push(['flex-wrap', wrap]);
  const gap = (p: string) => (/^(normal|)$/.test(get(cs, p)) ? '0px' : get(cs, p));
  const row = gap('row-gap');
  const col = gap('column-gap');
  if (row === col) {
    if (row !== '0px') out.push(['gap', row]);
  } else out.push(['row-gap', row], ['column-gap', col]);
  for (const p of ['align-items', 'justify-content', 'align-content']) {
    const v = get(cs, p);
    if (v && v !== 'normal') out.push([p, v]);
  }
  out.push(...paddingDecls(cs));
  return out;
}

export const paddingDecls = (cs: CSSStyleDeclaration): Decl[] =>
  SIDES.filter((s) => num(get(cs, `padding-${s}`)) > 0).map((s) => [`padding-${s}`, get(cs, `padding-${s}`)] as Decl);

/** A style attribute value; declarations the paste sanitiser would reject are dropped here already. */
export function styleAttr(decls: Decl[]): string {
  return decls
    .filter(([, v]) => {
      if (!v || UNSAFE_VALUE.test(v)) return false;
      for (const m of v.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) if (!SAFE_URL.test(m[2]!)) return false;
      return true;
    })
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}
