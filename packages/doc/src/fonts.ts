import type * as Y from 'yjs';
import type { MarkupDoc } from './document';

/**
 * Web fonts embedded in the file: @font-face rules with their font files inlined as data URLs, brought in
 * by page snapshots so pasted text keeps the page's own typeface. They are assets of the file, not edits:
 * adding them is neither logged nor undone, and the same face is stored once.
 */

const MAX_RULE = 4_000_000;

export const fontsMap = (doc: MarkupDoc): Y.Map<string> => doc.ydoc.getMap<string>('fonts');

/** The @font-face rules in a stylesheet text, one string each. */
export function splitFontFaces(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@font-face\s*\{[^}]*\}/gi)) out.push(m[0]);
  return out;
}

/** Identity of a face: its declaration without the file, so a re-pasted face replaces rather than duplicates. */
export function faceKey(rule: string): string {
  return rule
    // src holds url(data:…;base64,…), whose semicolons are not declaration ends.
    .replace(/src\s*:(?:[^;}(]|\([^)]*\))*;?/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Only well-formed faces whose sources are inlined data: fonts are kept (never a network URL). */
function acceptable(rule: string): boolean {
  if (rule.length > MAX_RULE || !/font-family\s*:/i.test(rule)) return false;
  const urls = [...rule.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((m) => m[2]!);
  return urls.length > 0 && urls.every((u) => /^data:(font\/|application\/(font|x-font|octet-stream))/i.test(u));
}

/** Stores the faces in the css; returns how many were new or replaced. */
export function addFontFaces(doc: MarkupDoc, css: string): number {
  const rules = splitFontFaces(css).filter(acceptable);
  if (!rules.length) return 0;
  const map = fontsMap(doc);
  let changed = 0;
  doc.ydoc.transact(() => {
    for (const rule of rules) {
      const key = faceKey(rule);
      if (map.get(key) === rule) continue;
      map.set(key, rule);
      changed++;
    }
  }, null);
  return changed;
}

/** Every embedded @font-face rule in the file. */
export function fontFaces(doc: MarkupDoc): string[] {
  return [...fontsMap(doc).values()];
}
