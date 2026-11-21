import type { Styles, StyleValue } from '@markup/doc';

/**
 * Inspector writes must show whatever else the layer stores. A shorthand and its longhands override each other by
 * declaration order, and a captured page or an agent's HTML may store either: a written longhand (backgroundColor)
 * under a stored shorthand (background) would never show, and a written shorthand (gap) leaves stored longhands
 * (rowGap) winning. resolveConflicts rewrites one node's edit so the edited values are the ones drawn.
 */

const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
const CORNERS = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'];

export const SHORTHANDS: Record<string, string[]> = {
  background: ['backgroundColor', 'backgroundImage', 'backgroundPosition', 'backgroundSize', 'backgroundRepeat', 'backgroundOrigin', 'backgroundClip', 'backgroundAttachment'],
  font: ['fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily'],
  flex: ['flexGrow', 'flexShrink', 'flexBasis'],
  gap: ['rowGap', 'columnGap'],
  borderRadius: CORNERS.map((c) => `border${c}Radius`),
  padding: SIDES.map((s) => `padding${s}`),
  inset: SIDES.map((s) => s.toLowerCase()),
  overflow: ['overflowX', 'overflowY'],
  textDecoration: ['textDecorationLine', 'textDecorationStyle', 'textDecorationColor', 'textDecorationThickness'],
  flexFlow: ['flexDirection', 'flexWrap'],
  placeItems: ['alignItems', 'justifyItems'],
  placeContent: ['alignContent', 'justifyContent'],
};

const OWNER: Record<string, string> = Object.fromEntries(Object.entries(SHORTHANDS).flatMap(([short, longs]) => longs.map((l) => [l, short])));

/** Computed values a split shorthand need not spell out: each is what leaving the longhand out gives. */
const DEFAULTS: Record<string, string[]> = {
  backgroundColor: ['rgba(0, 0, 0, 0)', 'transparent'],
  backgroundImage: ['none'],
  backgroundPosition: ['0% 0%'],
  backgroundSize: ['auto', 'auto auto'],
  backgroundRepeat: ['repeat'],
  backgroundOrigin: ['padding-box'],
  backgroundClip: ['border-box'],
  backgroundAttachment: ['scroll'],
  fontVariant: ['normal'],
  fontStretch: ['normal', '100%'],
  textDecorationStyle: ['solid'],
  textDecorationThickness: ['auto'],
};

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * The edit for one node with its conflicts resolved:
 * - a written shorthand clears the node's stored longhands of it;
 * - a written longhand whose shorthand the node stores splits that shorthand into its longhands, each with the
 *   value the browser computes for it now (read from `computed`, the rendered layer), so nothing else changes.
 *   Without a rendered layer the shorthand stays and the longhand is written after it.
 */
export function resolveConflicts(stored: Styles, edit: Record<string, StyleValue | null>, computed?: CSSStyleDeclaration | null): Record<string, StyleValue | null> {
  const out: Record<string, StyleValue | null> = { ...edit };
  for (const [key, v] of Object.entries(edit)) {
    for (const long of SHORTHANDS[key] ?? []) if (stored[long] !== undefined && !(long in edit)) out[long] = null;
    const short = OWNER[key];
    if (v === null || !short || stored[short] === undefined || short in edit) continue;
    if (!computed) {
      // Not rendered (scrolled-out or still mounting): split the shorthands whose parts can be read off the text.
      const parts = splitPlain(short, String(stored[short]));
      if (!parts) continue;
      out[short] = null;
      for (const [long, value] of Object.entries(parts)) if (!(long in edit)) out[long] = value;
      continue;
    }
    out[short] = null;
    for (const long of SHORTHANDS[short]!) {
      if (long in edit) continue;
      const value = computed.getPropertyValue(kebab(long)).trim();
      // currentcolor computes to the colour itself; spelling that out would freeze it.
      if (long === 'textDecorationColor' && value === computed.getPropertyValue('color').trim()) continue;
      if (value && !DEFAULTS[long]?.includes(value)) out[long] = value;
    }
  }
  return out;
}

/** Box-like shorthands (1–4 values) and a background that is just a colour, split without a browser. */
function splitPlain(short: string, value: string): Record<string, string> | null {
  const v = value.trim();
  if (/[(/,]/.test(v.replace(/^(rgba?|hsla?|oklch|oklab|lab|lch|color|var)\([^()]*\)$/i, ''))) return null;
  const parts = v.split(/\s+/);
  const longs = SHORTHANDS[short]!;
  if (short === 'background') return parts.length === 1 && !/^(none|url)/i.test(v) ? { backgroundColor: v } : null;
  if (short === 'gap' || short === 'overflow') {
    if (parts.length > 2) return null;
    return { [longs[0]!]: parts[0]!, [longs[1]!]: parts[1] ?? parts[0]! };
  }
  if (short === 'padding' || short === 'borderRadius' || short === 'inset') {
    if (parts.length > 4) return null;
    const [t, r = t, b = t, l = r] = parts;
    return Object.fromEntries(longs.map((k, i) => [k, [t, r, b, l][i]!]));
  }
  return null;
}
