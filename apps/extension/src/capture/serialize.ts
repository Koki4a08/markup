import { rootClip } from './clip';
import {
  attrs,
  backdrop,
  cleanSvg,
  DEFAULT_LIMITS,
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
  SKIP,
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
} from './dom';
import type { CaptureEnv } from './env';
import { backgroundDecls, canvasPng, concat, ImageLoader, maskDecls, PLACEHOLDER_COLOR, PLACEHOLDER_NAME, screenImage } from './images';
import { KeyframesRegistry, relativeMotion } from './motion';
import { motionStyle } from './motionVars';
import { memoStyles } from './styleMemo';
import { SvgDefs } from './svgDefs';
import {
  borders,
  boxDecls,
  clippedAway,
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

export { DEFAULT_LIMITS, SNAPSHOT_ATTR, SNAPSHOT_MARKER, TOO_LARGE, type CaptureLimits } from './dom';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a child sits in its parent frame: in flex flow, or absolutely from the parent's padding-box origin. */
type Mode = { flow: true } | { flow: false; x: number; y: number };

type Item = { el: Element } | { run: Node[] };
type Pseudo = '::before' | '::after';

const BASIC_SHAPE = /^(inset|circle|ellipse|polygon|path|rect|xywh)\(/i;

class Serializer {
  readonly images: ImageLoader;
  readonly keyframes: KeyframesRegistry;
  readonly svgDefs: SvgDefs;
  private nodes = 0;
  /** Computed style through the env, for renderedChildren. */
  private readonly computed = (el: Element) => this.env.style(el);

  constructor(
    readonly env: CaptureEnv,
    readonly limits: Required<CaptureLimits>,
  ) {
    this.images = new ImageLoader(env, limits);
    this.keyframes = env.keyframes ?? new KeyframesRegistry();
    this.svgDefs = env.svgDefs ?? new SvgDefs();
  }

  /**
   * What boxDecls leaves out of a layer's look: SVG filters and clip paths (copied along), shape clip paths, masks,
   * gradient text, background blending, and the element's animations (relative to its measured position).
   */
  async effects(cs: CSSStyleDeclaration, owner: Element, pseudo?: Pseudo): Promise<Decl[]> {
    const out: Decl[] = [];
    for (const p of ['filter', 'clip-path'] as const) {
      const v = get(cs, p);
      if (!v || v === 'none') continue;
      if (/url\(/i.test(v)) {
        const kept = this.svgDefs.rewrite(p, v, owner);
        if (kept) out.push([p, kept]);
      } else if (p === 'clip-path' && BASIC_SHAPE.test(v)) out.push([p, v]);
    }
    if (get(cs, 'background-clip') === 'text' || get(cs, '-webkit-background-clip') === 'text') out.push(['background-clip', 'text'], ['-webkit-background-clip', 'text']);
    const blend = get(cs, 'background-blend-mode');
    if (blend && blend !== 'normal') out.push(['background-blend-mode', blend]);
    out.push(...(await maskDecls(cs, this.images)));
    out.push(...motionStyle(this.env, this.keyframes, owner, pseudo, cs, (records) => relativeMotion(records, cs)));
    return out;
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

  async frameDecls(box: Box, mode: Mode, cs: CSSStyleDeclaration, owner: Element, pseudo?: Pseudo): Promise<Decl[]> {
    const [background, effects] = await Promise.all([backgroundDecls(cs, this.images), this.effects(cs, owner, pseudo)]);
    return [...this.place(box, mode, cs), ...this.size(box), ...boxDecls(cs), ...background, ...effects];
  }

  visible(_el: Element, cs: CSSStyleDeclaration): boolean {
    return visible(cs);
  }

  async node(el: Element, mode: Mode): Promise<string> {
    const tag = el.localName;
    if (SKIP.has(tag) || el.hasAttribute(SNAPSHOT_ATTR)) return '';
    if (++this.nodes > this.limits.maxNodes) throw new Error(TOO_LARGE);
    const cs = this.env.style(el);
    if (!this.visible(el, cs)) return '';
    if (get(cs, 'display') === 'contents') return concat(await Promise.all(this.items(el).map((i) => this.item(i, el, cs, mode, null))));
    const box = this.box(el, cs);
    if (clippedAway(cs, box.w, box.h)) return '';

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
    for (const child of renderedChildren(el, this.computed)) {
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
    for (const c of renderedChildren(el, this.computed)) {
      if (isText(c)) continue;
      if (!isElement(c)) continue;
      const ccs = this.env.style(c);
      if (!this.visible(c, ccs)) continue;
      if (!this.inlineFormatting(c, ccs)) return false;
    }
    return true;
  }

  pseudo(el: Element, which: '::before' | '::after'): PseudoInfo | null {
    return readPseudo(this.env, el, which);
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
    const decls = await this.frameDecls(box, mode, cs, el);
    const [before, after] = pseudos;
    const children = await Promise.all([
      before ? this.pseudoNode(before, el, cs, box, childMode) : '',
      ...items.map((i) => this.item(i, el, cs, childMode, box)),
      after ? this.pseudoNode(after, el, cs, box, childMode) : '',
    ]);
    if (flex) decls.push(...flexDecls(cs));
    // In a flex parent the frame is in flow; it still has to anchor its absolutely placed children.
    else if (mode.flow && children.some(Boolean)) decls.splice(0, 0, ['position', 'relative']);
    return `<div${attrs(decls)}>${concat(children)}</div>`;
  }

  item(item: Item, parent: Element, parentCs: CSSStyleDeclaration, mode: Mode, parentBox: Box | null): Promise<string> {
    if ('el' in item) return this.node(item.el, mode);
    return Promise.resolve(this.runNode(item.run, parent, parentCs, mode, parentBox));
  }

  /** Flex layout survives when every child sits in flow with no margins, offsets, floats or reordering. */
  flexOk(el: Element, cs: CSSStyleDeclaration, items: Item[], pseudos: (PseudoInfo | null)[]): boolean {
    if (!/^(inline-)?flex$/.test(get(cs, 'display'))) return false;
    if (pseudos.some((p) => p?.absolute)) return false;
    if (renderedChildren(el, this.computed).filter(isElement).some((c) => this.skippedInFlow(c))) return false;
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
    return clippedAway(cs, r.width, r.height);
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
      out += `<${name}${attrs(inlineDecls(cs, base))}>${this.inlineHtml(renderedChildren(n, this.computed), base)}</${name}>`;
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
      const decls: Decl[] = [...this.place(at, mode, cs), ['width', textWidth(at.w)], ...boxDecls(cs), ...textDecls(cs), ...(await this.effects(cs, el))];
      return `<p${attrs(decls)}>${inner}</p>`;
    }
    const decls = await this.frameDecls(box, mode, cs, el);
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
    const effects = await this.effects(p.cs, el, p.which);
    if (p.image) {
      const data = await this.images.get(p.image);
      if (!data || !sized) return '';
      return `<img src="${data}"${attrs([...this.place(at, mode, p.cs), ...this.size(at), ...boxDecls(p.cs), ...effects])}>`;
    }
    const text = escText(p.text.trim());
    if (!p.boxy) {
      const decls: Decl[] = [...this.place(at, mode, p.cs), ...(at.w > 0 ? ([['width', textWidth(at.w)]] as Decl[]) : []), ...textDecls(p.cs), ...effects];
      return `<p${attrs(decls)}>${text}</p>`;
    }
    const decls: Decl[] = [
      ...this.place(at, mode, p.cs),
      ...(sized ? this.size(at) : []),
      ...boxDecls(p.cs),
      ...(await backgroundDecls(p.cs, this.images)),
      ...effects,
      ...(text ? [['display', 'flex'] as Decl, ...paddingDecls(p.cs)] : []),
    ];
    return `<div${attrs(decls)}>${text ? `<p${attrs([['flex-shrink', '0'], ...textDecls(p.cs)])}>${text}</p>` : ''}</div>`;
  }

  // ── Replaced elements ─────────────────────────────────────────────────────────────────────────────

  placeholder(box: Box, mode: Mode, cs: CSSStyleDeclaration): string {
    const decls: Decl[] = [...this.place(box, mode, cs), ...this.size(box), ...boxDecls(cs).filter(([k]) => k !== 'background-color'), ['background-color', PLACEHOLDER_COLOR]];
    return `<div${attrs(decls, PLACEHOLDER_NAME)}></div>`;
  }

  async imageTag(data: string, el: Element, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    const decls: Decl[] = [...this.place(box, mode, cs), ...this.size(box), ...boxDecls(cs), ...(await this.effects(cs, el))];
    const fit = get(cs, 'object-fit');
    if (fit && fit !== 'fill') decls.push(['object-fit', fit]);
    const pos = get(cs, 'object-position');
    if (pos && pos !== '50% 50%') decls.push(['object-position', pos]);
    const alt = el.getAttribute('alt')?.trim();
    return `<img src="${data}"${attrs(decls, alt || undefined)}>`;
  }

  async image(src: string, el: Element, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    const data = (src ? await this.images.get(src) : null) ?? (await this.fromScreen(el));
    return data ? this.imageTag(data, el, cs, box, mode) : this.placeholder(box, mode, cs);
  }

  /** The pixels the user sees, cut from a screenshot of the visible tab (private, cross-origin or tainted images). */
  fromScreen(el: Element): Promise<string | null> {
    return screenImage(this.env, this.images, el);
  }

  async canvas(el: HTMLCanvasElement, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    // A shader recorded as a looping clip, else a frame recorded while it drew, else a readback now.
    let data: string | null = this.images.admit(this.env.motionClip?.(el) ?? null) ?? this.images.admit(this.env.canvasFrame?.(el) ?? null);
    if (!data) {
      try {
        data = this.images.admit(await canvasPng(el));
      } catch {
        // Tainted by cross-origin content.
      }
    }
    data ??= await this.fromScreen(el);
    return data ? this.imageTag(data, el, cs, box, mode) : this.placeholder(box, mode, cs);
  }

  async video(el: HTMLVideoElement, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
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
    if (!data) data = await this.fromScreen(el);
    return data ? this.imageTag(data, el, cs, box, mode) : this.placeholder(box, mode, cs);
  }

  async svg(el: SVGSVGElement, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    const clone = cleanSvg(el, this.env, box.w, box.h);
    const style = styleAttr([...this.place(box, mode, cs), ...this.size(box), ...boxDecls(cs).filter(([k]) => k !== 'overflow'), ...(await this.effects(cs, el))]);
    if (style) clone.setAttribute('style', style);
    else clone.removeAttribute('style');
    return clone.outerHTML;
  }

  async field(el: HTMLInputElement, cs: CSSStyleDeclaration, box: Box, mode: Mode): Promise<string> {
    const decls = await this.frameDecls(box, mode, cs, el);
    const f = fieldContent(el);
    if (f.kind === 'check') {
      if (!isBoxy(cs)) {
        decls.push(['border-top', '1px solid #767676'], ['border-right', '1px solid #767676'], ['border-bottom', '1px solid #767676'], ['border-left', '1px solid #767676']);
        decls.push(['border-radius', f.type === 'radio' ? '50%' : '3px'], ['background-color', f.checked ? '#2563eb' : '#ffffff']);
      }
      return `<div${attrs(decls, f.type)}></div>`;
    }
    decls.push(['display', 'flex'], ['align-items', f.multiline ? 'flex-start' : 'center'], ...paddingDecls(cs));
    if (f.button) decls.push(['justify-content', 'center']);
    if (!decls.some(([k]) => k === 'overflow')) decls.push(['overflow', 'hidden']);
    const tcs = f.placeholder ? this.env.style(el, '::placeholder') : cs;
    const content = this.content(box, cs);
    const p: Decl[] = [['flex-shrink', '0'], ['width', textWidth(content.w)], ...textDecls(tcs).filter(([k]) => k !== 'white-space'), ['white-space', f.multiline ? 'pre-wrap' : 'nowrap']];
    const inner = f.text ? `<p${attrs(p)}>${escText(f.text).replace(/\r?\n/g, '<br>')}</p>` : '';
    return `<div${attrs(decls, el.getAttribute('name') || el.getAttribute('aria-label') || undefined)}>${inner}</div>`;
  }

  embed(el: Element, cs: CSSStyleDeclaration, box: Box, mode: Mode): string {
    const host = embedHost(el);
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
  env = memoStyles(env);
  await env.loadMotions?.();
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
  const single = els.length === 1 && targets !== 'page';
  const first = els[0]!;
  const paint: Decl[] = [
    // Only a whole page gets the page colour behind it; a picked element keeps its own background, or none.
    ...(targets === 'page' ? ([['background-color', backdrop(first, env)]] as Decl[]) : []),
    ...(single ? rootClip(first, env) : []),
  ];
  const name = snapshotName(meta);
  // Keyframes travel as an attribute (clipboard sanitisers drop <style>); the app stores them in the file.
  const keyframes = s.keyframes.size ? ` ${KEYFRAMES_ATTR}="${escAttr(s.keyframes.css())}"` : '';
  // The attribute marks the root too: Chrome's async clipboard sanitiser can drop the comment.
  const marks = `${SNAPSHOT_ATTR}="v1"${keyframes} data-source="${escAttr(meta.url)}"`;
  // A lone target is the snapshot itself; one that clips itself keeps the wrapper for the outer clip.
  const ownClip = !/^(none)?$/.test(get(env.style(first), 'clip-path'));
  const flat = single && !(ownClip && paint.some(([k]) => k === 'clip-path')) ? targetAsRoot(parts[0]!, marks, name, paint, s.svgDefs.html()) : null;
  if (flat) return `${SNAPSHOT_MARKER}${flat}`;
  const root = styleAttr([
    ['position', 'relative'],
    ['width', px(Math.max(0, left - TARGET_GAP))],
    ['height', px(Math.max(0, ...boxes.map((b) => b.h)))],
    ...paint,
  ]);
  return `${SNAPSHOT_MARKER}<div ${marks} layer-name="${escAttr(name)}" style="${root}">${s.svgDefs.html()}${concat(parts)}</div>`;
}
