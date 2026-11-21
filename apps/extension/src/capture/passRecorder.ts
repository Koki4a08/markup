import type { CaptureEnv } from './env';
import { blankImage } from './exact';
import { canvasDataUrl } from './images';
import { animationTarget, incidentalTransition, KeyframesRegistry, parseInline, recordOf, revealRecord, type MotionRecord } from './motion';
import { clipWorthy, recordClips, type ClipSource } from './motionClip';
import { SvgDefs } from './svgDefs';

/**
 * What a whole-page pass sees while each part of the page is on screen, kept for the serializer that runs
 * after the page is scrolled back:
 * - canvas frames: WebGL clears its buffer after every frame and many pages stop drawing off screen, so a
 *   frame is read right after the page draws one (a double requestAnimationFrame) while the canvas is in view;
 * - mounted subtrees: pages that mount demos or list rows only while they are visible (IntersectionObserver)
 *   remove them again when scrolled away; such a subtree is serialized while it is on screen and settled;
 * - motion: the animations and transitions the page starts as it is scrolled (scroll reveals: fade-ins, blur-ins,
 *   slide-ups), and reveals scripts drive through the inline style, which are gone once they finish;
 * - clips: shaders, animated canvases and playing videos, recorded for a few seconds while on screen.
 */
export class PassRecorder {
  private readonly frames = new WeakMap<HTMLCanvasElement, string>();
  private readonly snapshots: { parent: Element; index: number; childCount: number; el: WeakRef<Element>; html: string }[] = [];
  private readonly added = new Set<Element>();
  private observer: MutationObserver | null = null;
  private styleObserver: MutationObserver | null = null;
  private lastMutation = 0;
  private readonly motion = new Map<Element, { pseudo: string; record: MotionRecord; key: string }[]>();
  private readonly seenAnimations = new WeakSet<Animation>();
  /** The inline style each element had before the page first changed it during the pass, and when it changed. */
  private readonly styleChanges = new Map<Element, { before: string; first: number; last: number }>();
  private sampling = false;
  private readonly clips = new WeakMap<Element, string>();
  private readonly clipTried = new WeakSet<Element>();
  /** The @keyframes of this capture: subtrees serialized during the pass and the final capture share it. */
  readonly keyframes = new KeyframesRegistry();
  readonly svgDefs = new SvgDefs();

  constructor(
    private readonly doc: Document,
    /** Serializes one element as the capture would; absent when the mode cannot splice subtrees back. */
    private readonly serialize?: (el: Element) => Promise<string>,
  ) {}

  /** Starts watching for subtrees the page adds while it is scrolled. */
  start(): void {
    const win = this.doc.defaultView!;
    this.observer = new win.MutationObserver((records) => {
      this.lastMutation = performance.now();
      for (const r of records) {
        for (const n of Array.from(r.addedNodes)) {
          if (n.nodeType === 1 && !(n as Element).closest('[data-markup-snapshot]')) this.added.add(n as Element);
        }
      }
    });
    this.observer.observe(this.doc.documentElement, { childList: true, subtree: true });
    // Style changes are watched apart from structure: a script animating every frame must not keep
    // `settled` waiting.
    this.styleObserver = new win.MutationObserver((records) => {
      const now = performance.now();
      for (const r of records) {
        const el = r.target as Element;
        const seen = this.styleChanges.get(el);
        if (seen) seen.last = now;
        else if (!el.closest('[data-markup-snapshot]')) this.styleChanges.set(el, { before: r.oldValue ?? '', first: now, last: now });
      }
    });
    this.styleObserver.observe(this.doc.documentElement, { attributes: true, attributeFilter: ['style'], attributeOldValue: true, subtree: true });
    this.sampleAnimations();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.styleObserver?.disconnect();
    this.styleObserver = null;
    this.sampling = false;
  }

