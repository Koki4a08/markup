// apps/app type-checks this file too (its snapshot paste test runs the real capture), so name the chrome types here.
/// <reference types="chrome" />
import { fetchImage as fetchImageBytes } from '../imageFetch';
import { canvasPng, readBlob, SAFE_IMAGE } from './images';
import { animationTarget, cssAnimationRecords, documentMotionCss, recordOf, type KeyframesRegistry, type MotionRecord, type PageMotionCss } from './motion';
import { animatedVarDecls } from './motionVars';
import type { Decl } from './styles';
import type { SvgDefs } from './svgDefs';
import { screenRegions } from './screen';

export type Pseudo = '::before' | '::after' | '::placeholder';

/** Everything capture reads from the live page. Injectable so tests can run without layout. */
export interface CaptureEnv {
  style(el: Element, pseudo?: Pseudo): CSSStyleDeclaration;
  /** Border box in page coordinates (viewport rect + scroll offset). */
  rect(el: Element): DOMRect;
  /** A data:image/(png|jpeg|gif|webp|avif) URL for the image, or null when it cannot be loaded. */
  fetchImage(url: string): Promise<string | null>;
  /** Page-coordinate bounds of a run of text and inline nodes, or null when unknown. */
  textRect?(nodes: Node[]): DOMRect | null;
  /** A PNG data URL of what the visible tab shows inside a page-coordinate rect, or null when it is off screen. */
  snapshotRegion?(rect: DOMRect): Promise<string | null>;
  /**
   * The computed style of a blank, unrendered div (the initial values the exact serializer leaves out). Read once
   * per capture; the exact serializer falls back to the CSS initial values when absent.
   */
  blankStyle?(): CSSStyleDeclaration | null;
  /**
   * A frame of the canvas recorded while it was on screen and drawing (whole-page pass), as a data URL. WebGL
   * canvases clear their buffer after every frame and many pages stop drawing off screen, so a readback at
   * capture time is often blank.
   */
  canvasFrame?(el: HTMLCanvasElement): string | null;
  /**
   * Subtrees the page mounted only while they were in view and has since removed again (lazy demos, virtualised
   * lists), serialized when they were on screen: `index` is their place among el's element children.
   */
  mountedSnapshots?(el: Element): { index: number; html: string }[];
  /**
   * The animations el (or its ::before / ::after, whose computed style is `cs`) runs or ran: CSS animations,
   * transitions and Web Animations, live now or recorded while the whole-page pass revealed it.
   */
  motions?(el: Element, pseudo?: '::before' | '::after', cs?: CSSStyleDeclaration): MotionRecord[];
  /** Reads what motions() needs ahead of a capture (the page's @keyframes, cross-origin sheets included). */
  loadMotions?(): Promise<void>;
  /**
   * Declarations that keep animated custom properties (@property) driving el: their current values, the
   * declarations using them as the page wrote them, and the @property rules to carry along.
   */
  motionVars?(el: Element, pseudo: string, cs: CSSStyleDeclaration, records: MotionRecord[]): { decls: Decl[]; rules: [string, string][] };
  /** An animated WebP of a canvas (shader) or video, recorded while it was on screen and moving. */
  motionClip?(el: Element): string | null;
  /** Where a capture collects the @keyframes its layers use; shared with the pass that records subtrees. */
  keyframes?: KeyframesRegistry;
  /** Where a capture collects the SVG filters and clip paths its CSS points at; shared like `keyframes`. */
  svgDefs?: SvgDefs;
}

/** How long an index of the document's animations is reused: one capture reads it for every element. */
const ANIMATION_INDEX_MS = 400;

const fetchCss = async (url: string): Promise<string | null> => {
  const r = await fetch(url, { credentials: 'omit' }).catch(() => null);
  return r?.ok ? r.text() : null;
};

/**
 * The animations running (or holding their end state) in a document, by target element, read live; plus the CSS
 * animations an element's style names that have already ended, rebuilt from the page's @keyframes once
 * `load` has read them.
 */
export function liveMotions(doc: Document): { motions: NonNullable<CaptureEnv['motions']>; load: () => Promise<void>; vars: NonNullable<CaptureEnv['motionVars']> } {
  let index: Map<Element, Animation[]> | null = null;
  let built = 0;
  let css: PageMotionCss | null = null;
  let loading: Promise<void> | null = null;
  const load = () => (loading ??= documentMotionCss(doc, fetchCss).then((m) => void (css = m), () => undefined));
  const running = (el: Element, pseudo: string): MotionRecord[] => {
    if (typeof doc.getAnimations !== 'function') return [];
    if (!index || performance.now() - built > ANIMATION_INDEX_MS) {
      index = new Map();
      built = performance.now();
      for (const a of doc.getAnimations()) {
        const t = animationTarget(a);
        if (!t || a.playState === 'idle') continue;
        const list = index.get(t.el) ?? [];
        list.push(a);
        index.set(t.el, list);
      }
    }
    return (index.get(el) ?? []).filter((a) => animationTarget(a)!.pseudo === pseudo).flatMap((a) => recordOf(a) ?? []);
  };
  return {
    load,
    motions(el, pseudo, cs) {
      const live = running(el, pseudo ?? '');
      if (!css || !cs) return live;
      const ended = cssAnimationRecords(cs, (name) => css!.keyframes.get(name), new Set(live.map((r) => r.label)));
      return [...live, ...ended];
    },
    vars: (el, pseudo, cs, records) => animatedVarDecls(el, pseudo, cs, records, css),
  };
}

