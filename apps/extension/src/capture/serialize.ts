import type { CaptureEnv } from './env';
import { backgroundDecls, firstUrl, ImageLoader, PLACEHOLDER_COLOR, PLACEHOLDER_NAME } from './images';
import {
  borders,
  boxDecls,
  clips,
  flexDecls,
  get,
  hasPadding,
  inlineDecls,
  isBoxy,
  num,
  padding,
  paddingDecls,
  px,
  rotation,
  SIDES,
  styleAttr,
  textDecls,
  textWidth,
  type Decl,
} from './styles';

export const SNAPSHOT_MARKER = '<!--markup:snapshot v1-->';
/** On each snapshot root div; also how the capture skips Markup's own UI on the page. */
export const SNAPSHOT_ATTR = 'data-markup-snapshot';
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
const TARGET_GAP = 80;

/** Never rendered, or rendered by their parent. */
const SKIP = new Set([
  'head', 'script', 'style', 'link', 'meta', 'title', 'base', 'template', 'noscript', 'source', 'track', 'param',
  'map', 'area', 'wbr', 'datalist', 'option', 'optgroup', 'colgroup', 'col',
]);
/** Inline formatting tags Markup keeps inside a text layer. */
const INLINE = new Set(['span', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'br', 'code', 'sup', 'sub', 'small', 'mark']);
const SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'use']);
const FIELDS = new Set(['input', 'textarea', 'select']);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a child sits in its parent frame: in flex flow, or absolutely from the parent's padding-box origin. */
type Mode = { flow: true } | { flow: false; x: number; y: number };

type Item = { el: Element } | { run: Node[] };

interface PseudoInfo {
  which: '::before' | '::after';
  cs: CSSStyleDeclaration;
  text: string;
  image: string | null;
  absolute: boolean;
  boxy: boolean;
  /** Plain inline text: merges into the owner's text layer as a span. */
  inline: boolean;
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const attrs = (decls: Decl[], name?: string) => {
  const style = styleAttr(decls);
  return `${name ? ` layer-name="${escAttr(name)}"` : ''}${style ? ` style="${escAttr(style)}"` : ''}`;
};
const isText = (n: Node): n is Text => n.nodeType === 3;
const isElement = (n: Node): n is Element => n.nodeType === 1;

/**
 * The children the page renders for el (its flat-tree children): an open shadow root's content in place of the
 * light DOM, with each <slot> replaced by the nodes assigned to it, or by its fallback content when none are.
 */
function renderedChildren(el: Element): Node[] {
  const out: Node[] = [];
  for (const n of Array.from((el.shadowRoot ?? el).childNodes)) {
    if (isElement(n) && n.localName === 'slot') {
      const assigned = typeof (n as HTMLSlotElement).assignedNodes === 'function' ? (n as HTMLSlotElement).assignedNodes({ flatten: true }) : [];
      out.push(...(assigned.length ? assigned : renderedChildren(n)));
    } else out.push(n);
  }
  return out;
}

class Serializer {
  readonly images: ImageLoader;
  private nodes = 0;

  constructor(
    readonly env: CaptureEnv,
    readonly limits: Required<CaptureLimits>,
  ) {
    this.images = new ImageLoader(env, limits);
  }

  /** The element's border box in page coordinates, un-rotated when it carries a rotation. */
  box(el: Element, cs: CSSStyleDeclaration): Box {
    const r = this.env.rect(el);
    const box = { x: r.x, y: r.y, w: r.width, h: r.height };
    if (!rotation(cs)) return box;
    const p = padding(cs);
    const b = borders(cs);
    const extra = get(cs, 'box-sizing') === 'border-box' ? [0, 0] : [p.left + p.right + b.left + b.right, p.top + p.bottom + b.top + b.bottom];
    const w = num(get(cs, 'width')) + extra[0]!;
    const h = num(get(cs, 'height')) + extra[1]!;
    if (!w || !h) return box;
    return { x: r.x + r.width / 2 - w / 2, y: r.y + r.height / 2 - h / 2, w, h };
  }

  /** Where absolutely placed children measure from: the padding box. */
  origin(box: Box, cs: CSSStyleDeclaration): Mode {
    const b = borders(cs);
    return { flow: false, x: box.x + b.left, y: box.y + b.top };
  }

