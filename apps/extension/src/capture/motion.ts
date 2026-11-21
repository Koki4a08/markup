/**
 * Motion a snapshot carries over: the page's CSS animations, transitions and Web Animations (fade-ins, blur-ins,
 * slide-ups, loops) become @keyframes plus `animation-*` declarations, so the pasted layers move like the page.
 * Keyframes come from the live Animation objects (getKeyframes), which works for cross-origin stylesheets too
 * and gives every capture its own collision-free keyframe names.
 */
import { safeValue, type Decl } from './styles';

export interface MotionFrame {
  offset: number;
  /** Timing function from this keyframe to the next. */
  easing: string;
  props: [prop: string, value: string][];
}

export interface MotionRecord {
  /** The page's own name for it (a CSS animation's name), used in the keyframes name for readability. */
  label: string;
  frames: MotionFrame[];
  /** Milliseconds, already scaled by the animation's playback rate. */
  duration: number;
  delay: number;
  iterations: number;
  direction: string;
  fill: string;
  /**
   * Driven by scrolling the element into view (a scroll-driven `view()` timeline): replayed once as an entrance,
   * and its last keyframe is how the layer rests (the page, scrolled back, shows it before its entrance).
   */
  settles?: boolean;
}

/** Properties a scroll or load reveal changes; a CSS transition is only kept when it animates one of them. */
export const MOTION_PROPS = ['opacity', 'transform', 'translate', 'scale', 'rotate', 'filter', 'clip-path', 'visibility'];
const KEYFRAME_META = new Set(['offset', 'computedOffset', 'easing', 'composite']);
const DIRECTIONS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILLS = new Set(['none', 'forwards', 'backwards', 'both']);
const SAFE_EASING = /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|(cubic-bezier|steps|linear)\([^()]*\))$/;
/** A reveal measured from fewer mutations than this window gets the default duration. */
const REVEAL_DEFAULT_MS = 700;
const REVEAL_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
/** How long an entrance driven by scrolling into view takes once replayed on a time line. */
const VIEW_ENTRANCE_MS = 900;

/** What drives an animation: time, scrolling an element into view, or the scroll position itself. */
function timelineKind(anim: Animation): 'time' | 'view' | 'scroll' {
  const tl = anim.timeline as (AnimationTimeline & { subject?: unknown; source?: unknown }) | null;
  if (!tl || !('source' in tl)) return 'time';
  return 'subject' in tl ? 'view' : 'scroll';
}

/** A Web Animations property name (camelCase) as a CSS property. */
export function cssProp(key: string): string {
  if (key.startsWith('--')) return key;
  if (key === 'cssFloat') return 'float';
  if (key === 'cssOffset') return 'offset';
  const kebab = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return /^(webkit|moz)-/.test(kebab) ? `-${kebab}` : kebab;
}

const easingOf = (v: unknown): string => {
  const e = typeof v === 'string' ? v.trim() : '';
  return SAFE_EASING.test(e) ? e : 'linear';
};

