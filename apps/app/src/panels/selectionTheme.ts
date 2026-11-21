import type * as Y from 'yjs';
import type { Actor, MarkupDoc, StyleUpdate, StyleValue, Styles, Token } from '@markup/doc';
import { useDoc } from '../store/DocProvider';
import { useDeep } from '../store/hooks';
import { previewStyles } from '../canvas/preview';
import { COLOR_IN_VALUE, colorKey, luminance, parseColor, type RGBA } from './color';
import { parseBorder, parseOutline, SIDES, visibleSides } from './effects';

/**
 * What a selection is made of, Figma style: every colour its layers (and their descendants) actually
 * paint, the light/dark theme it sits in, and its type, radius and spacing scales.
 */

/** Style keys that paint a colour (text colour is handled per text layer, see collectColors). */
const PAINT_KEYS = new Set([
  'backgroundColor',
  'background',
  'backgroundImage',
  'border',
  'borderColor',
  ...SIDES.flatMap((s) => [`border${s}`, `border${s}Color`]),
  'outline',
  'outlineColor',
  'boxShadow',
  'textShadow',
  'fill',
  'stroke',
  'filter',
  'backdropFilter',
  'textDecorationColor',
  'WebkitTextStrokeColor',
  'webkitTextStrokeColor',
]);

export interface ColorUse {
  /** The node whose style holds the colour. */
  nodeId: string;
  key: string;
  /** The colour exactly as written in the style value (#fff, lab(…), var(--brand)). */
  raw: string;
  /** The layer that shows the colour: a text layer inherits its colour from an ancestor. */
  layerId: string;
  /** The colour is inherited from outside the selection: an edit sets it on the layer itself. */
  inherited?: boolean;
}

export interface ColorGroup {
  id: string;
  color: RGBA;
  /** Set when the colour comes from a token (var(--name)). */
  token?: string;
  uses: ColorUse[];
}

export interface Scale {
  value: string;
  count: number;
}

export interface FontUse {
  family: string;
  weight: string;
  size: string;
  count: number;
}

export interface SubtreeTheme {
  layers: number;
  colors: ColorGroup[];
  /** Light or dark, from the colour-scheme or the background the selection sits on; null when nothing paints one. */
  mode: 'light' | 'dark' | null;
  background: RGBA | null;
  text: RGBA | null;
  fonts: FontUse[];
  radii: Scale[];
  spacing: Scale[];
}

interface RawNode {
  id: string;
  type: string;
  parentId: string | null;
  children: string[];
  styles: Record<string, unknown>;
  text: string;
  hidden: boolean;
  depth: number;
}

function rawNode(doc: MarkupDoc, id: string, depth = 0): RawNode | undefined {
  const m = doc.nodes.get(id) as Y.Map<unknown> | undefined;
  if (!m) return undefined;
  return {
    id,
    type: m.get('type') as string,
    parentId: (m.get('parentId') as string | null) ?? null,
    children: (m.get('children') as Y.Array<string> | undefined)?.toArray() ?? [],
    styles: ((m.get('styles') as Y.Map<unknown> | undefined)?.toJSON() ?? {}) as Record<string, unknown>,
    text: typeof m.get('text') === 'string' ? (m.get('text') as string) : '',
    hidden: Boolean(m.get('hidden')),
    depth,
  };
}

/** The visible nodes and their visible descendants, each once, in document order. */
function subtree(doc: MarkupDoc, ids: string[]): RawNode[] {
  const out: RawNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = rawNode(doc, id, depth);
    if (!n || (n.hidden && depth > 0)) return;
    out.push(n);
    for (const c of n.children) visit(c, depth + 1);
  };
  for (const id of ids) visit(id, 0);
  return out;
}

/** url(…) contents never hold colours, but may hold words like "white"; mask them before scanning. */
const maskUrls = (v: string) => v.replace(/url\((?:[^()]|\([^()]*\))*\)/gi, (m) => ' '.repeat(m.length));

