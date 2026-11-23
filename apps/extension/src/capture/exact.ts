/**
 * Exact snapshot: the page's own element structure with its computed CSS inline, in Markup's permissive `any`
 * dialect. Markup's canvas renders real HTML/CSS, so the same CSS lays out the same way - no re-derivation into
 * flex/absolute (that is the simplified serializer in serialize.ts).
 */
import { rootClip } from './clip';
import {
  attrs,
  backdrop,
  cleanSvg,
  DEFAULT_LIMITS,
  DIALECT_ATTR,
  embedHost,
  escAttr,
  escText,
  FIELDS,
  fieldContent,
  INLINE,
  isElement,
  isText,
  readPseudo,
  renderedChildren,
  skipped,
  KEYFRAMES_ATTR,
  SNAPSHOT_ATTR,
  SNAPSHOT_MARKER,
  snapshotName,
  TARGET_GAP,
  targetAsRoot,
  TOO_LARGE,
  visible,
  type CaptureLimits,
  type PseudoInfo,
  captureTargets,
} from './dom';
import type { CaptureEnv } from './env';
import { backgroundDecls, canvasPng, concat, ImageLoader, maskDecls, PLACEHOLDER_COLOR, PLACEHOLDER_NAME, screenImage } from './images';
import { KeyframesRegistry } from './motion';
import { motionStyle } from './motionVars';
import { memoStyles } from './styleMemo';
import { SvgDefs } from './svgDefs';
import { borders, clippedAway, fontStack, get, hasPadding, isBoxy, padding, px, SIDES, styleAttr, type Decl } from './styles';

const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;

/** Layout, box and paint properties that do not inherit: copied when they differ from a blank div. */
const BOX_PROPS = [
  'z-index', 'float', 'clear',
  'min-width', 'min-height', 'max-width', 'max-height',
  ...SIDES.map((s) => `margin-${s}`),
  ...SIDES.map((s) => `padding-${s}`),
  ...CORNERS.map((c) => `border-${c}-radius`),
  'overflow-x', 'overflow-y',
  'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'flex-wrap', 'order',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self',
  'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
  'grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end',
  'background-color', 'background-clip', 'background-origin', 'background-blend-mode',
  'box-shadow', 'opacity', 'transform', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter', 'mix-blend-mode', 'clip-path',
  // 3D: card flips and tilted scenes keep their depth.
  'perspective', 'transform-style', 'backface-visibility',
  'mask-mode', 'mask-composite',
  'vertical-align', 'text-overflow', 'table-layout', 'object-fit', 'object-position', 'aspect-ratio', 'isolation',
  // display: -webkit-box (line clamping) lays out wrongly without these.
  '-webkit-box-orient', '-webkit-line-clamp',
];

/**
 * Inherited properties: copied only where they change from the parent; the snapshot root carries them all (the
 * canvas has its own body font, colour and numeric variant). text-shadow, list-style-position, border-collapse and
 * border-spacing inherit in CSS, so they are compared with the parent too.
 */
const INHERITED = [
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-feature-settings', 'font-variation-settings',
  'font-variant-numeric', '-webkit-font-smoothing', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-transform',
  'text-indent', 'text-shadow', 'white-space', 'word-break', 'overflow-wrap', 'visibility', 'list-style-type', 'list-style-position',
  'border-collapse', 'border-spacing',
  // Gradient and outlined text (background-clip: text with a transparent fill, stroked headlines).
  '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'paint-order',
];

/** CSS initial values, for an env that cannot compute a blank div. */
const INITIAL: Record<string, string> = {
  'z-index': 'auto', float: 'none', clear: 'none', 'min-width': 'auto', 'min-height': 'auto', 'max-width': 'none', 'max-height': 'none',
  ...Object.fromEntries(SIDES.flatMap((s) => [[`margin-${s}`, '0px'], [`padding-${s}`, '0px']])),
  ...Object.fromEntries(CORNERS.map((c) => [`border-${c}-radius`, '0px'])),
  'overflow-x': 'visible', 'overflow-y': 'visible',
  'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto', 'flex-direction': 'row', 'flex-wrap': 'nowrap', order: '0',
  'align-items': 'normal', 'align-self': 'auto', 'align-content': 'normal', 'justify-content': 'normal', 'justify-items': 'normal', 'justify-self': 'auto',
  'row-gap': 'normal', 'column-gap': 'normal',
  'grid-template-columns': 'none', 'grid-template-rows': 'none', 'grid-template-areas': 'none', 'grid-auto-flow': 'row', 'grid-auto-columns': 'auto', 'grid-auto-rows': 'auto',
  'grid-row-start': 'auto', 'grid-row-end': 'auto', 'grid-column-start': 'auto', 'grid-column-end': 'auto',
  'background-color': 'rgba(0, 0, 0, 0)', 'background-clip': 'border-box', 'background-origin': 'padding-box', 'background-blend-mode': 'normal',
  perspective: 'none', 'transform-style': 'flat', 'backface-visibility': 'visible', 'mask-mode': 'match-source', 'mask-composite': 'add',
  'box-shadow': 'none', opacity: '1', transform: 'none', translate: 'none', rotate: 'none', scale: 'none', filter: 'none', 'backdrop-filter': 'none',
  'mix-blend-mode': 'normal', 'clip-path': 'none', 'vertical-align': 'baseline', 'text-overflow': 'clip', 'table-layout': 'auto',
  'object-fit': 'fill', 'object-position': '50% 50%', 'aspect-ratio': 'auto', isolation: 'auto', '-webkit-box-orient': 'horizontal', '-webkit-line-clamp': 'none',
};

