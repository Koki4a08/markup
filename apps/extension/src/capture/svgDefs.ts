/**
 * SVG definitions a capture carries along. CSS `filter: url(#f)` (SVG filter effects: noise, goo, displacement,
 * duotone, glows) and `clip-path: url(#c)` point at elements elsewhere in the page; the capture copies each one
 * under a content-derived id into one hidden svg layer, and points the declaration at the copy. Inline svgs get
 * their outside references (shared gradients, filters, clip paths) copied in and their ids made unique, so
 * two pasted svgs that both define "gradient-1" no longer paint with each other's colours.
 */
import { hash } from './motion';

const SVG_NS = 'http://www.w3.org/2000/svg';
const REF = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;
/** The elements each CSS property may point at (Chrome applies these to HTML content). */
const TARGETS: Record<'filter' | 'clip-path', ReadonlySet<string>> = { filter: new Set(['filter']), 'clip-path': new Set(['clipPath']) };
/** Kinds an inline svg may reference from outside itself. */
const PAINT_SERVERS = new Set(['linearGradient', 'radialGradient', 'pattern', 'filter', 'clipPath', 'mask', 'marker', 'symbol', 'g', 'path']);
const MAX_PULLED = 50;

/** The element with this id where `owner` lives (its shadow root first), else in the document. */
function byId(owner: Node | null, id: string): Element | null {
  const root = owner?.getRootNode?.() as Document | ShadowRoot | undefined;
  const found = root && 'getElementById' in root ? root.getElementById(id) : null;
  return found ?? (owner?.ownerDocument ?? document).getElementById(id);
}

const hrefOf = (el: Element) => el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '';

/** Removes what a copied definition must not carry: script, event handlers, and anything that loads a file. */
function scrub(root: Element): void {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (/^(script|foreignObject|style)$/.test(el.localName)) {
      el.remove();
      continue;
    }
    if (/^(feImage|image|use)$/.test(el.localName) && !/^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i.test(hrefOf(el))) {
      el.remove();
      continue;
    }
    for (const a of Array.from(el.attributes)) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  }
}

export class SvgDefs {
  private readonly ids = new Map<Element, string>();
  private readonly markup: string[] = [];

  /**
   * A CSS filter or clip-path value with each url(#id) pointed at a copy kept with the capture; the value as is
   * when it has none, and null when a reference cannot be copied (an external file, a missing or wrong element).
   */
  rewrite(prop: 'filter' | 'clip-path', value: string, owner: Element | null): string | null {
    if (!/url\(/i.test(value)) return value;
    if (/url\(\s*(?!['"]?#)/i.test(value)) return null;
    let ok = true;
    const out = value.replace(REF, (_m, _q, id: string) => {
      const target = byId(owner, id);
      if (!target || !TARGETS[prop].has(target.localName)) {
        ok = false;
        return '';
      }
      return `url(#${this.add(target)})`;
    });
    return ok ? out : null;
  }

  private add(target: Element): string {
    const known = this.ids.get(target);
    if (known) return known;
    const clone = target.cloneNode(true) as Element;
    scrub(clone);
    clone.removeAttribute('id');
    const id = `mk-${target.localName.toLowerCase()}-${hash(clone.outerHTML)}`;
    clone.setAttribute('id', id);
    this.ids.set(target, id);
    this.markup.push(clone.outerHTML);
    return id;
  }

  /** The hidden layer holding every copied definition, or '' when the capture needed none. */
  html(): string {
    if (!this.markup.length) return '';
    return `<svg xmlns="${SVG_NS}" width="0" height="0" aria-hidden="true" layer-name="SVG effects" style="position:absolute;left:0px;top:0px;width:0px;height:0px;overflow:hidden;pointer-events:none"><defs>${this.markup.join('')}</defs></svg>`;
  }
}

/** The ids an element's attributes point at: url(#id) in any attribute (style included) and href="#id". */
function refs(el: Element): string[] {
  const out: string[] = [];
  for (const a of Array.from(el.attributes)) {
    for (const m of a.value.matchAll(REF)) out.push(m[2]!);
    if ((a.name === 'href' || a.name === 'xlink:href') && a.value.startsWith('#')) out.push(a.value.slice(1));
  }
  return out;
}

/**
 * Makes an inline svg copy self-contained and collision-free: what it references outside itself (a gradient or
 * filter in a shared hidden svg) is copied into its <defs>, then every id gets a prefix derived from the svg's
 * content and every reference follows.
 */
export function isolateSvgIds(clone: SVGSVGElement, original: SVGSVGElement): void {
  const doc = original.ownerDocument;
  const own = new Set(Array.from(clone.querySelectorAll('[id]')).map((e) => e.id));
  let defs: Element | null = null;
  const queue = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (let pulled = 0; queue.length && pulled < MAX_PULLED; ) {
    const el = queue.shift()!;
    for (const id of refs(el)) {
      if (own.has(id)) continue;
      const target = byId(original, id);
      if (!target || target.namespaceURI !== SVG_NS || !PAINT_SERVERS.has(target.localName) || target.contains(original)) continue;
      const copy = target.cloneNode(true) as Element;
      scrub(copy);
      if (!defs) {
        defs = doc.createElementNS(SVG_NS, 'defs');
        clone.insertBefore(defs, clone.firstChild);
      }
      defs.appendChild(copy);
      for (const n of [copy, ...Array.from(copy.querySelectorAll('[id]'))]) if (n.id) own.add(n.id);
      // A gradient can inherit its stops from another (href), so copies are scanned too.
      queue.push(copy, ...Array.from(copy.querySelectorAll('*')));
      pulled++;
    }
  }
  if (!own.size) return;
  const prefix = `mk${hash(clone.outerHTML)}-`;
  const all = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (const el of all) if (el.id) el.id = prefix + el.id;
  for (const el of all) {
    for (const a of Array.from(el.attributes)) {
      if (a.name === 'id') continue;
      let v = a.value.replace(REF, (m, _q, id: string) => (own.has(id) ? `url(#${prefix}${id})` : m));
      if ((a.name === 'href' || a.name === 'xlink:href') && v.startsWith('#') && own.has(v.slice(1))) v = `#${prefix}${v.slice(1)}`;
      if (v !== a.value) el.setAttribute(a.name, v);
    }
  }
}