function colorMatches(value: string): { raw: string; index: number }[] {
  return [...maskUrls(value).matchAll(COLOR_IN_VALUE)].map((m) => ({ raw: value.slice(m.index!, m.index! + m[0].length), index: m.index! }));
}

const isZero = (v: unknown) => v === undefined || v === null || v === '' || /^0(\.0+)?(px|rem|em|%)?$/.test(String(v).trim());

/** Colour keys that paint nothing: a border side with no width or style, no outline, no decoration line. */
function hiddenKeys(styles: Record<string, unknown>): Set<string> {
  const hidden = new Set<string>();
  const shown = visibleSides(parseBorder(styles as Styles));
  for (const s of SIDES) if (!shown.includes(s)) hidden.add(`border${s}`).add(`border${s}Color`);
  if (!shown.length) hidden.add('border').add('borderColor');
  if (!parseOutline(styles as Styles)) hidden.add('outline').add('outlineColor');
  if (!/underline|overline|line-through/.test(String(styles.textDecorationLine ?? styles.textDecoration ?? ''))) hidden.add('textDecorationColor');
  if (isZero(styles.WebkitTextStrokeWidth ?? styles.webkitTextStrokeWidth)) hidden.add('WebkitTextStrokeColor').add('webkitTextStrokeColor');
  return hidden;
}

type Hit = { color: RGBA; token?: string };
type Resolver = (raw: string) => Hit | null;

const VAR_REF = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]+))?\)$/i;

function makeResolver(doc: MarkupDoc): Resolver {
  const tokens = new Map((doc.getTokens() as Token[]).map((t) => [t.name, String(t.value)]));
  const cache = new Map<string, Hit | null>();
  return (raw) => {
    if (cache.has(raw)) return cache.get(raw)!;
    let out: Hit | null = null;
    const ref = VAR_REF.exec(raw.trim());
    if (ref) {
      // Follow aliases (a token whose value is another var()) a few hops.
      let value: string | undefined = tokens.get(ref[1]!) ?? ref[2];
      for (let hop = 0; hop < 8 && value; hop++) {
        const next = VAR_REF.exec(value.trim());
        if (!next) break;
        value = tokens.get(next[1]!) ?? next[2];
      }
      const color = value ? parseColor(value) : null;
      out = color ? { color, token: ref[1]! } : null;
    } else {
      const color = parseColor(raw);
      out = color ? { color } : null;
    }
    cache.set(raw, out);
    return out;
  };
}

/** First colour in a value that resolves (a text colour like `lab(…)` or `var(--ink)`). */
function firstColor(value: unknown, resolve: Resolver): { raw: string; hit: Hit } | null {
  if (typeof value !== 'string') return null;
  for (const { raw } of colorMatches(value)) {
    const hit = resolve(raw);
    if (hit) return { raw, hit };
  }
  return null;
}

/** Walks from a node up through its ancestors; `pick` returns the first value found. */
function upward<T>(doc: MarkupDoc, from: RawNode | undefined, pick: (n: RawNode) => T | undefined): { value: T; node: RawNode } | undefined {
  for (let n = from, hops = 0; n && hops < 200; n = n.parentId ? rawNode(doc, n.parentId) : undefined, hops++) {
    const value = pick(n);
    if (value !== undefined && value !== null) return { value, node: n };
  }
  return undefined;
}

