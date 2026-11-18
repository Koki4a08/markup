import type { MarkupDoc } from './document';
import { parsePx } from './ops';
import type { MarkupNode, StyleValue } from './schema';
import { camelCase } from './styles';

const MAX_DEPTH = 10;

const COMPONENT: Record<MarkupNode['type'], string> = { root: 'Root', frame: 'Frame', text: 'Text', image: 'Image', svg: 'SVG' };

export function plainText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function size(node: MarkupNode): string {
  const w = parsePx(node.styles.width);
  const h = parsePx(node.styles.height);
  return `${w ?? '?'}×${h ?? '?'}`;
}

function line(node: MarkupNode): string {
  const label = node.type === 'text' ? plainText(node.text ?? '').slice(0, 40) : node.name;
  return `${node.type} "${label}" (${node.id}) ${size(node)}`;
}

export function treeSummary(doc: MarkupDoc, nodeId: string, depth = 3): string {
  const maxDepth = Math.min(Math.max(0, depth), MAX_DEPTH);
  const out: string[] = [];
  const walk = (id: string, level: number) => {
    const node = doc.requireNode(id);
    out.push(`${'  '.repeat(level)}${line(node)}`);
    if (node.children.length === 0) return;
    if (level === maxDepth) {
      out.push(`${'  '.repeat(level + 1)}… ${node.children.length} children`);
      return;
    }
    for (const child of node.children) walk(child, level + 1);
  };
  walk(nodeId, 0);
  return out.join('\n');
}

export function wildcard(pattern: string, flags = ''): RegExp {
  const escaped = pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`, flags);
}

/** Normalizes hex, rgb() and rgba() to `r,g,b,a`; undefined when the value is not a simple color. */
export function parseColor(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  const named: Record<string, string> = { black: '0,0,0,1', white: '255,255,255,1', transparent: '0,0,0,0' };
  if (named[v]) return named[v];
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return undefined;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    const a = h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1;
    return `${n(0)},${n(2)},${n(4)},${a}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    return `${Number(rgb[1])},${Number(rgb[2])},${Number(rgb[3])},${alpha}`;
  }
  return undefined;
}

export type StyleMatcher = (key: string, value: StyleValue) => string | undefined;

export interface FindQuery {
  filters?: { styleName?: string; styleValue?: string }[];
  textValue?: string;
  nodeId?: string;
  pageId?: string;
}

export type FindMatch = { styleName: string; styleValue: string } | { textValue: string };

export interface FindResult {
  id: string;
  name: string;
  component: string;
  matched: FindMatch[];
}

/** Value matcher for one filter; returns the matched fragment or undefined. Extended by tokens. */
export function valueMatcher(doc: MarkupDoc, styleValue: string | undefined): (value: StyleValue) => string | undefined {
  if (styleValue === undefined || styleValue === '*') return (v) => String(v);
  const token = /^(?:var\()?(--[\w-]+)\)?$/.exec(styleValue.trim());
  if (token) {
    const ref = `var(${token[1]})`;
    return (v) => (String(v).includes(ref) ? ref : undefined);
  }
  const color = parseColor(styleValue);
  if (color) {
    return (v) => {
      const raw = String(v);
      return parseColor(raw) === color ? raw : undefined;
    };
  }
  const re = wildcard(styleValue, 'i');
  return (v) => (re.test(String(v)) || (typeof v === 'number' && re.test(`${v}px`)) ? String(v) : undefined);
}

export function findNodes(doc: MarkupDoc, q: FindQuery): FindResult[] {
  const roots: string[] = q.nodeId
    ? [q.nodeId]
    : q.pageId
      ? [doc.rootOf(q.pageId)]
      : doc.pages().flatMap((p) => (p.type === 'page' ? [p.rootId] : []));
  const filters = (q.filters ?? []).map((f) => ({
    name: f.styleName ? wildcard(camelCase(f.styleName), 'i') : /.*/,
    value: valueMatcher(doc, f.styleValue),
  }));
  const textRe = q.textValue === undefined ? undefined : wildcard(q.textValue, 'i');
  const results: FindResult[] = [];

  const visit = (id: string) => {
    const node = doc.requireNode(id);
    if (node.type !== 'root') {
      const matched: FindMatch[] = [];
      let ok = true;
      for (const f of filters) {
        const hit = Object.entries(node.styles).find(([k, v]) => f.name.test(k) && f.value(v) !== undefined);
        if (!hit) {
          ok = false;
          break;
        }
        matched.push({ styleName: hit[0], styleValue: f.value(hit[1])! });
      }
      if (ok && textRe) {
        const text = node.type === 'text' ? plainText(node.text ?? '') : undefined;
        if (text !== undefined && textRe.test(text)) matched.push({ textValue: text });
        else ok = false;
      }
      if (ok && (filters.length > 0 || textRe)) results.push({ id, name: node.name, component: COMPONENT[node.type], matched });
    }
    node.children.forEach(visit);
  };

  roots.forEach(visit);
  return results;
}