  content(box: Box, cs: CSSStyleDeclaration): Box {
    const b = borders(cs);
    const p = padding(cs);
    return {
      x: box.x + b.left + p.left,
      y: box.y + b.top + p.top,
      w: Math.max(0, box.w - b.left - b.right - p.left - p.right),
      h: Math.max(0, box.h - b.top - b.bottom - p.top - p.bottom),
    };
  }

  place(box: Box, mode: Mode, cs?: CSSStyleDeclaration): Decl[] {
    if (mode.flow) {
      const self = cs ? get(cs, 'align-self') : '';
      return self && self !== 'auto' ? [['flex-shrink', '0'], ['align-self', self]] : [['flex-shrink', '0']];
    }
    const out: Decl[] = [['position', 'absolute'], ['left', px(box.x - mode.x)], ['top', px(box.y - mode.y)]];
    const z = cs ? get(cs, 'z-index') : '';
    if (cs && z && z !== 'auto' && get(cs, 'position') !== 'static') out.push(['z-index', z]);
    return out;
  }

  size(box: Box): Decl[] {
    return [['width', px(box.w)], ['height', px(box.h)]];
  }

  async frameDecls(box: Box, mode: Mode, cs: CSSStyleDeclaration): Promise<Decl[]> {
    return [...this.place(box, mode, cs), ...this.size(box), ...boxDecls(cs), ...(await backgroundDecls(cs, this.images))];
  }

  visible(el: Element, cs: CSSStyleDeclaration): boolean {
    const display = get(cs, 'display');
    const visibility = get(cs, 'visibility');
    return display !== 'none' && visibility !== 'hidden' && visibility !== 'collapse';
  }

