import type { MarkupNode, StyleValue } from './schema';

/** Text-only properties: inert on anything but a Text node. */
const TEXT_ONLY = new Set([
  'fontSize',
  'fontFamily',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'textAlign',
  'textTransform',
  'textDecoration',
  'color',
]);

/** display values outside Markup's layout dialect (flex, absolute, simple block). */
const BANNED_DISPLAY = /^(inline|inline-block|grid|inline-grid|contents|table.*|inline-table)$/;

export function camelCase(key: string): string {
  if (key.startsWith('--')) return key;
  return key.trim().replace(/^-ms-/, 'ms-').replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function isBanned(key: string, value: StyleValue | null): boolean {
  if (/^margin/.test(key)) return true;
  if (/^grid/.test(key)) return true;
  if (key === 'display' && typeof value === 'string' && BANNED_DISPLAY.test(value.trim())) return true;
  return false;
}

/**
 * `strict` is Markup's layout dialect (flex, absolute, simple block); `any` keeps whatever CSS the HTML carries
 * (margins, grid, inline and table display, inherited text properties on frames), for exact page snapshots.
 */
export type Dialect = 'strict' | 'any';

export function normalizeStyles(
  styles: Record<string, StyleValue | null>,
  ctx: { type: MarkupNode['type']; isArtboard: boolean },
  dialect: Dialect = 'strict',
): { styles: Record<string, StyleValue | null>; ignored: string[] } {
  const out: Record<string, StyleValue | null> = {};
  const ignored: string[] = [];
  for (const [rawKey, value] of Object.entries(styles)) {
    const key = camelCase(rawKey);
    if (dialect === 'any') {
      out[key] = typeof value === 'string' ? value.trim() : value;
      continue;
    }
    // An SVG layer's color is the currentColor its drawing (an icon's stroke or fill) paints with.
    const inert = value !== null && TEXT_ONLY.has(key) && ctx.type !== 'text' && !(key === 'color' && ctx.type === 'svg');
    if ((value !== null && isBanned(key, value)) || inert) ignored.push(key);
    else out[key] = typeof value === 'string' ? value.trim() : value;
  }
  return { styles: out, ignored };
}

/** Parses an inline style attribute; semicolons inside parentheses or quotes do not split. */
export function parseStyleAttr(attr: string): Record<string, string> {
  const out: Record<string, string> = {};
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  const flush = (end: number) => {
    const decl = attr.slice(start, end);
    const colon = decl.indexOf(':');
    if (colon > 0) {
      const key = decl.slice(0, colon).trim();
      const value = decl.slice(colon + 1).trim();
      if (key && value) out[camelCase(key.toLowerCase().startsWith('--') ? key : key.toLowerCase())] = value;
    }
    start = end + 1;
  };
  for (let i = 0; i < attr.length; i++) {
    const ch = attr[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) flush(i);
  }
  flush(attr.length);
  return out;
}

const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
const sides = (f: (side: string) => string) => SIDES.map(f);

/** CSS shorthands and the longhands each one sets. */
export const SHORTHAND_LONGHANDS: Record<string, string[]> = {
  background: ['backgroundColor', 'backgroundImage', 'backgroundPosition', 'backgroundSize', 'backgroundRepeat', 'backgroundOrigin', 'backgroundClip', 'backgroundAttachment'],
  font: ['fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily'],
  flex: ['flexGrow', 'flexShrink', 'flexBasis'],
  gap: ['rowGap', 'columnGap'],
  borderRadius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'],
  padding: sides((s) => `padding${s}`),
  margin: sides((s) => `margin${s}`),
  inset: sides((s) => s.toLowerCase()),
  overflow: ['overflowX', 'overflowY'],
  textDecoration: ['textDecorationLine', 'textDecorationStyle', 'textDecorationColor', 'textDecorationThickness'],
  flexFlow: ['flexDirection', 'flexWrap'],
  placeItems: ['alignItems', 'justifyItems'],
  placeContent: ['alignContent', 'justifyContent'],
  placeSelf: ['alignSelf', 'justifySelf'],
  outline: ['outlineWidth', 'outlineStyle', 'outlineColor'],
  listStyle: ['listStyleType', 'listStylePosition', 'listStyleImage'],
  border: ['borderWidth', 'borderStyle', 'borderColor', ...sides((s) => `border${s}`), ...SIDES.flatMap((s) => ['Width', 'Style', 'Color'].map((p) => `border${s}${p}`))],
  ...Object.fromEntries(SIDES.map((s) => [`border${s}`, ['Width', 'Style', 'Color'].map((p) => `border${s}${p}`)])),
  ...Object.fromEntries(['Width', 'Style', 'Color'].map((p) => [`border${p}`, sides((s) => `border${s}${p}`)])),
};

/**
 * A written shorthand replaces what its longhands said, as it would in a stylesheet: the node's stored longhands
 * that the same edit does not set are cleared (null), so the newest value is the one drawn.
 */
export function clearShadowedLonghands(stored: (key: string) => boolean, edit: Record<string, unknown>): Record<string, null> {
  const out: Record<string, null> = {};
  for (const [key, value] of Object.entries(edit)) {
    if (value === null || value === '') continue;
    for (const long of SHORTHAND_LONGHANDS[key] ?? []) if (!(long in edit) && stored(long)) out[long] = null;
  }
  return out;
}

/** Shorthands, outermost first. */
const SHORTHAND_RANK: Record<string, number> = Object.fromEntries([
  ...['background', 'font', 'flex', 'gap', 'borderRadius', 'padding', 'margin', 'inset', 'overflow', 'textDecoration', 'flexFlow', 'placeItems', 'placeContent', 'placeSelf', 'border', 'outline', 'mask', 'listStyle', 'columns', 'transition', 'animation', 'gridArea', 'gridTemplate'].map((k) => [k, 0]),
  ...['borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderWidth', 'borderStyle', 'borderColor', 'gridRow', 'gridColumn'].map((k) => [k, 1]),
]);
const rank = (k: string) => SHORTHAND_RANK[k] ?? 2;

/** True for a CSS shorthand Markup orders before its longhands (background, gap, border…). */
export const isShorthandStyle = (key: string) => key in SHORTHAND_RANK || key in SHORTHAND_LONGHANDS;

/**
 * Styles with every shorthand before its longhands. Stored order is edit order, so a shorthand written after one of
 * its longhands (background after backgroundColor) would otherwise hide it wherever the styles are rendered or
 * exported; CSS authors write the shorthand first, and so does every reader of a node.
 */
export function orderStyles<T extends Record<string, unknown>>(styles: T): T {
  const keys = Object.keys(styles);
  if (keys.every((k, i) => i === 0 || rank(keys[i - 1]!) <= rank(k))) return styles;
  return Object.fromEntries(Object.entries(styles).sort(([a], [b]) => rank(a) - rank(b))) as T;
}
