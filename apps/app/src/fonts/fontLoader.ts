import googleFontsJson from './google-fonts.json';
import type { MarkupDoc } from '@markup/doc';
import type { LocalFont } from './localFonts';

export interface FontAxis {
  tag: string;
  min: number;
  max: number;
}
export interface GoogleFont {
  family: string;
  styles: { weight: number; italic: boolean }[];
  axes: FontAxis[];
}
export interface StyleGroup {
  italic: boolean;
  width: string;
  weights: number[];
  axes: FontAxis[];
}
export interface FamilyInfo {
  family: string;
  available: boolean;
  source: 'local' | 'google' | null;
  styleGroups: StyleGroup[];
}

const GOOGLE = googleFontsJson as GoogleFont[];
const byName = new Map(GOOGLE.map((f) => [f.family.toLowerCase(), f]));

export const googleFont = (family: string): GoogleFont | undefined => byName.get(family.trim().toLowerCase());

const WEIGHT_WORDS: [RegExp, number][] = [
  [/thin|hairline/, 100],
  [/extra\s*-?light|ultra\s*-?light/, 200],
  [/semi\s*-?bold|demi\s*-?bold/, 600],
  [/extra\s*-?bold|ultra\s*-?bold/, 800],
  [/light/, 300],
  [/medium/, 500],
  [/black|heavy/, 900],
  [/bold/, 700],
];
const WIDTH_WORDS: [RegExp, string][] = [
  [/ultra\s*-?condensed/, 'ultra-condensed'],
  [/extra\s*-?condensed/, 'extra-condensed'],
  [/semi\s*-?condensed/, 'semi-condensed'],
  [/condensed|narrow/, 'condensed'],
  [/semi\s*-?expanded/, 'semi-expanded'],
  [/extra\s*-?expanded/, 'extra-expanded'],
  [/expanded|wide/, 'expanded'],
];

function parseLocalStyle(style: string): { weight: number; italic: boolean; width: string } {
  const s = style.toLowerCase();
  return {
    weight: WEIGHT_WORDS.find(([re]) => re.test(s))?.[1] ?? 400,
    italic: /italic|oblique/.test(s),
    width: WIDTH_WORDS.find(([re]) => re.test(s))?.[1] ?? 'normal',
  };
}

function localInfo(family: string, faces: LocalFont[]): FamilyInfo {
  const groups = new Map<string, StyleGroup>();
  for (const face of faces) {
    const { weight, italic, width } = parseLocalStyle(face.style);
    const key = `${italic}|${width}`;
    const group = groups.get(key) ?? { italic, width, weights: [], axes: [] };
    if (!group.weights.includes(weight)) group.weights.push(weight);
    groups.set(key, group);
  }
  const styleGroups = [...groups.values()].map((g) => ({ ...g, weights: g.weights.sort((a, b) => a - b) }));
  styleGroups.sort((a, b) => Number(a.italic) - Number(b.italic) || a.width.localeCompare(b.width));
  return { family, available: true, source: 'local', styleGroups };
}

function googleInfo(font: GoogleFont): FamilyInfo {
  const styleGroups: StyleGroup[] = [];
  for (const italic of [false, true]) {
    const weights = font.styles.filter((s) => s.italic === italic).map((s) => s.weight);
    if (weights.length) styleGroups.push({ italic, width: 'normal', weights, axes: font.axes });
  }
  return { family: font.family, available: true, source: 'google', styleGroups };
}

/** What each requested family offers. A font installed on this machine wins over the Google catalog. */
export function familyInfo(names: string[], local: LocalFont[]): FamilyInfo[] {
  return names.map((name) => {
    const wanted = name.trim().toLowerCase();
    const faces = local.filter((f) => f.family.toLowerCase() === wanted);
    if (faces.length) return localInfo(faces[0]!.family, faces);
    const google = googleFont(name);
    return google ? googleInfo(google) : { family: name, available: false, source: null, styleGroups: [] };
  });
}

/** css2 axis tags must be sorted alphabetically, lowercase tags before uppercase ones. */
const compareTags = (a: string, b: string) => {
  const aUpper = a === a.toUpperCase();
  const bUpper = b === b.toUpperCase();
  return aUpper === bUpper ? (a < b ? -1 : a > b ? 1 : 0) : aUpper ? 1 : -1;
};

