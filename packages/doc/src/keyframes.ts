import type * as Y from 'yjs';
import type { MarkupDoc } from './document';

/**
 * @keyframes rules embedded in the file, brought in by page snapshots so pasted layers keep the page's motion
 * (fade-ins, blur-ins, loops), and the @property registrations animated custom properties need (a rotating
 * gradient's --angle). Like embedded fonts they are assets of the file, not edits: adding them is neither logged
 * nor undone, and a rule is stored once under its name (snapshot keyframe names are derived from their content).
 */

const MAX_RULE = 200_000;
const RULE = /^@keyframes\s+([A-Za-z_-][\w-]*)\s*\{[\s\S]*\}$|^@property\s+(--[\w-]+)\s*\{[^{}]*\}$/;
/** Nothing that can load a resource, run script, or break out of the style element it is written into. */
const UNSAFE = /<|\\|url\(|@import|expression\(|javascript:|vbscript:|-moz-binding|behavior\s*:/i;

export const keyframesMap = (doc: MarkupDoc): Y.Map<string> => doc.ydoc.getMap<string>('keyframes');

/** The top-level @keyframes and @property rules in a stylesheet text, one string each. */
export function splitKeyframes(css: string): string[] {
  const out: string[] = [];
  const re = /@(keyframes|property)\s/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const open = css.indexOf('{', m.index);
    if (open < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    out.push(css.slice(m.index, end + 1));
    re.lastIndex = end + 1;
  }
  return out;
}

/** Stores the rules in the css; returns how many were new or replaced. */
export function addKeyframes(doc: MarkupDoc, css: string): number {
  const map = keyframesMap(doc);
  let changed = 0;
  doc.ydoc.transact(() => {
    for (const rule of splitKeyframes(css)) {
      const m = RULE.exec(rule);
      const name = m?.[1] ?? m?.[2];
      // @property syntax descriptors name types in angle brackets ("<angle>"); only those may hold a "<".
      if (!name || rule.length > MAX_RULE || UNSAFE.test(rule.replace(/<[a-z-]+>/gi, ''))) continue;
      if (map.get(name) === rule) continue;
      map.set(name, rule);
      changed++;
    }
  }, null);
  return changed;
}

/** Every embedded @keyframes and @property rule in the file. */
export function keyframeRules(doc: MarkupDoc): string[] {
  return [...keyframesMap(doc).values()];
}