/** A value fit for a keyframe: no url() (the paste side keeps only inline images, and keyframes carry none). */
const keyframeValue = (v: unknown): string | null => {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s && safeValue(s) && !/url\(/i.test(s) && !/[;]/.test(s) ? s : null;
};

/** The animation as a record, or null when it has no keyframes or no running time worth replaying. */
export function recordOf(anim: Animation): MotionRecord | null {
  const effect = anim.effect as KeyframeEffect | null;
  if (!effect || typeof effect.getKeyframes !== 'function' || typeof effect.getTiming !== 'function') return null;
  const timing = effect.getTiming();
  const rate = Math.abs(anim.playbackRate || 1) || 1;
  const kind = timelineKind(anim);
  // A scroll-position timeline (progress bars, parallax) has no time of its own: the layer keeps its state.
  if (kind === 'scroll') return null;
  const rawDuration = kind === 'view' ? VIEW_ENTRANCE_MS : typeof timing.duration === 'number' ? timing.duration : parseFloat(String(timing.duration ?? ''));
  const duration = rawDuration / (kind === 'view' ? 1 : rate);
  if (!(duration > 0) || !Number.isFinite(duration)) return null;
  let raw: ComputedKeyframe[];
  try {
    raw = effect.getKeyframes();
  } catch {
    return null;
  }
  const frames: MotionFrame[] = [];
  raw.forEach((k, i) => {
    const props: [string, string][] = [];
    for (const [key, value] of Object.entries(k)) {
      if (KEYFRAME_META.has(key)) continue;
      const v = keyframeValue(value);
      if (v) props.push([cssProp(key), v]);
    }
    const offset = typeof k.computedOffset === 'number' ? k.computedOffset : typeof k.offset === 'number' ? k.offset : raw.length > 1 ? i / (raw.length - 1) : 0;
    if (props.length) frames.push({ offset: Math.min(1, Math.max(0, offset)), easing: easingOf(k.easing), props });
  });
  if (!frames.length) return null;
  // An effect-wide easing (Web Animations; CSS animations leave it linear) eases the whole iteration. CSS
  // eases per keyframe interval: the same thing for two keyframes, the nearest match for more.
  const whole = easingOf(timing.easing);
  if (whole !== 'linear') for (const f of frames.slice(0, -1)) if (f.easing === 'linear') f.easing = whole;
  const iterations = timing.iterations === undefined ? 1 : Number(timing.iterations);
  const label = (anim as Animation & { animationName?: string }).animationName ?? (anim as Animation & { transitionProperty?: string }).transitionProperty ?? '';
  if (kind === 'view') {
    if (whole === 'linear') for (const f of frames.slice(0, -1)) if (f.easing === 'linear') f.easing = REVEAL_EASING;
    return { label, frames, duration, delay: 0, iterations: 1, direction: 'normal', fill: 'both', settles: true };
  }
  return {
    label,
    frames,
    duration,
    delay: (Number(timing.delay) || 0) / rate,
    iterations: iterations > 0 ? iterations : 1,
    direction: DIRECTIONS.has(String(timing.direction)) ? String(timing.direction) : 'normal',
    fill: FILLS.has(String(timing.fill)) ? String(timing.fill) : 'none',
  };
}

/** Whether the animation is a CSS transition that changes something other than how an element reveals itself. */
export function incidentalTransition(anim: Animation): boolean {
  const property = (anim as Animation & { transitionProperty?: string }).transitionProperty;
  return typeof property === 'string' && !MOTION_PROPS.includes(property);
}

/** The animations that target el (or one of its ::before / ::after), from a document's getAnimations(). */
export function animationTarget(anim: Animation): { el: Element; pseudo: string } | null {
  const effect = anim.effect as KeyframeEffect | null;
  const el = effect?.target;
  if (!el) return null;
  return { el, pseudo: effect.pseudoElement ?? '' };
}

// ── CSS animations the page no longer runs ─────────────────────────────────────────────────────────

/** What capture reads from the page's stylesheets for motion. */
export interface PageMotionCss {
  /** @keyframes rules by name (a later rule of the same name wins, as in CSS). */
  keyframes: Map<string, CSSKeyframesRule>;
  /** @property registrations by custom property name, as CSS text. */
  properties: Map<string, string>;
  /** Style rules that use a custom property (var(--…)), in document order. */
  varRules: CSSStyleRule[];
}

/**
 * The page's @keyframes, @property rules and var()-using style rules. Sheets the page cannot read (cross-origin
 * without CORS) are read through `fetchText` and parsed into a detached sheet.
 */
export async function documentMotionCss(doc: Document, fetchText: (url: string) => Promise<string | null>): Promise<PageMotionCss> {
  const out: PageMotionCss = { keyframes: new Map(), properties: new Map(), varRules: [] };
  const win = doc.defaultView;
  const visit = async (sheet: CSSStyleSheet, depth: number): Promise<void> => {
    if (depth > 4) return;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      const text = sheet.href ? await fetchText(sheet.href).catch(() => null) : null;
      if (!text || !win || typeof win.CSSStyleSheet !== 'function') return;
      try {
        const detached = new win.CSSStyleSheet();
        detached.replaceSync(text);
        await visit(detached, depth + 1);
      } catch {
        // Not parseable here: its animations are only kept while they run.
      }
      return;
    }
    const walk = async (list: CSSRuleList): Promise<void> => {
      for (const rule of Array.from(list)) {
        if (rule.type === 7) out.keyframes.set((rule as CSSKeyframesRule).name, rule as CSSKeyframesRule);
        else if (rule.type === 3 && (rule as CSSImportRule).styleSheet) await visit((rule as CSSImportRule).styleSheet!, depth + 1);
        else if ('syntax' in rule && 'inherits' in rule && 'name' in rule) out.properties.set(String((rule as CSSPropertyRule).name), rule.cssText);
        else {
          if (rule.type === 1 && /var\(\s*--/.test((rule as CSSStyleRule).style.cssText)) out.varRules.push(rule as CSSStyleRule);
          if ('cssRules' in rule) await walk((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    await walk(rules);
  };
  for (const sheet of Array.from(doc.styleSheets)) await visit(sheet as CSSStyleSheet, 0);
  for (const sheet of doc.adoptedStyleSheets ?? []) await visit(sheet, 0);
  return out;
}

/** A top-level comma list (timing functions hold commas of their own). */
function list(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
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

const time = (v: string | undefined): number => {
  const n = parseFloat(v ?? '');
  if (!Number.isFinite(n)) return 0;
  return /ms$/i.test(v!.trim()) ? n : n * 1000;
};

/** A @keyframes rule's frames, each keyframe's own timing function taking over from the animation's. */
function ruleFrames(rule: CSSKeyframesRule, easing: string): MotionFrame[] {
  const frames: MotionFrame[] = [];
  for (const kf of Array.from(rule.cssRules) as CSSKeyframeRule[]) {
    const props: [string, string][] = [];
    let own = easing;
    for (let i = 0; i < kf.style.length; i++) {
      const p = kf.style[i]!;
      const v = kf.style.getPropertyValue(p);
      if (p === 'animation-timing-function') own = easingOf(v);
      else {
        const value = keyframeValue(v);
        // A custom property the pasted layer does not define would void the whole declaration.
        if (value && !/var\(/i.test(value)) props.push([p, value]);
      }
    }
    if (!props.length) continue;
    for (const key of kf.keyText.split(',')) {
      const k = key.trim().toLowerCase();
      const offset = k === 'from' ? 0 : k === 'to' ? 1 : parseFloat(k) / 100;
      if (Number.isFinite(offset)) frames.push({ offset: Math.min(1, Math.max(0, offset)), easing: own, props });
    }
  }
  return frames.sort((a, b) => a.offset - b.offset);
}

/**
 * The CSS animations an element's computed style names, rebuilt from their @keyframes rules: an entrance
 * animation without a fill mode leaves getAnimations() once it ends, usually long before the capture.
 */
export function cssAnimationRecords(cs: CSSStyleDeclaration, lookup: (name: string) => CSSKeyframesRule | undefined, skip: ReadonlySet<string> = new Set()): MotionRecord[] {
  const read = (p: string) => list((cs.getPropertyValue(p) || '').trim());
  const names = read('animation-name');
  if (!names.length || (names.length === 1 && names[0] === 'none')) return [];
  const at = (values: string[], i: number) => values[i % Math.max(1, values.length)];
  const [durations, delays, counts, directions, fills, easings, states, timelines] = ['animation-duration', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-timing-function', 'animation-play-state', 'animation-timeline'].map(read);
  const out: MotionRecord[] = [];
  names.forEach((name, i) => {
    if (name === 'none' || skip.has(name) || at(states!, i) === 'paused') return;
    const rule = lookup(name);
    // Scroll-driven: view() (or a named timeline, usually a view timeline) replays as an entrance; scroll()
    // follows the scroll position, which a still layer does not have.
    const timeline = at(timelines!, i) ?? 'auto';
    if (timeline === 'none' || /^scroll\(/.test(timeline)) return;
    const view = timeline !== 'auto';
    const duration = view ? VIEW_ENTRANCE_MS : time(at(durations!, i));
    if (!rule || !(duration > 0)) return;
    const frames = ruleFrames(rule, easingOf(at(easings!, i) ?? 'ease'));
    if (!frames.length) return;
    if (view) {
      out.push({ label: name, frames, duration, delay: 0, iterations: 1, direction: 'normal', fill: 'both', settles: true });
      return;
    }
    const count = at(counts!, i) ?? '1';
    const direction = at(directions!, i) ?? 'normal';
    const fill = at(fills!, i) ?? 'none';
    out.push({
      label: name,
      frames,
      duration,
      delay: time(at(delays!, i)),
      iterations: count === 'infinite' ? Infinity : Math.max(0, parseFloat(count) || 1),
      direction: DIRECTIONS.has(direction) ? direction : 'normal',
      fill: FILLS.has(fill) ? fill : 'none',
    });
  });
  return out;
}

const TRANSFORMS = new Set(['transform', 'translate', 'scale', 'rotate']);
const IDENTITY = /^(none|matrix\(1, 0, 0, 1, 0, 0\)|matrix3d\(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1\))$/;

/**
 * Motion for a layer placed at its measured position (the simplified snapshot), where the page's resting transform
 * is already part of the position. An entrance that ends at a transform other than none (translate(-50%, -50%)
 * centring, a tilt) would move the layer twice, so such motions keep only their fade, blur and colour; loops and
 * entrances that end untransformed keep their movement.
 */
export function relativeMotion(records: MotionRecord[], cs: CSSStyleDeclaration): MotionRecord[] {
  const rest = ['transform', 'translate', 'scale', 'rotate'].every((p) => IDENTITY.test((cs.getPropertyValue(p) || 'none').trim()));
  if (rest) return records;
  return records.flatMap((r) => {
    if (!Number.isFinite(r.iterations)) return [r];
    const frames = r.frames.map((f) => ({ ...f, props: f.props.filter(([p]) => !TRANSFORMS.has(p)) })).filter((f) => f.props.length);
    return frames.length ? [{ ...r, frames }] : [];
  });
}

const ms = (n: number) => `${Math.round(n * 100) / 100}ms`;
const pct = (n: number) => `${Math.round(n * 10000) / 100}%`;

/** 32-bit FNV-1a, base 36: a short stable id for a keyframes body. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The @keyframes rules a capture uses, each named after its content (`mk-<label>-<hash>`), so the same motion is
 * one rule however many elements use it, and two pages' "fadeIn" never collide in one file.
 */
export class KeyframesRegistry {
  private readonly rules = new Map<string, string>();
  /** @property registrations the animated custom properties need to interpolate (not flip) between values. */
  private readonly properties = new Map<string, string>();

  addProperty(name: string, rule: string): void {
    this.properties.set(name, rule);
  }

  add(rec: MotionRecord): string {
    const body = rec.frames
      .map((f, i) => {
        const decls = f.props.map(([p, v]) => `${p}:${v}`);
        // The last keyframe's easing never applies; leaving it out keeps identical motions identical.
        if (i < rec.frames.length - 1 && f.easing !== 'linear') decls.push(`animation-timing-function:${f.easing}`);
        return `${pct(f.offset)}{${decls.join(';')}}`;
      })
      .join('');
    const label = rec.label.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
    const name = `mk-${label ? `${label}-` : ''}${hash(body)}`;
    if (!this.rules.has(name)) this.rules.set(name, `@keyframes ${name}{${body}}`);
    return name;
  }

  get size(): number {
    return this.rules.size + this.properties.size;
  }

  css(): string {
    return [...this.properties.values(), ...this.rules.values()].join('\n');
  }
}

/**
 * How a layer rests after the animations that settle (scroll-driven entrances): their last keyframe. The page was
 * captured scrolled back, before those entrances ran, and an export shows layers at rest.
 */
export function restingDecls(records: MotionRecord[]): Decl[] {
  return records.filter((r) => r.settles).flatMap((r) => r.frames.filter((f) => f.offset === 1).flatMap((f) => f.props));
}

/** `animation-*` longhands for the records (comma lists, one entry per distinct animation). */
export function motionDecls(records: MotionRecord[], registry: KeyframesRegistry): Decl[] {
  const seen = new Set<string>();
  const rows: string[][] = [];
  for (const r of records) {
    const row = [registry.add(r), ms(r.duration), 'linear', ms(r.delay), Number.isFinite(r.iterations) ? String(Math.round(r.iterations * 1000) / 1000) : 'infinite', r.direction, r.fill];
    const key = row.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  if (!rows.length) return [];
  const props = ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode'];
  return props.map((p, i) => [p, rows.map((r) => r[i]!).join(', ')] as Decl);
}

/** An inline style attribute's declarations (lowercased names), split on top-level semicolons. */
export function parseInline(style: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  let depth = 0;
  let start = 0;
  const flush = (end: number) => {
    const d = style.slice(start, end);
    const colon = d.indexOf(':');
    if (colon > 0) out[d.slice(0, colon).trim().toLowerCase()] = d.slice(colon + 1).replace(/!important\s*$/i, '').trim();
    start = end + 1;
  };
  for (let i = 0; i < style.length; i++) {
    const ch = style[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) flush(i);
  }
  flush(style.length);
  return out;
}

const blurOf = (filter: string): number => {
  const m = /blur\(\s*([\d.]+)px\s*\)/i.exec(filter);
  return m ? parseFloat(m[1]!) : 0;
};
const opacityOf = (v: string | undefined, fallback: number): number => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? (/%$/.test(v!.trim()) ? n / 100 : n) : fallback;
};

/**
 * A reveal a script drove through the inline style (GSAP, framer-motion's JS path, hand-written observers): the
 * style the element had before the page first changed it, against how it looks now. Only a change that makes the
 * element more visible counts (fade in, un-blur, un-hide), so parallax and scroll-linked transforms are left out.
 */
export function revealRecord(initial: Record<string, string>, final: CSSStyleDeclaration, durationMs: number): MotionRecord | null {
  const now = (p: string) => (final.getPropertyValue(p) || '').trim();
  const fadesIn = initial.opacity !== undefined && opacityOf(initial.opacity, 1) < opacityOf(now('opacity'), 1) - 0.05;
  const unblurs = initial.filter !== undefined && blurOf(initial.filter) > blurOf(now('filter')) + 0.5;
  const unhides = initial.visibility === 'hidden' && now('visibility') === 'visible';
  if (!fadesIn && !unblurs && !unhides) return null;
  const from: [string, string][] = [];
  const to: [string, string][] = [];
  for (const p of MOTION_PROPS) {
    const before = initial[p];
    const after = now(p);
    if (before === undefined || /var\(/i.test(before) || !after || before === after) continue;
    const b = keyframeValue(before);
    const a = keyframeValue(after);
    if (!b || !a) continue;
    from.push([p, b]);
    to.push([p, a]);
  }
  if (!from.length) return null;
  const duration = durationMs >= 150 ? Math.min(1500, durationMs) : REVEAL_DEFAULT_MS;
  return {
    label: 'reveal',
    frames: [
      { offset: 0, easing: REVEAL_EASING, props: from },
      { offset: 1, easing: 'linear', props: to },
    ],
    duration,
    delay: 0,
    iterations: 1,
    direction: 'normal',
    fill: 'both',
  };
}
