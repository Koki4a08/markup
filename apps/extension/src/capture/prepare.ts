import type { PassRecorder } from './passRecorder';
/**
 * Gets a page fully loaded before it is captured, so a snapshot holds what a reader would see after
 * scrolling through it: lazy images fetched, scroll-triggered content revealed, web fonts in, and
 * entrance animations finished. The page is scrolled back to where the user left it.
 */

export interface PrepareOptions {
  /** Whole page: scroll through it top to bottom first. Elements only wait for what they contain. */
  scroll: boolean;
  onProgress?(fraction: number): void;
  /** Stop early (the user cancelled). */
  signal?: AbortSignal;
  /** Covers the tab before scrolling; resolves false when it cannot, and the page is then not scrolled. */
  hideScrolling?(): Promise<boolean>;
  /** Called once scrolling is over and the page is back where the user left it. */
  afterScrolling?(): void;
  /** Records canvas frames and in-view-only subtrees at each step, for the serializer that runs afterwards. */
  recorder?: PassRecorder;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

const frames = (win: Window, n = 2) =>
  new Promise<void>((resolve) => {
    if (typeof win.requestAnimationFrame !== 'function') return resolve();
    const step = (left: number) => (left ? win.requestAnimationFrame(() => step(left - 1)) : resolve());
    step(n);
  });

const withTimeout = <T>(work: Promise<T>, ms: number) => Promise.race([work.then(() => undefined, () => undefined), sleep(ms)]);

/** Resolves once the document has finished loading (or after `ms`). */
function loaded(win: Window, ms: number): Promise<void> {
  if (win.document.readyState === 'complete') return Promise.resolve();
  return withTimeout(new Promise<void>((resolve) => win.addEventListener('load', () => resolve(), { once: true })), ms);
}

/**
 * Resource loads that do not change what the capture sees: beacons and 'other' (pings, long polls). Leaving
 * them out lets a page with steady analytics traffic still go quiet. Images, CSS, fonts, fetch and XHR
 * (lazy sections and infinite scroll load their content that way) all count.
 */
const IGNORED_INITIATORS = new Set(['beacon', 'other']);

/** When a relevant network resource last finished loading (0 before any), watched for the whole prepare. */
export interface NetworkWatch {
  last(): number;
  stop(): void;
}

/**
 * Watches resource timing entries as they arrive. An observer keeps reporting after the page's resource
 * timing buffer is full (where the count of buffered entries stops changing) and allocates nothing per
 * poll. Without one it falls back to polling the count of buffered entries.
 */
export function watchNetwork(win: Window): NetworkWatch {
  let last = 0;
  const Observer = (win as Window & { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (typeof Observer === 'function') {
    try {
      const observer = new Observer((list) => {
        if (list.getEntries().some((e) => !IGNORED_INITIATORS.has((e as PerformanceResourceTiming).initiatorType))) last = Date.now();
      });
      observer.observe({ type: 'resource', buffered: false });
      return { last: () => last, stop: () => observer.disconnect() };
    } catch {
      // Cannot observe resource entries here: poll instead.
    }
  }
  const perf = win.performance;
  const count = () => perf?.getEntriesByType?.('resource').length ?? 0;
  let seen = count();
  return {
    last() {
      const now = count();
      if (now !== seen) {
        seen = now;
        last = Date.now();
      }
      return last;
    },
    stop() {},
  };
}

/** Resolves when no relevant network resource has finished for `quietMs`, at most `maxMs`. */
async function networkQuiet(net: NetworkWatch, quietMs: number, maxMs: number, signal?: AbortSignal): Promise<void> {
  const start = Date.now();
  net.last(); // Activity before this wait does not count against it.
  while (!signal?.aborted && Date.now() - start < maxMs) {
    await sleep(100, signal);
    if (Date.now() - Math.max(start, net.last()) >= quietMs) return;
  }
}

/** Waits for the images under the roots to finish loading and decoding, each at most `ms`; reports done/total. */
async function imagesReady(roots: Element[], ms: number, onProgress?: (fraction: number) => void): Promise<void> {
  const imgs = roots.flatMap((r) => (r instanceof HTMLImageElement ? [r] : [...r.querySelectorAll('img')]));
  if (!imgs.length) return onProgress?.(1);
  const win = imgs[0]!.ownerDocument.defaultView;
  let done = 0;
  const one = () => onProgress?.(++done / imgs.length);
  // Only on-screen pixels are ever read back (the screenshot fallback); every other image is fetched again
  // by URL, so decoding it here would only cost time and memory.
  const decode = (img: HTMLImageElement) => (win && onScreen(img, win) ? img.decode?.() : undefined);
  await Promise.all(
    imgs.map((img) => {
      // complete covers loaded, broken and src-less images alike; only a pending one is waited for.
      const work = img.complete
        ? img.naturalWidth
          ? withTimeout(decode(img) ?? Promise.resolve(), ms)
          : Promise.resolve()
        : withTimeout(
            new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }).then(() => decode(img)),
            ms,
          );
      return work.then(one);
    }),
  );
}

const onScreen = (img: Element, win: Window) => {
  const r = img.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
};

/** Waits (at most `ms`) for the images under the roots that are on screen and still loading. */
async function viewportImagesLoaded(roots: Element[], win: Window, ms: number, signal?: AbortSignal): Promise<void> {
  const pending = roots
    .flatMap((r) => (r instanceof HTMLImageElement ? [r] : [...r.getElementsByTagName('img')]))
    .filter((img) => !img.complete && onScreen(img, win));
  if (!pending.length) return;
  const settled = pending.map(
    (img) =>
      new Promise<void>((resolve) => {
        img.addEventListener('load', () => resolve(), { once: true });
        img.addEventListener('error', () => resolve(), { once: true });
      }),
  );
  await Promise.race([Promise.all(settled), sleep(ms, signal)]);
}

/** Lets finite entrance animations and transitions finish (looping ones are left alone), at most `ms`. */
async function animationsSettled(doc: Document, ms: number): Promise<void> {
  const running = (doc.getAnimations?.() ?? []).filter((a) => {
    const timing = a.effect?.getComputedTiming?.();
    return a.playState === 'running' && timing && Number.isFinite(timing.endTime as number);
  });
  if (running.length) await withTimeout(Promise.all(running.map((a) => a.finished)), ms);
}

/** Loading="lazy" images load now instead of waiting to be scrolled to; returns a function that restores them. */
function eagerImages(roots: Element[]): () => void {
  const lazy = roots.flatMap((r) => [...r.querySelectorAll<HTMLImageElement>('img[loading="lazy"]')]);
  for (const img of lazy) img.loading = 'eager';
  return () => {
    for (const img of lazy) img.loading = 'lazy';
  };
}

/** After this long scrolling, later steps stop waiting on images and the network (they still pause). */
const SCROLL_BUDGET_MS = 15_000;

/** Shares of the loading bar per step, measured from how long each takes on typical pages. */
const WEIGHTS = { load: 0.05, scroll: 0.55, settle: 0.12, fonts: 0.05, images: 0.18, animations: 0.05 };

export async function preparePage(doc: Document, roots: Element[], opts: PrepareOptions): Promise<void> {
  const win = doc.defaultView!;
  const { signal } = opts;
  let base = 0;
  const report = (f: number) => opts.onProgress?.(Math.min(1, Math.max(0, f)));
  /** Progress inside one step: `part` of that step's weight is done. */
  const within = (weight: number) => (part: number) => report(base + weight * Math.min(1, part));
  const next = (weight: number) => {
    base += weight;
    report(base);
  };
  report(0);
  await loaded(win, 8000);
  next(WEIGHTS.load);
  if (signal?.aborted) return;
  const restoreLazy = eagerImages(roots);
  const net = watchNetwork(win);
  try {
    // Scrolling happens under a still picture of the tab (see ScrollCover); without one the page is
    // not scrolled at all, only its lazy images are loaded.
    const hidden = opts.scroll && (opts.hideScrolling ? await opts.hideScrolling() : true);
    if (hidden && !signal?.aborted) {
      opts.recorder?.start();
      const start = { x: win.scrollX, y: win.scrollY };
      const behavior = 'instant' as ScrollBehavior;
      const scroller = doc.scrollingElement ?? doc.documentElement;
      const step = Math.max(200, Math.round(win.innerHeight * 0.9));
      const scroll = within(WEIGHTS.scroll);
      let y = 0;
      const began = Date.now();
      win.scrollTo({ left: 0, top: 0, behavior });
      await sleep(120, signal);
      // Step down a viewport at a time, pausing so lazy loaders and scroll reveals fire, until the bottom
      // stops moving (pages that grow while scrolled get their new content too). Each step waits for the
      // images it brought on screen and a short network lull; past the time budget it only pauses.
      for (let guard = 0; guard < 80 && !signal?.aborted; guard++) {
        const max = Math.max(0, scroller.scrollHeight - win.innerHeight);
        scroll(max ? y / max : 1);
        if (y >= max) break;
        y = Math.min(max, y + step);
        win.scrollTo({ left: 0, top: y, behavior });
        await sleep(160, signal);
        const inBudget = Date.now() - began < SCROLL_BUDGET_MS;
        if (inBudget) {
          await Promise.all([networkQuiet(net, 200, 800, signal), viewportImagesLoaded(roots, win, 1500, signal)]);
        }
        if (opts.recorder && !signal?.aborted) {
          // Content mounted for this screen (demos, rows) settles, then is recorded while it is on screen.
          await opts.recorder.settled(350, inBudget ? 1500 : 600, signal);
          await opts.recorder.recordCanvases();
          await opts.recorder.recordClips(roots, signal);
          await opts.recorder.recordMounted();
        }
      }
      scroll(1);
      win.scrollTo({ left: start.x, top: start.y, behavior });
      await frames(win);
      if (opts.recorder && !signal?.aborted) {
        // What remounts at the start position (an intro demo that restarts) gets time to build again.
        await opts.recorder.settled(500, 3000, signal);
        await opts.recorder.recordCanvases();
        opts.recorder.stop();
      }
      opts.afterScrolling?.();
    } else {
      opts.afterScrolling?.();
    }
    next(WEIGHTS.scroll);
    await networkQuiet(net, opts.scroll ? 450 : 300, opts.scroll ? 4000 : 2500, signal);
    next(WEIGHTS.settle);
    if (signal?.aborted) return;
    await withTimeout(doc.fonts?.ready ?? Promise.resolve(), 4000);
    next(WEIGHTS.fonts);
    if (signal?.aborted) return;
    await imagesReady(roots, 5000, within(WEIGHTS.images));
    next(WEIGHTS.images);
    if (signal?.aborted) return;
    await animationsSettled(doc, 2500);
    await frames(win);
    // A selection is on screen already: its shaders and videos are recorded as they play now.
    if (!opts.scroll && opts.recorder && !signal?.aborted) await opts.recorder.recordClips(roots, signal);
    report(1);
  } finally {
    opts.recorder?.stop();
    net.stop();
    restoreLazy();
  }
}
