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

export function normalizeStyles(
  styles: Record<string, StyleValue | null>,
  ctx: { type: MarkupNode['type']; isArtboard: boolean },
): { styles: Record<string, StyleValue | null>; ignored: string[] } {
  const out: Record<string, StyleValue | null> = {};
  const ignored: string[] = [];
  for (const [rawKey, value] of Object.entries(styles)) {
    const key = camelCase(rawKey);
    const inert = value !== null && TEXT_ONLY.has(key) && ctx.type !== 'text';
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
