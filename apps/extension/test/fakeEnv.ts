import type { CaptureEnv } from '../src/capture/env';

/**
 * A layout-free CaptureEnv for jsdom: computed style comes from the element's inline `style` (plus tag defaults
 * and inheritance), pseudo-elements from `data-before` / `data-after`, rects from `data-rect="x y w h"`.
 */

const INHERITED = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-transform',
  'white-space',
  'visibility',
  'font-feature-settings',
  'font-variation-settings',
  'fill',
  'stroke',
];

const SIDES = ['top', 'right', 'bottom', 'left'];
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];

const BASE: Record<string, string> = {
  display: 'block',
  position: 'static',
  visibility: 'visible',
  color: 'rgb(0, 0, 0)',
  'font-family': 'Arial, sans-serif',
  'font-size': '16px',
  'font-weight': '400',
  'font-style': 'normal',
  'line-height': 'normal',
  'letter-spacing': 'normal',
  'text-align': 'start',
  'text-transform': 'none',
  'text-decoration-line': 'none',
  'white-space': 'normal',
  'font-feature-settings': 'normal',
  'font-variation-settings': 'normal',
  'background-color': 'rgba(0, 0, 0, 0)',
  'background-image': 'none',
  'background-size': 'auto',
  'background-position': '0% 0%',
  'background-repeat': 'repeat',
  opacity: '1',
  'overflow-x': 'visible',
  'overflow-y': 'visible',
  'box-shadow': 'none',
  filter: 'none',
  'backdrop-filter': 'none',
  'mix-blend-mode': 'normal',
  transform: 'none',
  'flex-direction': 'row',
  'flex-wrap': 'nowrap',
  'row-gap': 'normal',
  'column-gap': 'normal',
  'align-items': 'normal',
  'justify-content': 'normal',
  'align-self': 'auto',
  order: '0',
  float: 'none',
  content: 'normal',
  'z-index': 'auto',
  'object-fit': 'fill',
  'object-position': '50% 50%',
  'box-sizing': 'content-box',
  fill: 'rgb(0, 0, 0)',
  stroke: 'none',
  width: 'auto',
  height: 'auto',
  ...Object.fromEntries(SIDES.flatMap((s) => [
    [`margin-${s}`, '0px'],
    [`padding-${s}`, '0px'],
    [`border-${s}-width`, '0px'],
    [`border-${s}-style`, 'none'],
    [`border-${s}-color`, 'rgb(0, 0, 0)'],
    [s, 'auto'],
  ])),
  ...Object.fromEntries(CORNERS.map((c) => [`border-${c}-radius`, '0px'])),
};

const INLINE_TAGS = ['span', 'a', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'small', 'mark', 'sub', 'sup', 'br', 'label'];
const REPLACED = ['img', 'input', 'button', 'select', 'textarea', 'svg', 'canvas', 'video', 'iframe', 'picture'];

const TAG_DEFAULTS: Record<string, Record<string, string>> = {
  ...Object.fromEntries(INLINE_TAGS.map((t) => [t, { display: 'inline' }])),
  ...Object.fromEntries(REPLACED.map((t) => [t, { display: 'inline-block' }])),
  b: { display: 'inline', 'font-weight': '700' },
  strong: { display: 'inline', 'font-weight': '700' },
  i: { display: 'inline', 'font-style': 'italic' },
  em: { display: 'inline', 'font-style': 'italic' },
  u: { display: 'inline', 'text-decoration-line': 'underline' },
  s: { display: 'inline', 'text-decoration-line': 'line-through' },
  h1: { 'font-size': '32px', 'font-weight': '700' },
  head: { display: 'none' },
  script: { display: 'none' },
  style: { display: 'none' },
  source: { display: 'none' },
};

/** Splits on top-level semicolons. */
function decls(text: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  const push = () => {
    const i = cur.indexOf(':');
    if (i > 0) out.push([cur.slice(0, i).trim().toLowerCase(), cur.slice(i + 1).trim()]);
    cur = '';
  };
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) {
      push();
      continue;
    }
    cur += ch;
  }
  push();
  return out;
}

const fourSides = (v: string) => {
  const p = v.split(/\s+/);
  return [p[0]!, p[1] ?? p[0]!, p[2] ?? p[0]!, p[3] ?? p[1] ?? p[0]!];
};

function expand(key: string, value: string): [string, string][] {
  switch (key) {
    case 'margin':
    case 'padding':
      return fourSides(value).map((v, i) => [`${key}-${SIDES[i]}`, v]);
    case 'inset':
      return fourSides(value).map((v, i) => [SIDES[i]!, v]);
    case 'gap': {
      const [r, c] = value.split(/\s+/);
      return [['row-gap', r!], ['column-gap', c ?? r!]];
    }
    case 'overflow':
      return [['overflow-x', value], ['overflow-y', value]];
    case 'border': {
      const [w, s, ...c] = value.split(/\s+(?![^(]*\))/);
      return SIDES.flatMap((side) => [
        [`border-${side}-width`, w!],
        [`border-${side}-style`, s!],
        [`border-${side}-color`, c.join(' ') || 'rgb(0, 0, 0)'],
      ] as [string, string][]);
    }
    case 'border-radius':
      return CORNERS.map((c) => [`border-${c}-radius`, value]);
    case 'text-decoration':
      return [['text-decoration-line', value]];
    default:
      return [[key, value]];
  }
}

function own(raw: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of decls(raw ?? '')) for (const [kk, vv] of expand(k, v)) out[kk] = vv;
  return out;
}

const cache = new WeakMap<Element, Record<string, string>>();

function computed(el: Element): Record<string, string> {
  const hit = cache.get(el);
  if (hit) return hit;
  const parent = el.parentElement ? computed(el.parentElement) : BASE;
  const inherited = Object.fromEntries(INHERITED.map((k) => [k, parent[k]!]));
  const result = { ...BASE, ...inherited, ...TAG_DEFAULTS[el.tagName.toLowerCase()] };
  // SVG presentation attributes, with currentColor resolved like a browser does.
  const color = own(el.getAttribute('style')).color ?? result.color!;
  for (const a of ['fill', 'stroke']) {
    const v = el.getAttribute(a);
    if (v) result[a] = v === 'currentColor' ? color : v;
  }
  Object.assign(result, own(el.getAttribute('style')));
  cache.set(el, result);
  return result;
}

function decl(map: Record<string, string>): CSSStyleDeclaration {
  return { getPropertyValue: (p: string) => map[p] ?? '' } as unknown as CSSStyleDeclaration;
}

function rectOf(el: Element): DOMRect {
  const [x = 0, y = 0, w = 0, h = 0] = (el.getAttribute('data-rect') ?? '0 0 0 0').split(/\s+/).map(Number);
  return new DOMRect(x, y, w, h);
}

export function fakeEnv(images: Record<string, string | null> = {}): CaptureEnv & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    style(el, pseudo) {
      if (pseudo === '::before' || pseudo === '::after') {
        const raw = el.getAttribute(pseudo === '::before' ? 'data-before' : 'data-after');
        if (raw === null) return decl({ ...BASE, content: 'none' });
        const base = computed(el);
        const inherited = Object.fromEntries(INHERITED.map((k) => [k, base[k]!]));
        return decl({ ...BASE, ...inherited, display: 'inline', ...own(raw) });
      }
      if (pseudo === '::placeholder') return decl({ ...computed(el), color: 'rgb(117, 117, 117)' });
      return decl(computed(el));
    },
    rect: rectOf,
    async fetchImage(url) {
      fetched.push(url);
      return url in images ? images[url]! : null;
    },
  };
}