/**
 * One download per image URL for the whole capture: the whole-page pass serializes subtrees with their own
 * loaders, and the final capture reads the same images again.
 */
export function sharedImageFetches(env: CaptureEnv): CaptureEnv {
  const fetched = new Map<string, Promise<string | null>>();
  return {
    ...env,
    fetchImage(url) {
      let hit = fetched.get(url);
      if (!hit) fetched.set(url, (hit = env.fetchImage(url)));
      return hit;
    },
  };
}

const MAX_RASTER_SIDE = 4096;

/** Re-encodes an image the app would not accept (SVG, BMP, ICO…) as PNG. */
async function rasterize(doc: Document, dataUrl: string): Promise<string | null> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const svg = /^data:image\/svg/i.test(dataUrl);
    const scale = svg ? 2 : 1;
    const w = Math.max(1, img.naturalWidth || 300) * scale;
    const h = Math.max(1, img.naturalHeight || 150) * scale;
    const fit = Math.min(1, MAX_RASTER_SIDE / Math.max(w, h));
    const canvas = doc.createElement('canvas');
    canvas.width = Math.round(w * fit);
    canvas.height = Math.round(h * fit);
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await canvasPng(canvas);
  } catch {
    return null;
  }
}

async function normalize(doc: Document, dataUrl: string | undefined | null): Promise<string | null> {
  if (!dataUrl) return null;
  if (SAFE_IMAGE.test(dataUrl)) return dataUrl;
  if (/^data:image\//i.test(dataUrl)) return rasterize(doc, dataUrl);
  return null;
}

/** The live page: computed styles, layout rects, and images through the background proxy. */
export function browserEnv(win: Window = window): CaptureEnv {
  const doc = win.document;
  const sameOrigin = (url: string) => {
    try {
      return typeof win.fetch === 'function' && new URL(url).origin === win.location.origin;
    } catch {
      return false;
    }
  };
  const shift = (r: DOMRect) => new DOMRect(r.x + win.scrollX, r.y + win.scrollY, r.width, r.height);
  const live = liveMotions(doc);
  return {
    snapshotRegion: screenRegions(win),
    motions: live.motions,
    loadMotions: live.load,
    motionVars: live.vars,
    blankStyle() {
      // A hidden iframe is a clean document: none of the page's own CSS reaches its div. It is marked so a capture
      // running meanwhile skips it, and removed once the values are copied out.
      const frame = doc.createElement('iframe');
      frame.setAttribute('data-markup-snapshot', '');
      frame.style.cssText = 'display:none';
      doc.documentElement.appendChild(frame);
      try {
        const fdoc = frame.contentDocument;
        const fwin = frame.contentWindow;
        if (!fdoc || !fwin) return null;
        const div = fdoc.createElement('div');
        (fdoc.body ?? fdoc.documentElement).appendChild(div);
        const live = fwin.getComputedStyle(div);
        const copy: Record<string, string> = {};
        for (let i = 0; i < live.length; i++) copy[live[i]!] = live.getPropertyValue(live[i]!);
        return { getPropertyValue: (p: string) => copy[p] ?? '' } as unknown as CSSStyleDeclaration;
      } finally {
        frame.remove();
      }
    },
    style: (el, pseudo) => win.getComputedStyle(el, pseudo),
    rect: (el) => shift(el.getBoundingClientRect()),
    textRect(nodes) {
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return null;
      const range = doc.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
      const r = range.getBoundingClientRect();
      return r.width || r.height ? shift(r) : null;
    },
    async fetchImage(url) {
      try {
        if (/^data:/i.test(url)) return await normalize(doc, url);
        if (/^blob:/i.test(url)) return await normalize(doc, await readBlob(await (await fetch(url)).blob()));
        if (!/^https?:/i.test(url)) return null;
        // A same-origin image is fetched here first: the page's own HTTP cache usually has it, while the
        // background worker's cache is partitioned apart and would download it again. Same request as the
        // background's (no credentials, same size and type checks); anything that fails goes through it.
        if (sameOrigin(url)) {
          const own = await fetchImageBytes(url, (u, init) => win.fetch(u, { ...init, cache: 'force-cache' })).catch(() => null);
          if (own && 'dataUrl' in own) return await normalize(doc, own.dataUrl);
        }
        const res = (await chrome.runtime.sendMessage({ type: 'fetch-image', url })) as { dataUrl?: string; error?: string } | undefined;
        return await normalize(doc, res?.dataUrl);
      } catch {
        return null;
      }
    },
  };
}