  /**
   * Reads every animation the page starts while the pass runs, each frame: a reveal transition or a script's
   * element.animate() lasts well under a second and is gone (or committed into the style) once it ends.
   */
  private sampleAnimations(): void {
    const win = this.doc.defaultView!;
    if (typeof this.doc.getAnimations !== 'function' || typeof win.requestAnimationFrame !== 'function') return;
    this.sampling = true;
    const tick = () => {
      if (!this.sampling) return;
      for (const a of this.doc.getAnimations()) {
        if (this.seenAnimations.has(a)) continue;
        this.seenAnimations.add(a);
        const t = animationTarget(a);
        if (!t || t.el.closest('[data-markup-snapshot]') || incidentalTransition(a)) continue;
        const record = recordOf(a);
        if (!record) continue;
        // One per element, pseudo-element and motion: a reveal that runs again on the way back up is the same.
        const key = `${t.pseudo}|${record.label}|${record.frames.map((f) => f.props.map(([p]) => p).join()).join('/')}`;
        const list = this.motion.get(t.el) ?? [];
        if (list.some((m) => m.key === key)) continue;
        list.push({ pseudo: t.pseudo, record, key });
        this.motion.set(t.el, list);
      }
      win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
  }

  /**
   * The motion recorded for el during the pass: animations it ran, else a reveal its inline style went through
   * (the style before the page first changed it, against now).
   */
  motions = (el: Element, pseudo = ''): MotionRecord[] => {
    const recorded = (this.motion.get(el) ?? []).filter((m) => m.pseudo === pseudo).map((m) => m.record);
    if (recorded.length || pseudo) return recorded;
    const change = this.styleChanges.get(el);
    if (!change || !el.isConnected) return [];
    const reveal = revealRecord(parseInline(change.before), this.doc.defaultView!.getComputedStyle(el), change.last - change.first);
    return reveal ? [reveal] : [];
  };

  /** Records a looping clip of each shader, animated canvas and playing video on screen (once per element). */
  async recordClips(roots: Element[] = [this.doc.documentElement], signal?: AbortSignal): Promise<void> {
    const win = this.doc.defaultView!;
    const sources = roots
      .flatMap((r) => (/^(canvas|video)$/.test(r.localName) ? [r] : [...r.querySelectorAll('canvas, video')]))
      .filter((el): el is ClipSource => !this.clipTried.has(el) && clipWorthy(el as ClipSource) && inView(el, win) && !el.closest('[data-markup-snapshot]'));
    if (!sources.length) return;
    sources.forEach((s) => this.clipTried.add(s));
    const clips = await recordClips(win, sources, {}, signal).catch(() => new Map<ClipSource, string>());
    for (const [el, data] of clips) this.clips.set(el, data);
  }

  motionClip = (el: Element): string | null => this.clips.get(el) ?? null;

  /** The env the serializers read through: the page as it is now, plus what this pass recorded. */
  withRecording(env: CaptureEnv): CaptureEnv {
    return {
      ...env,
      canvasFrame: this.canvasFrame,
      mountedSnapshots: this.mountedSnapshots,
      motionClip: this.motionClip,
      keyframes: this.keyframes,
      svgDefs: this.svgDefs,
      motions: (el, pseudo, cs) => {
        const recorded = this.motions(el, pseudo);
        // What the pass saw wins over the same animation read again now (its end state, or rebuilt from CSS).
        const labels = new Set(recorded.map((r) => r.label).filter(Boolean));
        return [...recorded, ...(env.motions?.(el, pseudo, cs) ?? []).filter((r) => !labels.has(r.label))];
      },
    };
  }

  /** Waits until the page has stopped changing its DOM for `quietMs` (at most `maxMs`). */
  async settled(quietMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
    const start = performance.now();
    this.lastMutation = Math.max(this.lastMutation, start);
    while (!signal?.aborted && performance.now() - start < maxMs) {
      if (performance.now() - this.lastMutation >= quietMs) return;
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  /** Reads every canvas on screen right after the page draws its next frame. */
  async recordCanvases(): Promise<void> {
    const win = this.doc.defaultView!;
    const canvases = Array.from(this.doc.getElementsByTagName('canvas')).filter((c) => c.width > 0 && c.height > 0 && inView(c, win));
    if (!canvases.length) return;
    // Registered from inside a frame callback, the second callback runs after the page's own draw in the
    // next frame, before the buffer is presented and cleared.
    await new Promise<void>((resolve) => win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve())));
    // Every toBlob runs now, inside this frame (the bitmap is copied at call time); encoding happens off the
    // main thread. Lossless, like a readback at capture time. A tainted canvas rejects and is skipped.
    const reads = canvases.map((c) => [c, canvasDataUrl(c, 'image/png').catch(() => null)] as const);
    for (const [c, read] of reads) {
      const data = await read;
      if (data && !(await blankImage(this.doc, data))) this.frames.set(c, data);
    }
  }

  /** Serializes the subtrees added during the pass that are on screen now, outermost only. */
  async recordMounted(): Promise<void> {
    if (!this.serialize) return;
    const win = this.doc.defaultView!;
    const live = new Set<Element>();
    for (const el of this.added) {
      // A removed element can never be recorded again (its snapshot, if any, is already kept).
      if (!el.isConnected || !el.parentElement) {
        this.added.delete(el);
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width >= 40 && r.height >= 40 && inView(el, win)) live.add(el);
    }
    // Outermost only: no ancestor is itself in the set (an ancestor walk, not a pairwise contains()).
    const outer = [...live].filter((el) => {
      for (let a = el.parentElement; a; a = a.parentElement) if (live.has(a)) return false;
      return true;
    });
    for (const el of outer) {
      const parent = el.parentElement!;
      const index = Array.prototype.indexOf.call(parent.children, el);
      const html = await this.serialize(el).catch(() => '');
      if (!html) continue;
      // The latest view of the same slot wins (demos keep building while they are on screen).
      const i = this.snapshots.findIndex((s) => s.parent === parent && s.index === index);
      const entry = { parent, index, childCount: parent.children.length, el: new WeakRef(el), html };
      if (i >= 0) this.snapshots[i] = entry;
      else this.snapshots.push(entry);
    }
  }

  canvasFrame = (el: HTMLCanvasElement): string | null => this.frames.get(el) ?? null;

  /**
   * Recorded subtrees of `parent` whose slot is empty now: the element left and the parent holds fewer children
   * than when it was recorded (the page unmounted it). An element the page merely re-created in place (an
   * animated heading) leaves the count unchanged, and its current copy is serialized normally instead.
   */
  mountedSnapshots = (parent: Element): { index: number; html: string }[] => {
    const entries = this.snapshots.filter((s) => {
      if (s.parent !== parent) return false;
      const el = s.el.deref();
      return (!el || !el.isConnected || el.parentElement !== parent) && parent.children.length < s.childCount;
    });
    // Never more than the children that went missing, newest view of each slot first.
    const missing = Math.max(0, Math.max(0, ...entries.map((s) => s.childCount)) - parent.children.length);
    return entries.slice(0, missing).map(({ index, html }) => ({ index, html }));
  };
}

function inView(el: Element, win: Window): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
}