/** Inline formatting kept inside a text layer; tags outside Markup's text dialect (INLINE) are written as span. */
const FORMATTING = new Set([...INLINE, 'label', 'time', 'abbr', 'kbd', 'cite', 'q', 'del', 'ins', 'var', 'samp']);
/** What a kept formatting tag's own user-agent style changes: always written, so the canvas's defaults cannot differ. */
const TAG_PROPS: Record<string, string[]> = {
  b: ['font-weight'], strong: ['font-weight'], i: ['font-style'], em: ['font-style'], u: ['text-decoration-line'], s: ['text-decoration-line'],
  code: ['font-family', 'font-size'], small: ['font-size'], sup: ['vertical-align', 'font-size'], sub: ['vertical-align', 'font-size'],
  mark: ['background-color', 'color'],
};
/** Declarations an svg node may carry twice (the canvas applies a node's style to its wrapper and the markup). */
const DOUBLES_ON_SVG = /^(margin|padding|border|outline|position|top|right|bottom|left|z-index|float|transform|translate|rotate|scale|opacity|filter|backdrop-filter|mix-blend-mode|clip-path|box-shadow|background)/;
const BASIC_SHAPE = /^(inset|circle|ellipse|polygon|path|rect|xywh)\(/i;
const PX = /^-?\d+(\.\d+)?px$/;
/** Shorthands whose longhands a later declaration of the shorthand replaces. */
const SHORTHANDS = new Set(['background', 'border', 'border-image', 'mask', 'outline', 'border-radius']);
const REPLACED = new Set(['img', 'svg', 'canvas', 'video', 'iframe', 'embed', 'object', 'input', 'textarea', 'select']);

type Item = { el: Element } | { run: Node[] };
type Styles = Map<string, string>;

const hasText = (run: Node[]) => run.some((n) => isText(n) && /\S/.test(n.data));
const styleOf = (s: Styles) => [...s] as Decl[];
const inlineLevel = (display: string) => display.startsWith('inline') || display === 'ruby';

class Exact {
  readonly images: ImageLoader;
  readonly keyframes: KeyframesRegistry;
  readonly svgDefs: SvgDefs;
  private nodes = 0;
  private readonly blank: CSSStyleDeclaration | null;
  private readonly formattingCache = new WeakMap<Element, boolean>();
  /** position:fixed descendants shown through a clipping ancestor (a "reveal" footer): their placement inside it. */
  private readonly fixedPlace = new WeakMap<Element, { top: number; left: number }>();
  /** Clipping ancestors those fixed descendants are anchored to. */
  private readonly anchors = new WeakSet<Element>();
  /** Computed style through the env, for renderedChildren. */
  private readonly computed = (el: Element) => this.env.style(el);

  constructor(
    readonly env: CaptureEnv,
    readonly limits: Required<CaptureLimits>,
  ) {
    this.images = new ImageLoader(env, limits);
    this.keyframes = env.keyframes ?? new KeyframesRegistry();
    this.svgDefs = env.svgDefs ?? new SvgDefs();
    this.blank = env.blankStyle?.() ?? null;
  }

  private initial(prop: string): string {
    return (this.blank && get(this.blank, prop)) || INITIAL[prop] || '';
  }

  // ── Styles ────────────────────────────────────────────────────────────────────────────────────────

  /** Inherited properties that differ from the output parent (all of them when there is none). */
  inherited(cs: CSSStyleDeclaration, parent: CSSStyleDeclaration | null, out: Styles = new Map()): Styles {
    for (const p of INHERITED) {
      const v = get(cs, p);
      if (!v || (parent && get(parent, p) === v)) continue;
      const value = p === 'font-family' ? fontStack(v) : v;
      if (value) out.set(p, value);
    }
    return out;
  }

  /**
   * Computed styles for an output element. `box` elements (div, p, img…) always say their display - the canvas's
   * tags have their own defaults - and keep their size unless they are inline; inline formatting keeps only what
   * differs.
   */
  styles(el: Element | null, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, kind: 'box' | 'inline', replaced = false): Styles {
    const out: Styles = new Map();
    const display = get(cs, 'display');
    if (kind === 'box' || display !== 'inline') out.set('display', display);
    const position = get(cs, 'position');
    if (position && position !== 'static') out.set('position', position === 'fixed' ? 'absolute' : position === 'sticky' ? 'relative' : position);
    const anchored = el ? this.fixedPlace.get(el) : undefined;
    if (anchored) {
      // Fixed inside a clipping ancestor: placed where it shows when that ancestor is scrolled into view.
      out.set('top', px(anchored.top));
      out.set('left', px(anchored.left));
    } else if (/^(relative|absolute|fixed)$/.test(position)) {
      for (const s of SIDES) {
        const v = get(cs, s);
        if (v && v !== 'auto') out.set(s, v);
      }
    }
    if (el && this.anchors.has(el)) {
      if (!position || position === 'static') out.set('position', 'relative');
    }
    if (kind === 'box' && (replaced || display !== 'inline')) {
      out.set('box-sizing', get(cs, 'box-sizing') || 'content-box');
      for (const [dim, size] of [['width', 'width'], ['height', 'height']] as const) {
        const v = this.size(el, cs, size);
        if (v) out.set(dim, v);
      }
    }
    for (const p of BOX_PROPS) {
      const v = get(cs, p);
      if (!v || v === this.initial(p)) continue;
      if ((p === 'filter' || p === 'clip-path') && /url\(/i.test(v)) {
        // An SVG filter or clip path: copied along with the capture, else left out.
        const kept = this.svgDefs.rewrite(p, v, el);
        if (kept) out.set(p, kept);
        continue;
      }
      if (p === 'backdrop-filter' && /url\(/i.test(v)) continue;
      if (p === 'clip-path' && !BASIC_SHAPE.test(v)) continue;
      out.set(p, v);
    }
    if (el && this.anchors.has(el)) {
      // It clips its revealed fixed content (often with clip-path: border-box, which is not kept).
      if (!/hidden|clip/.test(out.get('overflow-x') ?? '')) out.set('overflow-x', 'clip');
      if (!/hidden|clip/.test(out.get('overflow-y') ?? '')) out.set('overflow-y', 'clip');
    }
    if (el && kind === 'box') this.autoMargins(el, cs, out);
    for (const s of SIDES) {
      const style = get(cs, `border-${s}-style`);
      if (!style || style === 'none' || style === 'hidden') continue;
      out.set(`border-${s}-width`, get(cs, `border-${s}-width`) || '0px');
      out.set(`border-${s}-style`, style);
      out.set(`border-${s}-color`, get(cs, `border-${s}-color`) || 'currentcolor');
    }
    const outline = get(cs, 'outline-style');
    if (outline && outline !== 'none') {
      for (const p of ['outline-width', 'outline-style', 'outline-color', 'outline-offset']) if (get(cs, p)) out.set(p, get(cs, p));
    }
    if (out.has('transform') || out.has('rotate') || out.has('scale')) {
      const origin = get(cs, 'transform-origin');
      if (origin) out.set('transform-origin', origin);
    }
    if (out.has('perspective')) {
      const origin = get(cs, 'perspective-origin');
      if (origin) out.set('perspective-origin', origin);
    }
    const line = get(cs, 'text-decoration-line');
    if (line && line !== 'none') {
      out.set('text-decoration-line', line);
      for (const p of ['text-decoration-style', 'text-decoration-color', 'text-decoration-thickness']) {
        const v = get(cs, p);
        if (v && v !== this.initial(p) && v !== 'auto' && v !== 'solid') out.set(p, v);
      }
    }
    if (get(cs, 'list-style-image') && get(cs, 'list-style-image') !== 'none') out.set('list-style-image', 'none');
    this.inherited(cs, parent, out);
    const tag = el?.localName ?? '';
    for (const p of TAG_PROPS[tag] ?? []) {
      const v = get(cs, p);
      if (v && !out.has(p)) out.set(p, p === 'font-family' ? fontStack(v) : v);
    }
    return out;
  }

  /** The computed width/height (a used px value on a live page), else derived from the layout rect. */
  size(el: Element | null, cs: CSSStyleDeclaration, dim: 'width' | 'height'): string {
    const v = get(cs, dim);
    if (PX.test(v)) return v;
    if (!el) return '';
    const r = this.env.rect(el);
    let n = dim === 'width' ? r.width : r.height;
    if (get(cs, 'box-sizing') !== 'border-box') {
      const p = padding(cs);
      const b = borders(cs);
      n -= dim === 'width' ? p.left + p.right + b.left + b.right : p.top + p.bottom + b.top + b.bottom;
    }
    return px(Math.max(0, n));
  }

  /**
   * Chrome reports `margin: auto` as 0px in getComputedStyle for some boxes (a centred grid, for one), so a block
   * box's horizontal margins are taken from layout: equal gaps on both sides become `auto`, a lone gap its px.
   */
  autoMargins(el: Element, cs: CSSStyleDeclaration, out: Styles): void {
    const parent = el.parentElement;
    if (!parent || get(cs, 'float') !== 'none' || get(cs, 'direction') === 'rtl') return;
    if (!/^(static|relative)$/.test(get(cs, 'position') || 'static') || (get(cs, 'position') === 'relative' && get(cs, 'left') !== 'auto' && get(cs, 'left') !== '0px')) return;
    if (!/^(block|flow-root|flex|grid|table|list-item)$/.test(get(cs, 'display'))) return;
    if (get(cs, 'transform') !== 'none' && get(cs, 'transform') !== '') return;
    const pcs = this.env.style(parent);
    if (!/^(block|flow-root|list-item)$/.test(get(pcs, 'display'))) return;
    const r = this.env.rect(el);
    const pr = this.env.rect(parent);
    if (!r.width || !pr.width) return;
    const pad = padding(pcs);
    const border = borders(pcs);
    const ml = r.left - (pr.left + border.left + pad.left);
    const mr = pr.right - border.right - pad.right - r.right;
    const computedLeft = parseFloat(get(cs, 'margin-left')) || 0;
    const computedRight = parseFloat(get(cs, 'margin-right')) || 0;
    if (Math.abs(ml - computedLeft) <= 0.5 && Math.abs(mr - computedRight) <= 0.5) return;
    if (ml > 0.5 && Math.abs(ml - mr) <= 1) {
      out.set('margin-left', 'auto');
      out.set('margin-right', 'auto');
    } else if (ml > 0.5 && Math.abs(ml - computedLeft) > 0.5) {
      out.set('margin-left', px(Math.round(ml * 100) / 100));
    }
  }

  /**
   * Finds position:fixed elements shown through a clipping ancestor (overflow hidden/clip or a clip-path), the
   * "fixed reveal" footer pattern, and places each inside that ancestor as it appears once the ancestor is in view.
   * Without this the fixed boxes land relative to the snapshot root, on top of the page's first screen.
   */
  anchorFixed(roots: Element[]): void {
    const win = roots[0]?.ownerDocument.defaultView;
    if (!win) return;
    const stop = new Set<Element>([win.document.documentElement, win.document.body]);
    // Read directly, not through env.style: a progress-tracking env counts each first read as a walked
    // element, and this pre-scan would fill the walk's share of the bar before serialization starts.
    const style = (e: Element) => win.getComputedStyle(e);
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (get(style(el), 'position') !== 'fixed') continue;
        let anchor: Element | null = null;
        for (let a = el.parentElement; a && !stop.has(a); a = a.parentElement) {
          const acs = style(a);
          if (get(acs, 'position') === 'fixed') break;
          if (/hidden|clip/.test(get(acs, 'overflow-x') + get(acs, 'overflow-y')) || (get(acs, 'clip-path') || 'none') !== 'none') {
            anchor = a;
            break;
          }
        }
        if (!anchor) continue;
        const vp = el.getBoundingClientRect();
        const ar = this.env.rect(anchor);
        // Where the anchor's top sits in the viewport when the page is scrolled so its bottom meets the viewport's.
        const anchorTop = Math.max(0, win.innerHeight - ar.height);
        this.fixedPlace.set(el, { top: Math.round(vp.top - anchorTop), left: Math.round(vp.left - (ar.left - win.scrollX)) });
        this.anchors.add(anchor);
      }
    }
  }

  /**
   * The style plus inlined background and mask images (url() layers that cannot be loaded are dropped) and the
   * animations the element (or, with `motion`, a pseudo-element of it) runs.
   */
  async boxStyles(el: Element | null, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, replaced = false, motion?: { owner: Element; pseudo: '::before' | '::after' }): Promise<Styles> {
    const out = this.styles(el, cs, parent, 'box', replaced);
    const [background, mask] = await Promise.all([backgroundDecls(cs, this.images), maskDecls(cs, this.images)]);
    for (const [k, v] of [...background, ...mask]) out.set(k, v);
    const owner = el ?? motion?.owner;
    if (owner) {
      for (const [k, v] of motionStyle(this.env, this.keyframes, owner, el ? undefined : motion?.pseudo, cs)) {
        // A shorthand the page wrote with an animated var() replaces the computed longhands it covers.
        if (SHORTHANDS.has(k)) for (const key of [...out.keys()]) if (key.startsWith(`${k}-`)) out.delete(key);
        out.delete(k);
        out.set(k, v);
      }
    }
    return out;
  }

  // ── Walk ──────────────────────────────────────────────────────────────────────────────────────────

  /** One element. `place` positions a capture target inside the snapshot root (its own margins are dropped). */
  async node(el: Element, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    if (skipped(el)) return '';
    if (++this.nodes > this.limits.maxNodes) throw new Error(TOO_LARGE);
    const cs = this.env.style(el);
    if (!visible(cs)) return '';
    if (get(cs, 'display') === 'contents') {
      // No box: the children go straight into the output parent, so their inherited styles compare with it.
      const inner = await this.children(el, cs, parent);
      return place ? `<div${attrs(place)}>${inner}</div>` : inner;
    }
    const r = this.env.rect(el);
    if (clippedAway(cs, r.width, r.height)) return '';
    const tag = el.localName;
    switch (tag) {
      case 'img':
        return this.image((el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || '', el, cs, parent, place);
      case 'picture': {
        const img = el.querySelector('img');
        return img ? this.node(img, parent, place) : '';
      }
      case 'svg':
        return this.svg(el as SVGSVGElement, cs, parent, place);
      case 'canvas':
        return this.canvas(el as HTMLCanvasElement, cs, parent, place);
      case 'video':
        return this.video(el as HTMLVideoElement, cs, parent, place);
      case 'iframe':
      case 'embed':
      case 'object':
        return this.embed(el, cs, parent, place);
    }
    if (FIELDS.has(tag)) return this.field(el as HTMLInputElement, cs, parent, place);
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return '';
    return this.element(el, cs, parent, place);
  }

  /** Rendered children: element items and runs of text + inline formatting. */
  items(el: Element): Item[] {
    const out: Item[] = [];
    let run: Node[] = [];
    const flush = () => {
      if (run.length) out.push({ run });
      run = [];
    };
    for (const child of renderedChildren(el, this.computed)) {
      if (isText(child)) run.push(child);
      else if (!isElement(child) || skipped(child)) continue;
      else if (!visible(this.env.style(child))) continue;
      else if (this.formatting(child)) run.push(child);
      else {
        flush();
        out.push({ el: child });
      }
    }
    flush();
    return out;
  }

  /** Inline formatting: an inline tag with no box or pseudo-elements of its own, holding only text and formatting. */
  formatting(el: Element): boolean {
    const hit = this.formattingCache.get(el);
    if (hit !== undefined) return hit;
    const cs = this.env.style(el);
    let ok = FORMATTING.has(el.localName) && get(cs, 'display') === 'inline';
    if (ok && el.localName !== 'br') {
      ok = !isBoxy(cs) && !hasPadding(cs) && !readPseudo(this.env, el, '::before') && !readPseudo(this.env, el, '::after');
      for (const c of renderedChildren(el, this.computed)) {
        if (!ok) break;
        if (isElement(c) && !skipped(c) && visible(this.env.style(c))) ok = this.formatting(c);
      }
    }
    this.formattingCache.set(el, ok);
    return ok;
  }

  /**
   * The output for el's children (and pseudo-elements). `cs` is el's own style; `base` is what the output children
   * inherit from (el itself, or el's output parent when el has `display: contents`).
   */
  async children(el: Element, cs: CSSStyleDeclaration, base: CSSStyleDeclaration, pseudos: (PseudoInfo | null)[] = [null, null]): Promise<string> {
    const flow = !/flex|grid|table/.test(get(cs, 'display'));
    const run = styleAttr([['display', 'inline'], ...styleOf(base === cs ? new Map() : this.inherited(cs, base))]);
    type Part = { html: Promise<string>; inline: boolean } | { space: true };
    const parts: Part[] = [];
    const [before, after] = pseudos;
    if (before) parts.push({ html: this.pseudoNode(before, cs), inline: before.inline });
    // Subtrees the page showed only while in view, recorded during the whole-page pass, go back at their index.
    const mounted = [...(this.env.mountedSnapshots?.(el) ?? [])].sort((a, b) => a.index - b.index);
    let elementIndex = 0;
    const spliceMounted = () => {
      // Their images were admitted by a separate pass, so they are charged against this capture's budget here.
      while (mounted.length && mounted[0]!.index <= elementIndex) {
        const { html } = mounted.shift()!;
        if (this.images.admitHtml(html)) parts.push({ html: Promise.resolve(html), inline: false });
      }
    };
    for (const item of this.items(el)) {
      if ('el' in item) {
        // Only needed to place recorded subtrees; an O(children) lookup per child otherwise.
        if (mounted.length) {
          const at = Array.prototype.indexOf.call(el.children, item.el);
          if (at >= 0) elementIndex = at;
          spliceMounted();
        }
        parts.push({ html: this.node(item.el, base), inline: inlineLevel(get(this.env.style(item.el), 'display')) });
        continue;
      }
      if (hasText(item.run)) {
        parts.push({ html: Promise.resolve(`<span style="${escAttr(run)}">${this.inlineHtml(item.run, cs, base)}</span>`), inline: true });
        continue;
      }
      // Whitespace and formatting without text of its own: each formatting element stands alone.
      for (const n of item.run) {
        if (isText(n)) parts.push({ space: true });
        else if (isElement(n) && n.localName === 'br') parts.push({ html: Promise.resolve('<span style="display:inline"><br></span>'), inline: true });
        else if (isElement(n)) parts.push({ html: this.node(n, base), inline: true });
      }
    }
    elementIndex = Number.POSITIVE_INFINITY;
    spliceMounted();
    if (after) parts.push({ html: this.pseudoNode(after, cs), inline: after.inline });
    // A space between two inline-level boxes separates them; anywhere else it collapses away.
    const kept = parts.filter((p, i) => {
      if (!('space' in p)) return true;
      const prev = parts[i - 1];
      const next = parts[i + 1];
      return flow && !!prev && !!next && !('space' in prev) && !('space' in next) && prev.inline && next.inline;
    });
    const html = await Promise.all(kept.map((p) => ('space' in p ? `<span style="${escAttr(run)}"> </span>` : p.html)));
    return concat(html);
  }

  async element(el: Element, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    const items = this.items(el);
    const pseudos = [readPseudo(this.env, el, '::before'), readPseudo(this.env, el, '::after')];
    const only = items.length === 1 && 'run' in items[0]! ? items[0].run : null;
    const leaf = !!only && hasText(only) && pseudos.every((p) => !p || p.inline);
    const styles = await this.boxStyles(el, cs, parent);
    if (leaf && el.localName === 'button') centerContent(styles);
    const style = placed(styles, place);
    if (leaf) {
      const [before, after] = pseudos.map((p) => (p ? `<span${attrs(styleOf(this.styles(null, p.cs, cs, 'inline')))}>${escText(p.text)}</span>` : ''));
      return `<p${attrs(style, el.getAttribute('aria-label') ?? undefined)}>${before}${this.inlineHtml(only!, cs)}${after}</p>`;
    }
    return `<div${attrs(style)}>${await this.children(el, cs, cs, pseudos)}</div>`;
  }

  /**
   * Text with inline formatting; each formatting element keeps the styles that differ from its output parent
   * (`base`, by default the element holding the text, whose `cs` also decides how whitespace collapses).
   */
  inlineHtml(nodes: Node[], cs: CSSStyleDeclaration, base: CSSStyleDeclaration = cs): string {
    const ws = get(cs, 'white-space') || 'normal';
    let out = '';
    for (const n of nodes) {
      if (isText(n)) {
        let t = n.data;
        if (/^(normal|nowrap)$/.test(ws)) t = t.replace(/[ \t\n\f\r]+/g, ' ');
        else if (ws === 'pre-line') t = t.replace(/[ \t\f\r]+/g, ' ');
        out += escText(t);
        continue;
      }
      if (!isElement(n) || skipped(n)) continue;
      const tag = n.localName;
      if (tag === 'br') {
        out += '<br>';
        continue;
      }
      const ncs = this.env.style(n);
      if (!visible(ncs)) continue;
      const name = INLINE.has(tag) ? tag : 'span';
      out += `<${name}${attrs(styleOf(this.styles(n, ncs, base, 'inline')))}>${this.inlineHtml(renderedChildren(n, this.computed), ncs)}</${name}>`;
    }
    return out;
  }

  async pseudoNode(p: PseudoInfo, owner: CSSStyleDeclaration): Promise<string> {
    const motion = { owner: p.owner, pseudo: p.which };
    if (p.image) {
      const data = await this.images.get(p.image);
      if (!data) return '';
      return `<img src="${data}"${attrs(styleOf(blockish(await this.boxStyles(null, p.cs, owner, true, motion))))}>`;
    }
    const text = escText(p.text);
    if (p.inline) return `<span${attrs(styleOf(this.styles(null, p.cs, owner, 'box')))}>${text}</span>`;
    const styles = await this.boxStyles(null, p.cs, owner, false, motion);
    return `<div${attrs(styleOf(styles))}>${p.text.trim() ? `<span style="display:inline">${text}</span>` : ''}</div>`;
  }

  // ── Replaced elements ─────────────────────────────────────────────────────────────────────────────

  async placeholder(el: Element, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    const styles = placeholderFill(blockish(await this.boxStyles(el, cs, parent, true)));
    return `<div${attrs(placed(styles, place), PLACEHOLDER_NAME)}></div>`;
  }

  async imageTag(data: string, el: Element, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    const styles = await this.boxStyles(el, cs, parent, true);
    const alt = el.getAttribute('alt')?.trim();
    return `<img src="${data}"${attrs(placed(styles, place), alt || undefined)}>`;
  }

  async image(src: string, el: Element, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    const data = (src ? await this.images.get(src) : null) ?? (await screenImage(this.env, this.images, el));
    return data ? this.imageTag(data, el, cs, parent, place) : this.placeholder(el, cs, parent, place);
  }

  async canvas(el: HTMLCanvasElement, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    // A frame recorded while the canvas was on screen and drawing beats a readback now, which WebGL clears
    // after every frame and which pages leave empty off screen.
    // A shader or animated drawing recorded as a looping clip, else one still frame.
    let data: string | null = this.images.admit(this.env.motionClip?.(el) ?? null) ?? this.images.admit(this.env.canvasFrame?.(el) ?? null);
    let tainted = false;
    if (!data && el.width > 0 && el.height > 0) {
      try {
        const now = await canvasPng(el);
        if (now && !(await blankImage(el.ownerDocument, now))) data = this.images.admit(now);
      } catch {
        tainted = true;
      }
    }
    data ??= await screenImage(this.env, this.images, el);
    if (data) return this.imageTag(data, el, cs, parent, place);
    // Nothing drawn (a 0x0 buffer or an empty frame): an empty box, not the grey "unavailable" placeholder.
    if (!tainted) return `<div${attrs(placed(blockish(await this.boxStyles(el, cs, parent, true)), place))}></div>`;
    return this.placeholder(el, cs, parent, place);
  }

  async video(el: HTMLVideoElement, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    // A playing video recorded as a looping clip, else the frame it shows now.
    let data: string | null = this.images.admit(this.env.motionClip?.(el) ?? null);
    if (!data && el.readyState >= 2 && el.videoWidth) {
      try {
        const c = el.ownerDocument.createElement('canvas');
        c.width = el.videoWidth;
        c.height = el.videoHeight;
        c.getContext('2d')?.drawImage(el, 0, 0);
        data = this.images.admit(await canvasPng(c));
      } catch {
        data = null;
      }
    }
    if (!data && el.poster) data = await this.images.get(el.poster);
    if (!data) data = await screenImage(this.env, this.images, el);
    return data ? this.imageTag(data, el, cs, parent, place) : this.placeholder(el, cs, parent, place);
  }

  /**
   * The canvas puts an svg node's style on a wrapper and on the markup itself. When the svg has box styles that
   * must not apply twice (margins, borders, offsets…), a frame carries them and the svg just fills it.
   */
  async svg(el: SVGSVGElement, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    const r = this.env.rect(el);
    const styles = blockish(await this.boxStyles(el, cs, parent, true));
    const width = parseFloat(styles.get('width') ?? '') || r.width;
    const height = parseFloat(styles.get('height') ?? '') || r.height;
    const decls = placed(styles, place);
    const clone = cleanSvg(el, this.env, width, height);
    if (!decls.some(([k]) => DOUBLES_ON_SVG.test(k))) {
      clone.setAttribute('style', styleAttr(decls));
      return clone.outerHTML;
    }
    clone.setAttribute('style', 'display:block;width:100%;height:100%');
    return `<div${attrs(decls)}>${clone.outerHTML}</div>`;
  }

  async field(el: HTMLInputElement, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    const styles = await this.boxStyles(el, cs, parent, true);
    const f = fieldContent(el);
    if (f.kind === 'check') {
      if (!isBoxy(cs)) {
        for (const s of SIDES) styles.set(`border-${s}`, '1px solid #767676');
        for (const c of CORNERS) styles.set(`border-${c}-radius`, f.type === 'radio' ? '50%' : '3px');
        styles.set('background-color', f.checked ? '#2563eb' : '#ffffff');
      }
      return `<div${attrs(placed(blockish(styles), place), f.type)}></div>`;
    }
    styles.set('display', inlineLevel(get(cs, 'display')) ? 'inline-flex' : 'flex');
    styles.set('align-items', f.multiline ? 'flex-start' : 'center');
    if (f.button) styles.set('justify-content', 'center');
    if (!styles.has('overflow-x')) styles.set('overflow-x', 'hidden');
    if (!styles.has('overflow-y')) styles.set('overflow-y', 'hidden');
    const tcs = f.placeholder ? this.env.style(el, '::placeholder') : cs;
    const text = this.inherited(tcs, cs);
    text.delete('white-space');
    const p: Decl[] = [['display', 'block'], ['flex-shrink', '0'], ...styleOf(text), ['white-space', f.multiline ? 'pre-wrap' : 'pre']];
    const inner = f.text ? `<p${attrs(p)}>${escText(f.text)}</p>` : '';
    return `<div${attrs(placed(styles, place), el.getAttribute('name') || el.getAttribute('aria-label') || undefined)}>${inner}</div>`;
  }

  async embed(el: Element, cs: CSSStyleDeclaration, parent: CSSStyleDeclaration, place?: Decl[]): Promise<string> {
    const host = embedHost(el);
    const styles = placeholderFill(await this.boxStyles(el, cs, parent, true));
    styles.set('display', inlineLevel(get(cs, 'display')) ? 'inline-flex' : 'flex');
    styles.set('align-items', 'center');
    styles.set('justify-content', 'center');
    styles.set('overflow-x', 'hidden');
    styles.set('overflow-y', 'hidden');
    const p: Decl[] = [['display', 'block'], ['color', '#71717a'], ['font-family', 'system-ui'], ['font-size', '12px']];
    return `<div${attrs(placed(styles, place), host)}><p${attrs(p)}>${escText(host)}</p></div>`;
  }
}

/** Largest side blankImage scans at; bigger images are scaled down with area averaging first. */
const BLANK_SCAN = 2048;

/**
 * True when a data URL decodes to an image with no visible pixel. Scanned at (near) full resolution, so
 * sparse content such as thin chart lines or scattered dots on a transparent canvas still counts.
 */
export async function blankImage(doc: Document, dataUrl: string): Promise<boolean> {
  if (!dataUrl.startsWith('data:image/')) return true;
  try {
    const img = doc.createElement('img');
    img.src = dataUrl;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) return true;
    const scale = Math.min(1, BLANK_SCAN / Math.max(img.naturalWidth, img.naturalHeight));
    const c = doc.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < px.length; i += 4) if (px[i]! > 2) return false;
    return true;
  } catch {
    return false;
  }
}

