import { describe, expect, it } from 'vitest';
import { preparePage } from '../src/capture/prepare';

describe('preparePage', () => {
  it('loads lazy images for the capture, reports progress up to 1 and restores the page', async () => {
    document.body.innerHTML = '<div id="t"><img loading="lazy" alt=""></div>';
    const img = document.querySelector('img')!;
    const root = document.getElementById('t')!;
    const seen: number[] = [];
    let eagerDuring = false;
    const watch = setInterval(() => (eagerDuring ||= img.loading === 'eager'), 5);
    await preparePage(document, [root], { scroll: false, onProgress: (p) => seen.push(p) });
    clearInterval(watch);
    expect(eagerDuring).toBe(true);
    expect(img.loading).toBe('lazy');
    expect(seen.at(-1)).toBe(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  it('stops early when cancelled', async () => {
    const cancel = new AbortController();
    cancel.abort();
    const t0 = Date.now();
    await preparePage(document, [document.body], { scroll: true, signal: cancel.signal });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