  async node(el: Element, mode: Mode): Promise<string> {
    const tag = el.localName;
    if (SKIP.has(tag) || el.hasAttribute(SNAPSHOT_ATTR)) return '';
    if (++this.nodes > this.limits.maxNodes) throw new Error(TOO_LARGE);
    const cs = this.env.style(el);
    if (!this.visible(el, cs)) return '';
    if (get(cs, 'display') === 'contents') return (await Promise.all(this.items(el).map((i) => this.item(i, el, cs, mode, null)))).join('');
    const box = this.box(el, cs);
    if ((box.w <= 0 || box.h <= 0) && clips(cs)) return '';

    switch (tag) {
      case 'img':
        return this.image((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || '', el, cs, box, mode);
      case 'picture': {
        const img = el.querySelector('img');
        return img ? this.node(img, mode) : '';
      }
      case 'svg':
        return this.svg(el as SVGSVGElement, cs, box, mode);
      case 'canvas':
        return this.canvas(el as HTMLCanvasElement, cs, box, mode);
      case 'video':
        return this.video(el as HTMLVideoElement, cs, box, mode);
      case 'iframe':
      case 'embed':
      case 'object':
        return this.embed(el, cs, box, mode);
    }
    if (FIELDS.has(tag)) return this.field(el as HTMLInputElement, cs, box, mode);
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return '';
    return this.element(el, cs, box, mode);
  }

  // ── Generic elements ──────────────────────────────────────────────────────────────────────────────

  /** Rendered children: element items and runs of text + plain inline formatting. `display: contents` is flattened. */
  items(el: Element): Item[] {
    const out: Item[] = [];
    let run: Node[] = [];
    const flush = () => {
      if (run.length) out.push({ run });
      run = [];
    };
    for (const child of renderedChildren(el)) {
      if (isText(child)) {
        run.push(child);
        continue;
      }
      if (!isElement(child) || SKIP.has(child.localName) || child.hasAttribute(SNAPSHOT_ATTR)) continue;
      const cs = this.env.style(child);
      if (!this.visible(child, cs)) continue;
      if (this.inlineFormatting(child, cs)) {
        run.push(child);
        continue;
      }
      flush();
      out.push({ el: child });
    }
    flush();
    return out;
  }

  /** An inline tag with no box of its own and only inline content: it stays inside a text layer. */
  inlineFormatting(el: Element, cs: CSSStyleDeclaration): boolean {
    if (!INLINE.has(el.localName) || get(cs, 'display') !== 'inline') return false;
    if (el.localName === 'br') return true;
    if (isBoxy(cs) || hasPadding(cs)) return false;
    for (const c of renderedChildren(el)) {
      if (isText(c)) continue;
      if (!isElement(c)) continue;
      const ccs = this.env.style(c);
      if (!this.visible(c, ccs)) continue;
      if (!this.inlineFormatting(c, ccs)) return false;
    }
    return true;
  }

  pseudo(el: Element, which: '::before' | '::after'): PseudoInfo | null {
    const cs = this.env.style(el, which);
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
    return { which, cs, text, image, absolute, boxy, inline };
  }

  async element(el: Element, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    const items = this.items(el);
    const pseudos = [this.pseudo(el, '::before'), this.pseudo(el, '::after')];
    const runs = items.filter((i): i is { run: Node[] } => 'run' in i);
    const textOnly = runs.length === items.length && pseudos.every((p) => !p || p.inline);
    if (textOnly) {
      const inner = this.textLeafHtml(runs[0]?.run ?? [], cs, pseudos);
      if (inner) return this.textLeaf(el, cs, box, mode, runs[0]?.run ?? [], inner);
    }

    const flex = this.flexOk(el, cs, items, pseudos);
    const childMode: Mode = flex ? { flow: true } : this.origin(box, cs);
    const decls = await this.frameDecls(box, mode, cs);
    const [before, after] = pseudos;
    const children = await Promise.all([
      before ? this.pseudoNode(before, el, cs, box, childMode) : '',
      ...items.map((i) => this.item(i, el, cs, childMode, box)),
      after ? this.pseudoNode(after, el, cs, box, childMode) : '',
    ]);
    if (flex) decls.push(...flexDecls(cs));
    // In a flex parent the frame is in flow; it still has to anchor its absolutely placed children.
    else if (mode.flow && children.some(Boolean)) decls.splice(0, 0, ['position', 'relative']);
    return `<div${attrs(decls)}>${children.join('')}</div>`;
  }

  item(item: Item, parent: Element, parentCs: CSSStyleDeclaration, mode: Mode, parentBox: Box | null): Promise<string> {
    if ('el' in item) return this.node(item.el, mode);
    return Promise.resolve(this.runNode(item.run, parent, parentCs, mode, parentBox));
  }

  /** Flex layout survives when every child sits in flow with no margins, offsets, floats or reordering. */
  flexOk(el: Element, cs: CSSStyleDeclaration, items: Item[], pseudos: (PseudoInfo | null)[]): boolean {
    if (!/^(inline-)?flex$/.test(get(cs, 'display'))) return false;
    if (pseudos.some((p) => p?.absolute)) return false;
    if (renderedChildren(el).filter(isElement).some((c) => this.skippedInFlow(c))) return false;
    return items.every((i) => {
      if ('run' in i) return true;
      const c = this.env.style(i.el);
      if (SIDES.some((s) => num(get(c, `margin-${s}`)) !== 0)) return false;
      const pos = get(c, 'position');
      if (pos === 'absolute' || pos === 'fixed') return false;
      if ((pos === 'relative' || pos === 'sticky') && SIDES.some((s) => num(get(c, s)) !== 0)) return false;
      const order = get(c, 'order');
      if (order && order !== '0') return false;
      const float = get(c, 'float');
      return !float || float === 'none';
    });
  }

  /** A child left out of the output that still takes space (and a gap) in its parent's flow. */
  skippedInFlow(el: Element): boolean {
    if (SKIP.has(el.localName) || el.hasAttribute(SNAPSHOT_ATTR)) return false;
    const cs = this.env.style(el);
    const display = get(cs, 'display');
    if (display === 'none' || display === 'contents' || /^(absolute|fixed)$/.test(get(cs, 'position'))) return false;
    if (!this.visible(el, cs)) return true;
    const r = this.env.rect(el);
    return (r.width <= 0 || r.height <= 0) && clips(cs);
  }

  // ── Text ──────────────────────────────────────────────────────────────────────────────────────────

  /** Inner HTML of a text layer: text with inline formatting, computed differences inlined on each span. */
  inlineHtml(nodes: Node[], base: CSSStyleDeclaration): string {
    const ws = get(base, 'white-space');
    const pre = /^(pre|pre-wrap|break-spaces)$/.test(ws);
    const preLine = ws === 'pre-line';
    let out = '';
    for (const n of nodes) {
      if (isText(n)) {
        let t = n.data;
        if (!pre) t = preLine ? t.replace(/[ \t\f\r]+/g, ' ') : t.replace(/[ \t\n\f\r]+/g, ' ');
        out += escText(t).replace(/\n/g, '<br>');
        continue;
      }
      if (!isElement(n)) continue;
      const tag = n.localName;
      if (tag === 'br') {
        out += '<br>';
        continue;
      }
      const cs = this.env.style(n);
      if (!this.visible(n, cs)) continue;
      const name = INLINE.has(tag) ? tag : 'span';
      out += `<${name}${attrs(inlineDecls(cs, base))}>${this.inlineHtml(renderedChildren(n), base)}</${name}>`;
    }
    return out;
  }

  textLeafHtml(run: Node[], cs: CSSStyleDeclaration, pseudos: (PseudoInfo | null)[]): string {
    const body = this.inlineHtml(run, cs);
    const [before, after] = pseudos.map((p) => (p ? `<span${attrs(inlineDecls(p.cs, cs))}>${escText(p.text)}</span>` : ''));
    const plain = (body + (before ?? '') + (after ?? '')).replace(/<[^>]*>/g, '').trim();
    if (!plain) return '';
    return trimHtml(`${before}${body}${after}`);
  }

  /**
   * Where a run's text is: measured when the env can, else the parent's content box. A loose run (text after an
   * inline-level sibling) keeps its measured left edge; a whole-element text leaf spans the content box so its
   * text-align still applies.
   */
  textBox(run: Node[], cs: CSSStyleDeclaration, box: Box, loose = false): Box {
    const content = this.content(box, cs);
    const r = this.env.textRect?.(run) ?? null;
    if (!r) {
      const rects = run.filter(isElement).map((e) => this.env.rect(e)).filter((x) => x.width > 0 && x.height > 0);
      if (!rects.length) return content;
      const x = Math.min(...rects.map((q) => q.x));
      const y = Math.min(...rects.map((q) => q.y));
      return { x, y, w: Math.max(...rects.map((q) => q.right)) - x, h: Math.max(...rects.map((q) => q.bottom)) - y };
    }
    if (/flex|grid/.test(get(cs, 'display'))) return { x: r.x, y: r.y, w: r.width, h: r.height };
    if (!loose) return { x: content.x, y: r.y, w: content.w, h: r.height };
    if (/^(center|right|end|-webkit-center|-webkit-right)$/.test(get(cs, 'text-align'))) return { x: r.x, y: r.y, w: r.width, h: r.height };
    // A wrapping run's box already starts at the content edge, so this only narrows runs that start mid-line.
    return { x: r.x, y: r.y, w: Math.max(r.width, content.x + content.w - r.x), h: r.height };
  }

  async textLeaf(el: Element, cs: CSSStyleDeclaration, box: Box, mode: Mode, run: Node[], inner: string): Promise<string> {
    const measured = this.env.textRect?.(run) ?? null;
    const shifted = mode.flow && measured && Math.abs(measured.height - box.h) > 1;
    if (!isBoxy(cs) && !hasPadding(cs) && !shifted) {
      const at = mode.flow ? box : this.textBox(run, cs, box);
      const decls: Decl[] = [...this.place(at, mode, cs), ['width', textWidth(at.w)], ...boxDecls(cs), ...textDecls(cs)];
      return `<p${attrs(decls)}>${inner}</p>`;
    }
    const decls = await this.frameDecls(box, mode, cs);
    if (mode.flow) decls.splice(0, 0, ['position', 'relative']);
    const at = this.textBox(run, cs, box);
    const p: Decl[] = [...this.place(at, this.origin(box, cs)), ['width', textWidth(at.w)], ...textDecls(cs)];
    return `<div${attrs(decls, el.getAttribute('aria-label') ?? undefined)}><p${attrs(p)}>${inner}</p></div>`;
  }

  /** Loose text between boxes inside a container. */
  runNode(run: Node[], parent: Element, cs: CSSStyleDeclaration, mode: Mode, parentBox: Box | null): string {
    const inner = trimHtml(this.inlineHtml(run, cs));
    if (!inner.replace(/<[^>]*>/g, '').trim()) return '';
    const box = parentBox ?? this.box(parent, cs);
    const measured = this.env.textRect?.(run) ?? null;
    const at = this.textBox(run, cs, box, true);
    const decls: Decl[] = mode.flow
      ? [['flex-shrink', '0'], ...(measured ? ([['width', textWidth(at.w)]] as Decl[]) : []), ...textDecls(cs)]
      : [...this.place(at, mode), ['width', textWidth(at.w)], ...textDecls(cs)];
    return `<p${attrs(decls)}>${inner}</p>`;
  }

  // ── Pseudo-elements ───────────────────────────────────────────────────────────────────────────────

  pseudoBox(p: PseudoInfo, cs: CSSStyleDeclaration, box: Box): Box {
    const pcs = p.cs;
    const w = num(get(pcs, 'width'));
    const h = num(get(pcs, 'height'));
    const b = borders(cs);
    const pad = { x: box.x + b.left, y: box.y + b.top, w: box.w - b.left - b.right, h: box.h - b.top - b.bottom };
    if (p.absolute) {
      const side = (a: string, z: string, extent: number, size: number) => {
        const va = get(pcs, a);
        if (va && va !== 'auto') return num(va);
        const vz = get(pcs, z);
        return vz && vz !== 'auto' ? extent - num(vz) - size : 0;
      };
      return { x: pad.x + side('left', 'right', pad.w, w), y: pad.y + side('top', 'bottom', pad.h, h), w, h };
    }
    const c = this.content(box, cs);
    return p.which === '::before' ? { x: c.x, y: c.y, w, h } : { x: c.x, y: c.y + c.h - h, w, h };
  }

  async pseudoNode(p: PseudoInfo, el: Element, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    const at = this.pseudoBox(p, cs, box);
    const sized = at.w > 0 && at.h > 0;
    if (p.image) {
      const data = await this.images.get(p.image);
      if (!data || !sized) return '';
      return `<img src="${data}"${attrs([...this.place(at, mode, p.cs), ...this.size(at), ...boxDecls(p.cs)])}>`;
    }
    const text = escText(p.text.trim());
    if (!p.boxy) {
      const decls: Decl[] = [...this.place(at, mode, p.cs), ...(at.w > 0 ? ([['width', textWidth(at.w)]] as Decl[]) : []), ...textDecls(p.cs)];
      return `<p${attrs(decls)}>${text}</p>`;
    }
    const decls: Decl[] = [
      ...this.place(at, mode, p.cs),
      ...(sized ? this.size(at) : []),
      ...boxDecls(p.cs),
      ...(await backgroundDecls(p.cs, this.images)),
      ...(text ? [['display', 'flex'] as Decl, ...paddingDecls(p.cs)] : []),
    ];
    return `<div${attrs(decls)}>${text ? `<p${attrs([['flex-shrink', '0'], ...textDecls(p.cs)])}>${text}</p>` : ''}</div>`;
  }

  // ── Replaced elements ─────────────────────────────────────────────────────────────────────────────

  placeholder(box: Box, mode: Mode, cs: CSSStyleDeclaration): string {
    const decls: Decl[] = [...this.place(box, mode, cs), ...this.size(box), ...boxDecls(cs).filter(([k]) => k !== 'background-color'), ['background-color', PLACEHOLDER_COLOR]];
    return `<div${attrs(decls, PLACEHOLDER_NAME)}></div>`;
  }

  imageTag(data: string, el: Element, cs: CSSStyleDeclaration, box: Box, mode: Mode): string {
    const decls: Decl[] = [...this.place(box, mode, cs), ...this.size(box), ...boxDecls(cs)];
    const fit = get(cs, 'object-fit');
    if (fit && fit !== 'fill') decls.push(['object-fit', fit]);
    const pos = get(cs, 'object-position');
    if (pos && pos !== '50% 50%') decls.push(['object-position', pos]);
    const alt = el.getAttribute('alt')?.trim();
    return `<img src="${data}"${attrs(decls, alt || undefined)}>`;
  }

  async image(src: string, el: Element, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    const data = src ? await this.images.get(src) : null;
    return data ? this.imageTag(data, el, cs, box, mode) : this.placeholder(box, mode, cs);
  }

  canvas(el: HTMLCanvasElement, cs: CSSStyleDeclaration, box: Box, mode: Mode): string {
    let data: string | null = null;
    try {
      data = el.toDataURL('image/png');
    } catch {
      // Tainted by cross-origin content.
    }
    data = this.images.admit(data);
    return data ? this.imageTag(data, el, cs, box, mode) : this.placeholder(box, mode, cs);
  }

  async video(el: HTMLVideoElement, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    let data: string | null = null;
    if (el.readyState >= 2 && el.videoWidth) {
      try {
        const c = el.ownerDocument.createElement('canvas');
        c.width = el.videoWidth;
        c.height = el.videoHeight;
        c.getContext('2d')?.drawImage(el, 0, 0);
        data = c.toDataURL('image/png');
      } catch {
        data = null;
      }
    }
    data = this.images.admit(data);
    if (!data && el.poster) data = await this.images.get(el.poster);
    return data ? this.imageTag(data, el, cs, box, mode) : this.placeholder(box, mode, cs);
  }

  svg(el: SVGSVGElement, cs: CSSStyleDeclaration, box: Box, mode: Mode): string {
    const clone = el.cloneNode(true) as SVGSVGElement;
    const originals = [el, ...Array.from(el.querySelectorAll('*'))];
    const copies = [clone, ...Array.from(clone.querySelectorAll('*'))];
    originals.forEach((orig, i) => {
      const copy = copies[i]!;
      const ocs = this.env.style(orig);
      const color = get(ocs, 'color');
      for (const a of Array.from(copy.attributes)) {
        if (/^on/i.test(a.name)) copy.removeAttribute(a.name);
        else if (/currentcolor/i.test(a.value) && color) copy.setAttribute(a.name, a.value.replace(/currentcolor/gi, color));
      }
      if (SHAPES.has(orig.localName)) {
        for (const prop of ['fill', 'stroke']) {
          const v = get(ocs, prop);
          if (v && !/url\(|currentcolor/i.test(v)) copy.setAttribute(prop, v);
        }
      }
    });
    this.inlineSprites(clone, el);
    clone.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
    clone.removeAttribute('class');
    clone.setAttribute('width', String(Math.round(box.w * 100) / 100));
    clone.setAttribute('height', String(Math.round(box.h * 100) / 100));
    const style = styleAttr([...this.place(box, mode, cs), ...this.size(box), ...boxDecls(cs).filter(([k]) => k !== 'overflow')]);
    if (style) clone.setAttribute('style', style);
    else clone.removeAttribute('style');
    return clone.outerHTML;
  }

  /** `<use href="#icon">` pointing outside the svg (sprite sheets) is replaced by a copy of what it points at. */
  inlineSprites(clone: SVGSVGElement, original: SVGSVGElement): void {
    const doc = original.ownerDocument;
    for (const use of Array.from(clone.querySelectorAll('use'))) {
      const href = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
      if (!href.startsWith('#')) continue;
      const id = href.slice(1);
      if (Array.from(clone.querySelectorAll('[id]')).some((n) => n.id === id)) continue;
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
      use.replaceWith(wrapper);
    }
  }

  async field(el: HTMLInputElement, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    const tag = el.localName;
    const type = tag === 'input' ? (el.getAttribute('type') ?? 'text').toLowerCase() : tag;
    const decls = await this.frameDecls(box, mode, cs);
    if (type === 'checkbox' || type === 'radio') {
      if (!isBoxy(cs)) {
        decls.push(['border-top', '1px solid #767676'], ['border-right', '1px solid #767676'], ['border-bottom', '1px solid #767676'], ['border-left', '1px solid #767676']);
        decls.push(['border-radius', type === 'radio' ? '50%' : '3px'], ['background-color', el.checked ? '#2563eb' : '#ffffff']);
      }
      return `<div${attrs(decls, type)}></div>`;
    }
    let text = '';
    let placeholder = false;
    if (tag === 'select') text = (el as unknown as HTMLSelectElement).selectedOptions?.[0]?.text ?? '';
    else if (type === 'password') text = '•'.repeat(el.value.length);
    else if (/^(submit|button|reset)$/.test(type)) text = el.value || (type === 'reset' ? 'Reset' : type === 'submit' ? 'Submit' : '');
    else text = el.value;
    if (!text && el.getAttribute('placeholder')) {
      text = el.getAttribute('placeholder')!;
      placeholder = true;
    }
    const multiline = tag === 'textarea';
    decls.push(['display', 'flex'], ['align-items', multiline ? 'flex-start' : 'center'], ...paddingDecls(cs));
    if (/^(submit|button|reset)$/.test(type)) decls.push(['justify-content', 'center']);
    if (!decls.some(([k]) => k === 'overflow')) decls.push(['overflow', 'hidden']);
    const tcs = placeholder ? this.env.style(el, '::placeholder') : cs;
    const content = this.content(box, cs);
    const p: Decl[] = [['flex-shrink', '0'], ['width', textWidth(content.w)], ...textDecls(tcs).filter(([k]) => k !== 'white-space'), ['white-space', multiline ? 'pre-wrap' : 'nowrap']];
    const inner = text ? `<p${attrs(p)}>${escText(text).replace(/\r?\n/g, '<br>')}</p>` : '';
    return `<div${attrs(decls, el.getAttribute('name') || el.getAttribute('aria-label') || undefined)}>${inner}</div>`;
  }

  embed(el: Element, cs: CSSStyleDeclaration, box: Box, mode: Mode): string {
    const src = el.getAttribute('src') ?? el.getAttribute('data') ?? '';
    let host = el.localName;
    try {
      host = new URL(src, el.ownerDocument.baseURI).host || host;
    } catch {
      // Keep the tag name.
    }
    const decls: Decl[] = [
      ...this.place(box, mode, cs),
      ...this.size(box),
      ...boxDecls(cs).filter(([k]) => k !== 'background-color' && k !== 'overflow'),
      ['background-color', PLACEHOLDER_COLOR],
      ['display', 'flex'],
      ['align-items', 'center'],
      ['justify-content', 'center'],
      ['overflow', 'hidden'],
    ];
    const p: Decl[] = [['flex-shrink', '0'], ['color', '#71717a'], ['font-family', 'system-ui'], ['font-size', '12px']];
    return `<div${attrs(decls, host)}><p${attrs(p)}>${escText(host)}</p></div>`;
  }
}

/** Trims whitespace at both ends of inline HTML, including whitespace just inside leading/trailing tags. */
function trimHtml(html: string): string {
  return html.replace(/^((?:<[^>]+>)*)\s+/, '$1').replace(/\s+((?:<\/[^>]+>)*)$/, '$1').trim();
}

/**
 * Serialises page elements as Markup-dialect HTML: a snapshot marker, then one root frame (named after the page,
 * tagged with its URL) holding each target side by side, 80px apart.
 */
export async function capture(
  targets: Element[] | 'page',
  env: CaptureEnv,
  meta: { title: string; url: string },
  limits: CaptureLimits = {},
): Promise<string> {
  const els = targets === 'page' ? [document.documentElement] : targets;
  if (els.length === 0) throw new Error('Nothing to capture');
  const s = new Serializer(env, { ...DEFAULT_LIMITS, ...limits });
  const boxes = els.map((el) => s.box(el, env.style(el)));
  let left = 0;
  const modes: Mode[] = boxes.map((b) => {
    const mode: Mode = { flow: false, x: b.x - left, y: b.y };
    left += b.w + TARGET_GAP;
    return mode;
  });
  const parts = await Promise.all(els.map((el, i) => s.node(el, modes[i]!)));
  if (!parts.some(Boolean)) throw new Error('Nothing to capture: the selection is hidden or empty');
  const width = Math.max(0, left - TARGET_GAP);
  const height = Math.max(0, ...boxes.map((b) => b.h));
  const root = styleAttr([['position', 'relative'], ['width', px(width)], ['height', px(height)]]);
  const name = meta.title.trim() || hostOf(meta.url) || 'Snapshot';
  // The attribute marks the root too: Chrome's async clipboard sanitiser can drop the comment.
  return `${SNAPSHOT_MARKER}<div ${SNAPSHOT_ATTR}="v1" layer-name="${escAttr(name)}" data-source="${escAttr(meta.url)}" style="${root}">${parts.join('')}</div>`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