/** Declarations in order; a target's placement replaces its own position, offsets, margins, float and anything else it sets. */
function placed(styles: Styles, place?: Decl[]): Decl[] {
  if (!place) return styleOf(styles);
  for (const k of ['position', 'float', ...SIDES, ...SIDES.map((s) => `margin-${s}`), ...place.map(([k]) => k)]) styles.delete(k);
  return [...place, ...styleOf(styles)];
}

/** A sized box the canvas renders as a div must not be `display: inline` (which ignores width and height). */
function blockish<T extends Styles>(styles: T): T {
  if (styles.get('display') === 'inline') styles.set('display', 'inline-block');
  return styles;
}

/** The grey fill that stands in for content the capture cannot copy. */
function placeholderFill(styles: Styles): Styles {
  for (const k of [...styles.keys()]) if (k.startsWith('background')) styles.delete(k);
  styles.set('background-color', PLACEHOLDER_COLOR);
  return styles;
}

/** A text-only button centres its label like the browser does. */
function centerContent(styles: Styles): void {
  const display = styles.get('display') ?? '';
  if (/flex|grid/.test(display)) return;
  styles.set('display', inlineLevel(display) ? 'inline-flex' : 'flex');
  styles.set('align-items', 'center');
  const align = styles.get('text-align') ?? 'center';
  styles.set('justify-content', /^(left|start|-webkit-left)$/.test(align) ? 'flex-start' : /^(right|end|-webkit-right)$/.test(align) ? 'flex-end' : 'center');
}

