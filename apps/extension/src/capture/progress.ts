import type { CaptureEnv } from './env';

/**
 * Wraps a capture env so a capture reports how far along it is, without the serializers knowing.
 * Two signals: elements styled so far against the elements under the targets (the walk), and
 * image/region reads finished against those started (the slow, asynchronous part).
 */
export function trackProgress(env: CaptureEnv, targets: Element[] | 'page', onProgress: (fraction: number) => void): CaptureEnv {
  const roots = targets === 'page' ? [document.documentElement] : targets;
  // Only rendered elements are walked, so only they count; hidden subtrees would hold the bar short of 100%.
  const rendered = (el: Element) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : true);
  const total = Math.max(
    1,
    roots.reduce((n, root) => n + 1 + [...root.getElementsByTagName('*')].filter(rendered).length, 0),
  );
  const styled = new WeakSet<Element>();
  let walked = 0;
  let started = 0;
  let finished = 0;

  // One image or screen read costs about as much as styling this many elements. Counting both as units
  // of work keeps the fraction continuous: a newly started read only grows the total a little.
  const READ_COST = 20;
  // Reads are estimated up front from the media under the targets, so the total is known from the
  // start; reads beyond the estimate (CSS backgrounds) only grow it then.
  const expectedReads = roots.reduce((n, root) => n + root.querySelectorAll('img, video, canvas').length + (/^(img|video|canvas)$/i.test(root.tagName) ? 1 : 0), 0);
  const report = () =>
    onProgress(Math.min(1, (Math.min(walked, total) + finished * READ_COST) / (total + Math.max(expectedReads, started) * READ_COST)));

  const timed = <T>(work: Promise<T>): Promise<T> => {
    started++;
    report();
    return work.finally(() => {
      finished++;
      report();
    });
  };

  return {
    ...env,
    style(el, pseudo) {
      if (!pseudo && !styled.has(el)) {
        styled.add(el);
        walked++;
        if (walked % 10 === 0) report();
      }
      return env.style(el, pseudo);
    },
    fetchImage: (url) => timed(env.fetchImage(url)),
    snapshotRegion: env.snapshotRegion && ((rect) => timed(env.snapshotRegion!(rect))),
  };
}