const range = (a: FontAxis) => (a.min === a.max ? `${a.min}` : `${a.min}..${a.max}`);

/** The Google Fonts css2 stylesheet URL asking for every weight and axis the family has. */
export function css2Url(font: GoogleFont): string {
  const name = encodeURIComponent(font.family).replace(/%20/g, '+');
  const hasItalic = font.styles.some((s) => s.italic);
  const axes = font.axes;
  let spec: string;
  if (axes.length) {
    const tags = [...(hasItalic ? ['ital'] : []), ...axes.map((a) => a.tag)].sort(compareTags);
    const tuple = (ital: 0 | 1) => tags.map((t) => (t === 'ital' ? `${ital}` : range(axes.find((a) => a.tag === t)!))).join(',');
    spec = `${tags.join(',')}@${hasItalic ? `${tuple(0)};${tuple(1)}` : tuple(0)}`;
  } else if (hasItalic) {
    const tuples = font.styles.map((s) => `${s.italic ? 1 : 0},${s.weight}`).sort((a, b) => (a < b ? -1 : 1));
    spec = `ital,wght@${tuples.join(';')}`;
  } else {
    const weights = [...new Set(font.styles.map((s) => s.weight))].sort((a, b) => a - b);
    spec = weights.length === 1 && weights[0] === 400 ? '' : `wght@${weights.join(';')}`;
  }
  return `https://fonts.googleapis.com/css2?family=${name}${spec ? `:${spec}` : ''}&display=swap`;
}

/** Each family's stylesheet link settling (load or error); a family is requested once per session. */
const requested = new Map<string, Promise<void>>();

/**
 * Adds one stylesheet link per Google family not installed locally; each family is requested once per session.
 * Resolves when the stylesheets of these families have loaded or failed (it may never, so callers cap the wait).
 */
export function ensureFontsLoaded(families: string[], local: LocalFont[] = []): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  const installed = new Set(local.map((f) => f.family.toLowerCase()));
  const waits: Promise<void>[] = [];
  for (const family of families) {
    const font = googleFont(family);
    if (!font || installed.has(font.family.toLowerCase())) continue;
    const known = requested.get(font.family);
    if (known) {
      waits.push(known);
      continue;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    // CORS mode, so html-to-image can read the rules when it inlines fonts into an export.
    link.crossOrigin = 'anonymous';
    const settled = new Promise<void>((resolve) => {
      link.addEventListener('load', () => resolve(), { once: true });
      link.addEventListener('error', () => resolve(), { once: true });
    });
    requested.set(font.family, settled);
    waits.push(settled);
    link.href = css2Url(font);
    document.head.appendChild(link);
  }
  return Promise.all(waits).then(() => undefined);
}

export interface UsedFont {
  family: string;
  weight: string;
  style: string;
}

const firstFamily = (stack: string) => stack.split(',')[0]!.trim().replace(/^["']|["']$/g, '');

/** Every family / weight / style used under the given nodes (inherited down the tree), deduped. */
export function fontFacesUsed(doc: MarkupDoc, rootIds: string[]): UsedFont[] {
  const out = new Map<string, UsedFont>();
  const seen = new Set<string>();
  const stack: { id: string; family?: string; weight: string; style: string }[] = rootIds.map((id) => ({ id, weight: '400', style: 'normal' }));
  while (stack.length) {
    const { id, ...inherited } = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = doc.getNode(id);
    if (!node) continue;
    const { fontFamily, fontWeight, fontStyle } = node.styles;
    const family = typeof fontFamily === 'string' && firstFamily(fontFamily) ? firstFamily(fontFamily) : inherited.family;
    const weight = typeof fontWeight === 'number' || typeof fontWeight === 'string' ? String(fontWeight) : inherited.weight;
    const style = typeof fontStyle === 'string' ? fontStyle : inherited.style;
    if (family && (fontFamily !== undefined || fontWeight !== undefined || fontStyle !== undefined)) out.set(`${family}|${weight}|${style}`, { family, weight, style });
    for (const child of node.children) stack.push({ id: child, family, weight, style });
  }
  return [...out.values()];
}

/** Test hook: forget which families were requested. */
export function resetLoadedFonts(): void {
  requested.clear();
}