/**
 * Copies page elements as their own structure with computed CSS inline (Markup's `any` dialect): a snapshot
 * marker, then one root frame (named after the page, tagged with its URL) holding each target side by side.
 */
export async function captureExact(
  targets: Element[] | 'page',
  env: CaptureEnv,
  meta: { title: string; url: string },
  limits: CaptureLimits = {},
): Promise<string> {
  const els = targets === 'page' ? [document.documentElement] : captureTargets(targets);
  if (els.length === 0) throw new Error('Nothing to capture');
  env = memoStyles(env);
  await env.loadMotions?.();
  const x = new Exact(env, { ...DEFAULT_LIMITS, ...limits });
  x.anchorFixed(els);
  const first = els[0]!;
  const rootCs = env.style(first.parentElement ?? first);
  const rects = els.map((el) => env.rect(el));
  let left = 0;
  const places: Decl[][] = rects.map((r) => {
    const place: Decl[] = [['position', 'absolute'], ['left', px(left)], ['top', '0px']];
    // A whole page is the browser viewport: it fills the snapshot root, so resizing the artboard shows more of
    // the page (or less) instead of growing empty space around a viewport-sized box that clips its content.
    if (targets === 'page') place.push(['width', '100%'], ['height', '100%']);
    left += r.width + TARGET_GAP;
    return place;
  });
  const parts = await Promise.all(els.map((el, i) => x.node(el, rootCs, places[i])));
  if (!parts.some(Boolean)) throw new Error('Nothing to capture: the selection is hidden or empty');
  const single = els.length === 1 && targets !== 'page';
  const paint: Decl[] = [
    // Only a whole page gets the page colour behind it; a picked element keeps its own background, or none.
    ...(targets === 'page' ? ([['background-color', backdrop(first, env)]] as Decl[]) : []),
    ...(single ? rootClip(first, env) : []),
    ...x.inherited(rootCs, null),
  ];
  // The keyframes travel as an attribute (clipboard sanitisers drop <style>); the app stores them in the file.
  const keyframes = x.keyframes.size ? ` ${KEYFRAMES_ATTR}="${escAttr(x.keyframes.css())}"` : '';
  // The attribute marks the root too: Chrome's async clipboard sanitiser can drop the comment.
  const marks = `${SNAPSHOT_ATTR}="v1"${keyframes} data-source="${escAttr(meta.url)}" ${DIALECT_ATTR}="any"`;
  // A lone target is the snapshot itself; one that clips itself keeps the wrapper for the outer clip.
  const ownClip = !/^(none)?$/.test(get(env.style(first), 'clip-path'));
  const flat = single && !(ownClip && paint.some(([k]) => k === 'clip-path')) ? targetAsRoot(parts[0]!, marks, snapshotName(meta), paint, x.svgDefs.html()) : null;
  if (flat) return `${SNAPSHOT_MARKER}${flat}`;
  const root: Decl[] = [['position', 'relative'], ['width', px(Math.max(0, left - TARGET_GAP))], ['height', px(Math.max(0, ...rects.map((r) => r.height)))], ...paint];
  return `${SNAPSHOT_MARKER}<div ${marks} layer-name="${escAttr(snapshotName(meta))}" style="${escAttr(styleAttr(root))}">${x.svgDefs.html()}${concat(parts)}</div>`;
}

/**
 * One element serialized on its own, as it would appear among its parent's children in a capture. The
 * whole-page pass uses it for subtrees the page mounts only while they are in view.
 */
export async function captureSubtree(el: Element, env: CaptureEnv, limits: CaptureLimits = {}): Promise<string> {
  const parent = el.parentElement;
  if (!parent) return '';
  env = memoStyles(env);
  await env.loadMotions?.();
  const x = new Exact(env, { ...DEFAULT_LIMITS, ...limits });
  x.anchorFixed([el]);
  return x.node(el, env.style(parent));
}
