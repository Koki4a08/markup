/** Page-walking helpers shared by the simplified (serialize.ts) and exact (exact.ts) serializers. */
import type { CaptureEnv } from './env';
import { firstUrl } from './images';
import { isolateSvgIds } from './svgDefs';
import { get, hasPadding, isBoxy, num, styleAttr, type Decl } from './styles';

export const SNAPSHOT_MARKER = '<!--markup:snapshot v1-->';
/** On each snapshot root div; also how the capture skips Markup's own UI on the page. */
export const SNAPSHOT_ATTR = 'data-markup-snapshot';
/** On an exact snapshot root: the app parses it in the permissive `any` dialect. */
export const DIALECT_ATTR = 'data-markup-dialect';
/** On a snapshot root: the page's web fonts the capture uses, as @font-face rules with inlined files. */
export const FONTS_ATTR = 'data-markup-fonts';
/** On a snapshot root: the @keyframes its layers' animations use (stored in the file on paste). */
export const KEYFRAMES_ATTR = 'data-markup-keyframes';
export const TOO_LARGE = 'This page is too large to snapshot — pick a smaller element.';

/** Caps that keep a full-page capture from exhausting memory or the clipboard. */
export interface CaptureLimits {
  /** Elements serialised before giving up with TOO_LARGE. */
  maxNodes?: number;
  /** Total data-URL characters across all inlined images; images past it become placeholders. */
  imageBytes?: number;
  /** Image fetches in flight at once. */
  concurrency?: number;
}

export const DEFAULT_LIMITS: Required<CaptureLimits> = { maxNodes: 20_000, imageBytes: 40_000_000, concurrency: 6 };
/** Horizontal space between several captured targets. */
export const TARGET_GAP = 80;

/** Never rendered, or rendered by their parent. */
export const SKIP = new Set([
  'head', 'script', 'style', 'link', 'meta', 'title', 'base', 'template', 'noscript', 'source', 'track', 'param',
  'map', 'area', 'wbr', 'datalist', 'option', 'optgroup', 'colgroup', 'col',
]);
/** Inline formatting tags Markup keeps inside a text layer. */
export const INLINE = new Set(['span', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'br', 'code', 'sup', 'sub', 'small', 'mark']);
export const FIELDS = new Set(['input', 'textarea', 'select']);
const SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'use']);

export const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** ` layer-name="…" style="…"`, each only when present; unsafe declarations are already dropped by styleAttr. */
export const attrs = (decls: Decl[], name?: string) => {
  const style = styleAttr(decls);
  return `${name ? ` layer-name="${escAttr(name)}"` : ''}${style ? ` style="${escAttr(style)}"` : ''}`;
};
export const isText = (n: Node): n is Text => n.nodeType === 3;
export const isElement = (n: Node): n is Element => n.nodeType === 1;

/** Whether an element (with its computed style) is rendered at all. */
export function visible(cs: CSSStyleDeclaration): boolean {
  const visibility = get(cs, 'visibility');
  return get(cs, 'display') !== 'none' && visibility !== 'hidden' && visibility !== 'collapse';
}

/** Left out of every capture: never rendered, or Markup's own overlay. */
export const skipped = (el: Element) => SKIP.has(el.localName) || el.hasAttribute(SNAPSHOT_ATTR);

type StyleOf = (el: Element) => CSSStyleDeclaration;

const contentHidden = (el: Element, style?: StyleOf) =>
  el.getAttribute('hidden') === 'until-found' || (!!style && get(style(el), 'content-visibility') === 'hidden');

/**
 * The children the page renders for el (its flat-tree children): an open shadow root's content in place of the
 * light DOM, with each <slot> replaced by the nodes assigned to it, or by its fallback content when none are.
 */
export function renderedChildren(el: Element, style?: StyleOf): Node[] {
  // A closed <details> shows only its first <summary>; the rest sits in a content-visibility: hidden slot, so it
  // keeps its computed display and visibility (and its layout boxes) while the page paints none of it.
  if (el.localName === 'details' && !(el as HTMLDetailsElement).open) {
    const summary = Array.from(el.children).find((c) => c.localName === 'summary');
    return summary ? [summary] : [];
  }
  // content-visibility: hidden (also hidden="until-found") skips painting the contents, not the box itself.
  if (contentHidden(el, style)) return [];
  const out: Node[] = [];
  for (const n of Array.from((el.shadowRoot ?? el).childNodes)) {
    if (isElement(n) && n.localName === 'slot') {
      const assigned = typeof (n as HTMLSlotElement).assignedNodes === 'function' ? (n as HTMLSlotElement).assignedNodes({ flatten: true }) : [];
      out.push(...(assigned.length ? assigned : renderedChildren(n, style)));
    } else out.push(n);
  }
  return out;
}