function collectColors(doc: MarkupDoc, nodes: RawNode[], resolve: Resolver): ColorGroup[] {
  const inside = new Set(nodes.map((n) => n.id));
  const groups = new Map<string, ColorGroup>();
  const add = (hit: Hit, use: ColorUse) => {
    if (!hit.token && hit.color.a === 0) return;
    const id = hit.token ? `token:${hit.token}` : colorKey(hit.color);
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { id, color: hit.color, token: hit.token, uses: [] }));
    g.uses.push(use);
  };
  for (const n of nodes) {
    const hidden = hiddenKeys(n.styles);
    for (const [key, v] of Object.entries(n.styles)) {
      if (typeof v !== 'string' || !PAINT_KEYS.has(key) || hidden.has(key)) continue;
      for (const { raw } of colorMatches(v)) {
        const hit = resolve(raw);
        if (hit) add(hit, { nodeId: n.id, key, raw, layerId: n.id });
      }
    }
    // Text colour counts once per text layer, wherever it is declared (text inherits it).
    if (n.type === 'text' && n.text.trim()) {
      const found = upward(doc, n, (m) => firstColor(m.styles.color, resolve) ?? undefined);
      if (found) {
        const own = inside.has(found.node.id);
        add(found.value.hit, { nodeId: own ? found.node.id : n.id, key: 'color', raw: found.value.raw, layerId: n.id, inherited: !own });
      }
    }
  }
  return [...groups.values()].sort((a, b) => b.uses.length - a.uses.length || luminance(a.color) - luminance(b.color));
}

/** The solid colour a node's background paints, if any. */
function paintOf(styles: Record<string, unknown>, resolve: Resolver): RGBA | undefined {
  for (const key of ['backgroundColor', 'background']) {
    const v = styles[key];
    if (typeof v !== 'string') continue;
    for (const { raw } of colorMatches(v)) {
      const hit = resolve(raw);
      if (hit && hit.color.a >= 0.5) return hit.color;
    }
  }
  return undefined;
}

function tally(values: string[], limit: number): Scale[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (parseFloat(a.value) || 0) - (parseFloat(b.value) || 0))
    .slice(0, limit);
}

