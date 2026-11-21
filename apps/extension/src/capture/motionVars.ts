/**
 * Animated custom properties: a rotating conic-gradient border animates `--angle` (registered with @property) and
 * the gradient reads var(--angle). Computed style has the var() already substituted, so the copy would keep one
 * still angle; here the declarations that use an animated property are taken as the page wrote them (other
 * var()s resolved), with the property's current value and its @property registration, so the motion keeps working.
 */
import type { CaptureEnv } from './env';
import type { KeyframesRegistry, MotionRecord, PageMotionCss } from './motion';
import { motionDecls, parseInline, restingDecls } from './motion';
import { safeValue, type Decl } from './styles';

const PSEUDO_ELEMENT = /::?(before|after|placeholder|marker|selection|first-line|first-letter|backdrop|file-selector-button|-[\w-]+)\s*$/i;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The custom properties the records animate. */
export function animatedProperties(records: MotionRecord[]): Set<string> {
  return new Set(records.flatMap((r) => r.frames.flatMap((f) => f.props.map(([p]) => p))).filter((p) => p.startsWith('--')));
}

/** A selector list split on top-level commas. */
function selectors(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Whether a style rule's selector applies to el (or to its ::before / ::after). */
export function ruleMatches(el: Element, selectorText: string, pseudo: string): boolean {
  for (const sel of selectors(selectorText)) {
    const m = PSEUDO_ELEMENT.exec(sel);
    let base = sel;
    if (pseudo) {
      if (!m || `::${m[1]!.toLowerCase()}` !== pseudo) continue;
      base = sel.slice(0, m.index).trim() || '*';
    } else if (m) continue;
    try {
      if (el.matches(base)) return true;
    } catch {
      // A selector this engine cannot match against (nesting, unknown pseudo-classes).
    }
  }
  return false;
}

/** var(--x[, fallback]) with one level of parentheses inside the fallback. */
const VAR = /var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/g;

/** The value with every var() but the animated ones replaced by the element's own value (or the fallback). */
export function resolveVars(value: string, cs: CSSStyleDeclaration, keep: ReadonlySet<string>): string | null {
  let v = value;
  let missing = false;
  for (let i = 0; i < 8; i++) {
    let changed = false;
    v = v.replace(VAR, (m, name: string, fallback?: string) => {
      if (keep.has(name)) return m;
      const resolved = (cs.getPropertyValue(name) || '').trim() || (fallback ?? '').trim();
      if (!resolved) {
        missing = true;
        return m;
      }
      changed = true;
      return resolved;
    });
    if (!changed || missing) break;
  }
  return missing ? null : v;
}

/**
 * Declarations that keep an animated custom property driving the element: the property's current value, and each
 * declaration the page wrote with var() of it (shorthands included, from inline style or matching rules, the
 * later one winning). `rules` are the @property registrations to carry along.
 */
export function animatedVarDecls(el: Element, pseudo: string, cs: CSSStyleDeclaration, records: MotionRecord[], css: PageMotionCss | null): { decls: Decl[]; rules: [string, string][] } {
  const animated = animatedProperties(records);
  if (!animated.size) return { decls: [], rules: [] };
  const pattern = new RegExp(`var\\(\\s*(${[...animated].map(escapeRe).join('|')})\\s*[,)]`);
  const specified = new Map<string, string>();
  const take = (text: string) => {
    for (const [p, v] of Object.entries(parseInline(text))) {
      if (p.startsWith('--') || !pattern.test(v)) continue;
      specified.delete(p); // A later declaration also comes later in the output.
      specified.set(p, v);
    }
  };
  for (const rule of css?.varRules ?? []) {
    if (pattern.test(rule.style.cssText) && ruleMatches(el, rule.selectorText, pseudo)) take(rule.style.cssText);
  }
  if (!pseudo) take(el.getAttribute('style') ?? '');
  const decls: Decl[] = [];
  for (const name of animated) {
    const now = (cs.getPropertyValue(name) || '').trim();
    if (now && safeValue(now)) decls.push([name, now]);
  }
  for (const [p, v] of specified) {
    const resolved = resolveVars(v, cs, animated);
    if (resolved && safeValue(resolved) && !/url\(/i.test(resolved)) decls.push([p, resolved]);
  }
  const rules = [...animated].flatMap((n) => {
    const rule = css?.properties.get(n);
    return rule ? [[n, rule] as [string, string]] : [];
  });
  return { decls, rules };
}

/**
 * Everything motion adds to a layer's style, in order: animated custom properties and the declarations using
 * them, the resting state of scroll-driven entrances, then the animation-* longhands. `adjust` reshapes the
 * records first (the simplified snapshot keeps only motion relative to its measured position).
 */
export function motionStyle(env: CaptureEnv, registry: KeyframesRegistry, owner: Element, pseudo: '::before' | '::after' | undefined, cs: CSSStyleDeclaration, adjust?: (r: MotionRecord[]) => MotionRecord[]): Decl[] {
  const all = env.motions?.(owner, pseudo, cs) ?? [];
  const records = adjust ? adjust(all) : all;
  if (!records.length) return [];
  const vars = env.motionVars?.(owner, pseudo ?? '', cs, records) ?? { decls: [], rules: [] };
  for (const [name, rule] of vars.rules) registry.addProperty(name, rule);
  return [...vars.decls, ...restingDecls(records), ...motionDecls(records, registry)];
}