/**
 * A self-contained copy of an inline svg: computed fill/stroke on shapes, currentColor resolved, event handlers,
 * scripts and foreignObject removed, sprite references and outside definitions inlined, ids made unique, and an
 * explicit pixel size. The caller sets style.
 */
export function cleanSvg(el: SVGSVGElement, env: CaptureEnv, width: number, height: number): SVGSVGElement {
  const clone = el.cloneNode(true) as SVGSVGElement;
  const originals = [el, ...Array.from(el.querySelectorAll('*'))];
  const copies = [clone, ...Array.from(clone.querySelectorAll('*'))];
  originals.forEach((orig, i) => {
    const copy = copies[i]!;
    const ocs = env.style(orig);
    const color = get(ocs, 'color');
    for (const a of Array.from(copy.attributes)) {
      if (/^on/i.test(a.name)) copy.removeAttribute(a.name);
      else if (/currentcolor/i.test(a.value) && color) copy.setAttribute(a.name, a.value.replace(/currentcolor/gi, color));
    }
    if (SHAPES.has(orig.localName)) {
      for (const prop of ['fill', 'stroke']) {
        const v = get(ocs, prop);
        // A gradient or pattern fill set by a stylesheet (which does not come along) becomes an attribute.
        const ref = /^url\(\s*['"]?#([^'")\s]+)/.exec(v)?.[1];
        if (ref) copy.setAttribute(prop, `url(#${ref})`);
        else if (v && !/url\(|currentcolor/i.test(v)) copy.setAttribute(prop, v);
      }
    }
  });
  inlineSprites(clone, el);
  isolateSvgIds(clone, el);
  clone.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  clone.removeAttribute('class');
  clone.setAttribute('width', String(Math.round(width * 100) / 100));
  clone.setAttribute('height', String(Math.round(height * 100) / 100));
  return clone;
}

/** `<use href="#icon">` pointing outside the svg (sprite sheets) is replaced by a copy of what it points at. */
function inlineSprites(clone: SVGSVGElement, original: SVGSVGElement): void {
  const doc = original.ownerDocument;
  // How many elements in the clone carry each id, kept up to date as <use>s are replaced, instead of rescanning
  // the clone for every <use>. Symbol children are copied with their ids, so later <use>s can find them.
  const ids = new Map<string, number>();
  const count = (root: Element, by: number) => {
    for (const n of [root, ...Array.from(root.querySelectorAll('[id]'))]) {
      if (n.hasAttribute('id')) ids.set(n.id, (ids.get(n.id) ?? 0) + by);
    }
  };
  for (const n of Array.from(clone.querySelectorAll('[id]'))) ids.set(n.id, (ids.get(n.id) ?? 0) + 1);
  for (const use of Array.from(clone.querySelectorAll('use'))) {
    const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    if (!href.startsWith('#')) continue;
    const id = href.slice(1);
    if ((ids.get(id) ?? 0) > 0) continue;
    const target = doc.getElementById(id);
    if (!target) continue;
    const ns = 'http://www.w3.org/2000/svg';
    const wrapper = doc.createElementNS(ns, target.localName === 'symbol' ? 'svg' : 'g');
    for (const a of ['fill', 'stroke', 'color', 'x', 'y', 'width', 'height', 'transform']) {
      const v = use.getAttribute(a);
      if (v && !(wrapper.localName === 'g' && /^(x|y|width|height)$/.test(a))) wrapper.setAttribute(a, v);
    }
    if (target.localName === 'symbol') {
      const vb = target.getAttribute('viewBox');
      if (vb) wrapper.setAttribute('viewBox', vb);
      for (const c of Array.from(target.childNodes)) wrapper.appendChild(c.cloneNode(true));
    } else {
      const copy = target.cloneNode(true) as Element;
      copy.removeAttribute('id');
      wrapper.appendChild(copy);
    }
    const color = use.getAttribute('fill') ?? use.getAttribute('color');
    wrapper.querySelectorAll('*').forEach((n) => {
      for (const a of Array.from(n.attributes)) if (/currentcolor/i.test(a.value) && color) n.setAttribute(a.name, a.value.replace(/currentcolor/gi, color));
    });
    count(use, -1);
    use.replaceWith(wrapper);
    count(wrapper, 1);
  }
}

export interface PseudoInfo {
  which: '::before' | '::after';
  /** The element the pseudo-element belongs to. */
  owner: Element;
  cs: CSSStyleDeclaration;
  /** The text of the content property (strings and attr() values). */
  text: string;
  /** The first url() in the content property. */
  image: string | null;
  absolute: boolean;
  boxy: boolean;
  /** Plain inline text: merges into the owner's text layer as a span. */
  inline: boolean;
}

/** A ::before / ::after that renders something: text, an image, or a sized box of its own. */
export function readPseudo(env: CaptureEnv, el: Element, which: '::before' | '::after'): PseudoInfo | null {
  const cs = env.style(el, which);
  const content = get(cs, 'content');
  if (!content || content === 'none' || content === 'normal' || get(cs, 'display') === 'none') return null;
  let text = '';
  for (const m of content.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)/g)) {
    text += m[3] ? (el.getAttribute(m[3]) ?? '') : (m[1] ?? m[2] ?? '').replace(/\\(.)/g, '$1');
  }
  const image = /url\(/i.test(content) ? firstUrl(content) : null;
  const absolute = /^(absolute|fixed)$/.test(get(cs, 'position'));
  const boxy = isBoxy(cs) || hasPadding(cs);
  const sized = num(get(cs, 'width')) > 0 && num(get(cs, 'height')) > 0;
  if (!text.trim() && !image && !(boxy && sized)) return null;
  const inline = !!text.trim() && !image && !absolute && !boxy && get(cs, 'display') === 'inline';
  return { which, owner: el, cs, text, image, absolute, boxy, inline };
}

/** What a form field shows: a check box, or a line (or block) of text, possibly its placeholder. */
export type FieldContent =
  | { kind: 'check'; type: 'checkbox' | 'radio'; checked: boolean }
  | { kind: 'text'; text: string; placeholder: boolean; multiline: boolean; button: boolean };

export function fieldContent(el: HTMLInputElement): FieldContent {
  const tag = el.localName;
  const type = tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : tag;
  if (type === 'checkbox' || type === 'radio') return { kind: 'check', type, checked: el.checked };
  const button = /^(submit|button|reset)$/.test(type);
  let text = '';
  let placeholder = false;
  if (tag === 'select') text = (el as unknown as HTMLSelectElement).selectedOptions?.[0]?.text ?? '';
  else if (type === 'password') text = '•'.repeat(el.value.length);
  else if (button) text = el.value || (type === 'reset' ? 'Reset' : type === 'submit' ? 'Submit' : '');
  else text = el.value;
  if (!text && el.getAttribute('placeholder')) {
    text = el.getAttribute('placeholder')!;
    placeholder = true;
  }
  return { kind: 'text', text, placeholder, multiline: tag === 'textarea', button };
}

/** The host an embedded frame shows, used as its placeholder label. */
export function embedHost(el: Element): string {
  const src = el.getAttribute('src') ?? el.getAttribute('data') ?? '';
  try {
    return new URL(src, el.ownerDocument.baseURI).host || el.localName;
  } catch {
    return el.localName;
  }
}

const isOpaque = (color: string) => !!color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color.replace(/\s+/g, ' '));

/**
 * The colour the target sits on in the page: its nearest ancestor with a background (the root of a whole-page
 * capture uses the html/body background, which CSS paints on the canvas). White when nothing is opaque.
 */
export function backdrop(target: Element, env: CaptureEnv): string {
  const doc = target.ownerDocument;
  const chain: Element[] = [];
  if (target === doc.documentElement) chain.push(doc.documentElement, ...(doc.body ? [doc.body] : []));
  else for (let a = target.parentElement; a; a = a.parentElement) chain.push(a);
  for (const el of chain) {
    const color = get(env.style(el), 'background-color');
    if (isOpaque(color)) return color;
  }
  return 'rgb(255, 255, 255)';
}

/** The snapshot root's layer name: the page title, else its host. */
export function snapshotName(meta: { title: string; url: string }): string {
  let host = '';
  try {
    host = new URL(meta.url).host;
  } catch {
    // Not a URL.
  }
  return meta.title.trim() || host || 'Snapshot';
}

/** The opening tag of a target written as a frame: `<div`, its attributes (values escaped, so no raw quote), `>`. */
const OPEN_DIV = /^<div((?: [\w-]+="[^"]*")*)>/;

/**
 * A lone capture target as the snapshot root itself, so no empty frame wraps it: its opening tag gets `marks`
 * (the snapshot attributes), `name` unless it has a layer-name of its own, and `decls` ahead of its own styles
 * (which win); `defs` goes in first. Null when the target is not written as a div.
 */
export function targetAsRoot(html: string, marks: string, name: string, decls: Decl[], defs: string): string | null {
  const open = OPEN_DIV.exec(html);
  if (!open) return null;
  let tag = open[1]!;
  if (!tag.includes(' layer-name="')) tag = ` layer-name="${escAttr(name)}"${tag}`;
  const extra = escAttr(styleAttr(decls));
  if (extra) tag = tag.includes(' style="') ? tag.replace(' style="', ` style="${extra};`) : `${tag} style="${extra}"`;
  return `<div ${marks}${tag}>${defs}${html.slice(open[0].length)}`;
}
