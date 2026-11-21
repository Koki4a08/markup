import * as Y from 'yjs';
import type { MarkupDoc } from './document';
import { wildcard } from './wildcard';

export const TOKEN_TYPES = ['breakpoint', 'color', 'container', 'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'opacity', 'radius', 'spacing'] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

export interface Token {
  name: string;
  type: TokenType;
  value: string | number;
  description?: string;
}

export interface TokenEdit {
  name: string;
  newName?: string;
  value?: string | number;
  description?: string;
  delete?: boolean;
}

export type TokenResult = { name: string; result: 'created' | 'updated' | 'deleted' | 'error'; message?: string };

const NAME_RE = /^--[a-zA-Z0-9_-]+$/;
const MAX_DESCRIPTION = 1024;
const MAX_ALIAS_HOPS = 16;

/** Tailwind v4 theme namespace per token type. */
const TAILWIND_NS: Record<TokenType, string> = {
  color: 'color',
  spacing: 'spacing',
  radius: 'radius',
  fontSize: 'text',
  fontWeight: 'font-weight',
  fontFamily: 'font',
  lineHeight: 'leading',
  letterSpacing: 'tracking',
  breakpoint: 'breakpoint',
  container: 'container',
  opacity: 'opacity',
};

const tokensArr = (doc: MarkupDoc) => doc.ydoc.getArray<Y.Map<unknown>>('tokens');

function toToken(m: Y.Map<unknown>): Token {
  const t: Token = { type: m.get('type') as TokenType, name: m.get('name') as string, value: m.get('value') as string | number };
  const d = m.get('description');
  if (typeof d === 'string' && d) t.description = d;
  return t;
}

export function listTokens(doc: MarkupDoc): Token[] {
  return tokensArr(doc).toArray().map(toToken);
}

function indexOf(doc: MarkupDoc, name: string): number {
  return tokensArr(doc).toArray().findIndex((m) => m.get('name') === name);
}

function validate(t: Partial<Token>): string | undefined {
  if (!t.name || !NAME_RE.test(t.name)) return `Token name must match ${NAME_RE.source}.`;
  if (t.type !== undefined && !TOKEN_TYPES.includes(t.type)) return `Unknown token type ${t.type}.`;
  if (t.description !== undefined && t.description.length > MAX_DESCRIPTION) return `Description is limited to ${MAX_DESCRIPTION} characters.`;
  return undefined;
}

export function createTokens(doc: MarkupDoc, tokens: Token[]): TokenResult[] {
  return tokens.map((t) => {
    const error = validate(t);
    if (error) return { name: t.name, result: 'error', message: error };
    const m = new Y.Map<unknown>();
    m.set('type', t.type);
    m.set('name', t.name);
    m.set('value', t.value);
    if (t.description) m.set('description', t.description);
    tokensArr(doc).push([m]);
    return { name: t.name, result: 'created' };
  });
}

const refPattern = (name: string) => new RegExp(`var\\(\\s*${name.replace(/[-]/g, '\\-')}(?=[\\s,)])`, 'g');

function rewriteReferences(doc: MarkupDoc, from: string, to: string) {
  const swap = (v: unknown) => {
    if (typeof v !== 'string') return undefined;
    const next = v.replace(refPattern(from), `var(${to}`);
    return next === v ? undefined : next;
  };
  for (const node of doc.nodes.values()) {
    const styles = node.get('styles') as Y.Map<unknown>;
    for (const [k, v] of styles.entries()) {
      const next = swap(v);
      if (next !== undefined) styles.set(k, next);
    }
  }
  for (const m of tokensArr(doc)) {
    const next = swap(m.get('value'));
    if (next !== undefined) m.set('value', next);
  }
}

export function setTokens(doc: MarkupDoc, edits: TokenEdit[]): TokenResult[] {
  return edits.map((e) => {
    const idx = indexOf(doc, e.name);
    if (idx < 0) return { name: e.name, result: 'error', message: `Token ${e.name} does not exist.` };
    if (e.delete) {
      tokensArr(doc).delete(idx, 1);
      return { name: e.name, result: 'deleted' };
    }
    const error = validate({ name: e.newName ?? e.name, description: e.description });
    if (error) return { name: e.name, result: 'error', message: error };
    const m = tokensArr(doc).get(idx);
    if (e.value !== undefined) m.set('value', e.value);
    if (e.description !== undefined) {
      if (e.description) m.set('description', e.description);
      else m.delete('description');
    }
    if (e.newName && e.newName !== e.name) {
      m.set('name', e.newName);
      rewriteReferences(doc, e.name, e.newName);
    }
    return { name: e.name, result: 'updated' };
  });
}

export function resolveTokenValue(doc: MarkupDoc, value: string): string {
  const byName = new Map(listTokens(doc).map((t) => [t.name, String(t.value)]));
  let current = value.trim();
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(current);
    if (!m) return current;
    const next = byName.get(m[1]!) ?? m[2];
    if (next === undefined) return current;
    current = next.trim();
  }
  return current;
}

export interface TokenQuery {
  types?: TokenType[];
  namePattern?: string;
  format?: 'json' | 'css' | 'tailwind';
}

export function getTokens(doc: MarkupDoc, q: TokenQuery = {}): Token[] | string {
  const nameRe = q.namePattern ? wildcard(q.namePattern, 'i') : undefined;
  const all = listTokens(doc);
  const tokens = all.filter((t) => (!q.types || q.types.includes(t.type)) && (!nameRe || nameRe.test(t.name)));
  if (q.format === 'css') return `:root {\n${tokens.map((t) => `  ${t.name}: ${t.value};`).join('\n')}\n}`;
  if (q.format === 'tailwind') {
    const rename = new Map(all.map((t) => [t.name, tailwindName(t)]));
    const value = (v: string | number) => String(v).replace(/var\(\s*(--[\w-]+)/g, (s, n: string) => `var(${rename.get(n) ?? n}`);
    return `@theme {\n${tokens.map((t) => `  ${rename.get(t.name)}: ${value(t.value)};`).join('\n')}\n}`;
  }
  return tokens;
}

function tailwindName(t: Token): string {
  const ns = TAILWIND_NS[t.type];
  let base = t.name.slice(2);
  if (base.startsWith(`${ns}-`)) base = base.slice(ns.length + 1);
  return `--${ns}-${base}`;
}