const firstFamily = (v: string) => (v.split(',')[0] ?? v).trim().replace(/^['"]|['"]$/g, '');
const round = (v: string) => v.replace(/(\d+\.\d{2})\d+/g, (m) => String(Number(Number(m).toFixed(1))));

export function analyzeSubtree(doc: MarkupDoc, ids: string[]): SubtreeTheme {
  const nodes = subtree(doc, ids);
  const resolve = makeResolver(doc);
  const colors = collectColors(doc, nodes, resolve);
  const first = nodes[0];

  // The background it sits on: its own or an ancestor's paint, else the outermost layer inside it that paints one.
  let background = upward(doc, first, (n) => paintOf(n.styles, resolve))?.value ?? null;
  if (!background) {
    let depth = Infinity;
    for (const n of nodes) {
      if (n.depth >= depth) continue;
      const paint = paintOf(n.styles, resolve);
      if (paint) {
        background = paint;
        depth = n.depth;
      }
    }
  }

  // Its base text colour (declared on it or inherited), else the colour most of its text is set in.
  let text = upward(doc, first, (n) => firstColor(n.styles.color, resolve)?.hit.color)?.value ?? null;
  if (!text) {
    const weight = new Map<string, { color: RGBA; chars: number }>();
    for (const g of colors) {
      const chars = g.uses.filter((u) => u.key === 'color').reduce((sum, u) => sum + (rawNode(doc, u.layerId)?.text.trim().length ?? 0), 0);
      if (chars) weight.set(g.id, { color: g.color, chars });
    }
    text = [...weight.values()].sort((a, b) => b.chars - a.chars)[0]?.color ?? null;
  }

  const scheme = upward(doc, first, (n) => (typeof n.styles.colorScheme === 'string' && /^(light|dark)$/.test(n.styles.colorScheme) ? (n.styles.colorScheme as 'light' | 'dark') : undefined))?.value;
  const mode = scheme ?? (background ? (luminance(background) < 0.35 ? 'dark' : 'light') : text ? (luminance(text) > 0.5 ? 'dark' : 'light') : null);

  const fontCounts = new Map<string, FontUse>();
  for (const n of nodes) {
    if (n.type !== 'text' || !n.text.trim()) continue;
    const family = upward(doc, n, (m) => m.styles.fontFamily ?? undefined)?.value;
    const weight = upward(doc, n, (m) => m.styles.fontWeight ?? undefined)?.value;
    const size = upward(doc, n, (m) => m.styles.fontSize ?? undefined)?.value;
    const use = { family: family ? firstFamily(String(family)) : 'Default', weight: weight === undefined ? '400' : String(weight), size: size === undefined ? '16px' : round(String(size)), count: 0 };
    const key = `${use.family}|${use.weight}|${use.size}`;
    const prev = fontCounts.get(key);
    if (prev) prev.count++;
    else fontCounts.set(key, { ...use, count: 1 });
  }
  const fonts = [...fontCounts.values()].sort((a, b) => parseFloat(b.size) - parseFloat(a.size) || b.count - a.count).slice(0, 12);

  const radii: string[] = [];
  const spacing: string[] = [];
  for (const n of nodes) {
    for (const [key, v] of Object.entries(n.styles)) {
      if (isZero(v) || typeof v === 'boolean') continue;
      if (/Radius$/.test(key)) radii.push(round(String(v)));
      else if (key === 'gap' || key === 'rowGap' || key === 'columnGap' || /^padding(Top|Right|Bottom|Left)?$/.test(key)) {
        for (const part of String(v).split(/\s+/)) if (!isZero(part)) spacing.push(round(part));
      }
    }
  }

  return { layers: nodes.length, colors, mode, background, text, fonts, radii: tally(radii, 8), spacing: tally(spacing, 10) };
}

/** Live analysis of the nodes and their descendants; `tokens` is any value that changes with the tokens. */
export function useSubtreeTheme(ids: string[], tokens: unknown): SubtreeTheme {
  const { doc } = useDoc();
  const key = ids.join(',');
  return useDeep(doc.nodes, () => analyzeSubtree(doc, key ? key.split(',') : []), [doc, key, tokens]);
}

/** Style updates that turn the given colour uses into `next`. */
function colorUpdates(doc: MarkupDoc, uses: ColorUse[], next: string): StyleUpdate[] {
  const byNode = new Map<string, Map<string, { raws: Set<string>; inherited: boolean }>>();
  for (const u of uses) {
    let keys = byNode.get(u.nodeId);
    if (!keys) byNode.set(u.nodeId, (keys = new Map()));
    let entry = keys.get(u.key);
    if (!entry) keys.set(u.key, (entry = { raws: new Set(), inherited: false }));
    entry.raws.add(u.raw);
    if (u.inherited) entry.inherited = true;
  }
  const updates: StyleUpdate[] = [];
  for (const [nodeId, keys] of byNode) {
    const styles = (doc.nodes.get(nodeId)?.get('styles') as Y.Map<unknown> | undefined)?.toJSON() as Record<string, unknown> | undefined;
    if (!styles) continue;
    const out: Record<string, StyleValue | null> = {};
    for (const [key, { raws, inherited }] of keys) {
      const value = styles[key];
      if (typeof value !== 'string') {
        if (inherited) out[key] = next;
        continue;
      }
      let result = '';
      let at = 0;
      for (const m of colorMatches(value)) {
        if (!raws.has(m.raw)) continue;
        result += value.slice(at, m.index) + next;
        at = m.index + m.raw.length;
      }
      out[key] = result + value.slice(at);
    }
    if (Object.keys(out).length) updates.push({ nodeIds: [nodeId], styles: out });
  }
  return updates;
}

/** Rewrites the given colour uses to `next`, in one undoable change. */
export function replaceColor(doc: MarkupDoc, actor: Actor, uses: ColorUse[], next: string): void {
  const updates = colorUpdates(doc, uses, next);
  if (updates.length) doc.updateStyles(actor, updates, 'Changed a selection colour', { dialect: 'any' });
}

/** Shows `next` on the canvas in place of the given uses, without touching the document (endPreview restores). */
export function previewColor(doc: MarkupDoc, uses: ColorUse[], next: string): void {
  for (const u of colorUpdates(doc, uses, next)) previewStyles(u.nodeIds, u.styles);
}
