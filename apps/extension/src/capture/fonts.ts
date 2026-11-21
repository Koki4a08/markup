/**
 * The page's web fonts, carried with a capture so text lays out with the same glyphs and metrics in Markup.
 * Only the faces a capture can show are taken: families named in its font stacks, and of those only the
 * unicode-range subsets that cover characters in its text. Each file is inlined as a data URL.
 */

/** Total base64 budget for embedded fonts; past it, faces are dropped from the least needed family down. */
export const FONT_BUDGET = 6_000_000;
/** One face larger than this (base64) is left out: icon fonts and CJK families can be several megabytes. */
const MAX_FACE = 2_500_000;

export interface FontFaceRule {
  family: string;
  /** The url() sources in preference order (woff2 first), resolved against the sheet. */
  urls: string[];
  /** Descriptors other than family and src, as written (weight, style, stretch, unicode-range, overrides…). */
  descriptors: Record<string, string>;
}

const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim();

/** Font family names in a font-family list, generic families left out. */
export function familiesIn(stack: string): string[] {
  const GENERIC = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|emoji|math|fangsong|inherit|initial|unset|revert|-apple-system|blinkmacsystemfont)$/i;
  return stack
    .split(',')
    .map(unquote)
    .filter((f) => f && !GENERIC.test(f));
}

/** Every family a serialized capture names in a font-family declaration. */
export function familiesUsed(html: string): Set<string> {
  const out = new Set<string>();
  // Entity quotes inside a style attribute hold semicolons; read them as single quotes first.
  const decoded = html.replace(/&quot;|&#34;|&#39;/g, "'");
  for (const m of decoded.matchAll(/font-family:\s*([^;"]+)/gi)) {
    for (const f of familiesIn(m[1]!)) out.add(f.toLowerCase());
  }
  return out;
}

/** Parses url() sources out of a src descriptor, woff2 first, local() and data: kept out. */
function sources(src: string, base: string): string[] {
  const urls: { url: string; rank: number }[] = [];
  for (const m of src.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)\s*(?:format\(\s*['"]?([\w-]+)['"]?\s*\))?/gi)) {
    const raw = m[2]!;
    if (!raw || raw.startsWith('data:')) continue;
    let url: string;
    try {
      url = new URL(raw, base).href;
    } catch {
      continue;
    }
    const format = (m[3] ?? raw.split('?')[0]!.split('.').pop() ?? '').toLowerCase();
    urls.push({ url, rank: format.includes('woff2') ? 0 : format.includes('woff') ? 1 : 2 });
  }
  return urls.sort((a, b) => a.rank - b.rank).map((u) => u.url);
}

/** @font-face blocks in a stylesheet's text (for sheets whose rules the page does not expose). */
export function parseFontFaces(css: string, base: string): FontFaceRule[] {
  const out: FontFaceRule[] = [];
  for (const m of css.matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const descriptors: Record<string, string> = {};
    for (const decl of m[1]!.split(/;(?![^(]*\))/)) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      descriptors[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
    }
    const family = unquote(descriptors['font-family'] ?? '');
    const urls = sources(descriptors.src ?? '', base);
    delete descriptors['font-family'];
    delete descriptors.src;
    if (family && urls.length) out.push({ family, urls, descriptors });
  }
  return out;
}

/** Every @font-face the document declares, from readable sheets directly and from the others by URL. */
export async function documentFontFaces(doc: Document, fetchText: (url: string) => Promise<string | null>): Promise<FontFaceRule[]> {
  const out: FontFaceRule[] = [];
  const visit = async (sheet: CSSStyleSheet, depth: number): Promise<void> => {
    if (depth > 4) return;
    const base = sheet.href ?? doc.baseURI;
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      // Cross-origin without CORS: read the file itself.
      const text = sheet.href ? await fetchText(sheet.href) : null;
      if (text) out.push(...parseFontFaces(text, sheet.href!));
      return;
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSFontFaceRule) out.push(...parseFontFaces(rule.cssText, base));
      else if (rule instanceof CSSImportRule && rule.styleSheet) await visit(rule.styleSheet, depth + 1);
      else if ('cssRules' in rule) {
        // @media / @supports / @layer blocks can hold faces too.
        for (const inner of Array.from((rule as CSSGroupingRule).cssRules)) if (inner instanceof CSSFontFaceRule) out.push(...parseFontFaces(inner.cssText, base));
      }
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) await visit(sheet, 0);
  // Shadow roots and constructed sheets hold faces as well on some sites.
  for (const sheet of doc.adoptedStyleSheets ?? []) await visit(sheet, 0);
  return out;
}

/** Whether a unicode-range descriptor covers any of the code points. */
export function rangeCovers(range: string | undefined, codePoints: Set<number>): boolean {
  if (!range) return true;
  for (const part of range.split(',')) {
    const p = part.trim().replace(/^u\+/i, '');
    let lo: number;
    let hi: number;
    if (p.includes('?')) {
      lo = parseInt(p.replace(/\?/g, '0'), 16);
      hi = parseInt(p.replace(/\?/g, 'f'), 16);
    } else if (p.includes('-')) {
      const [a, b] = p.split('-');
      lo = parseInt(a!, 16);
      hi = parseInt(b!, 16);
    } else lo = hi = parseInt(p, 16);
    if (Number.isNaN(lo) || Number.isNaN(hi)) return true;
    for (const cp of codePoints) if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

const MIME: Record<string, string> = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

async function toDataUrl(blob: Blob, url: string): Promise<string> {
  const ext = url.split('?')[0]!.split('.').pop()?.toLowerCase() ?? '';
  const type = MIME[ext] ?? (blob.type || 'font/woff2');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

/** A self-contained @font-face rule with its file inlined. */
function ruleCss(face: FontFaceRule, dataUrl: string): string {
  const descriptors = Object.entries(face.descriptors)
    .filter(([k]) => k !== 'font-display')
    .map(([k, v]) => `${k}:${v};`)
    .join('');
  return `@font-face{font-family:${JSON.stringify(face.family)};src:url(${dataUrl});font-display:block;${descriptors}}`;
}

export interface EmbedOptions {
  fetchFont(url: string): Promise<Blob | null>;
  fetchText(url: string): Promise<string | null>;
  onProgress?(fraction: number): void;
}

/**
 * @font-face rules (files inlined) for the families the capture uses that the page loads itself, limited to
 * the subsets its text needs and to FONT_BUDGET. Returns '' when nothing applies.
 */
export async function embedFonts(doc: Document, html: string, text: string, opts: EmbedOptions): Promise<string> {
  const used = familiesUsed(html);
  if (!used.size) return '';
  const codePoints = new Set<number>();
  for (const ch of text) codePoints.add(ch.codePointAt(0)!);
  const faces = (await documentFontFaces(doc, opts.fetchText)).filter((f) => used.has(f.family.toLowerCase()) && rangeCovers(f.descriptors['unicode-range'], codePoints));
  // The same face can be declared twice (duplicate sheets); keep one per family + descriptors.
  const seen = new Set<string>();
  const unique = faces.filter((f) => {
    const key = `${f.family.toLowerCase()}|${JSON.stringify(f.descriptors)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rules: string[] = [];
  let spent = 0;
  let done = 0;
  for (const face of unique) {
    for (const url of face.urls) {
      const blob = await opts.fetchFont(url).catch(() => null);
      if (!blob || !blob.size) continue;
      const dataUrl = await toDataUrl(blob, url);
      if (dataUrl.length > MAX_FACE || spent + dataUrl.length > FONT_BUDGET) break;
      spent += dataUrl.length;
      rules.push(ruleCss(face, dataUrl));
      break;
    }
    opts.onProgress?.(++done / unique.length);
  }
  return rules.join('\n');
}
