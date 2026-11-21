import { describe, expect, it } from 'vitest';
import type { CaptureEnv } from '../src/capture/env';
import { trackProgress } from '../src/capture/progress';

describe('trackProgress', () => {
  it('counts styled elements and image reads as one continuous fraction that ends at 1', async () => {
    document.body.innerHTML = `<div id="r">${'<p>x</p>'.repeat(30)}<img alt=""><img alt=""></div>`;
    const root = document.getElementById('r')!;
    const seen: number[] = [];
    const base: CaptureEnv = { style: (el) => getComputedStyle(el), rect: () => new DOMRect(), fetchImage: async () => null };
    const env = trackProgress(base, [root], (f) => seen.push(f));
    env.style(root);
    for (const el of root.querySelectorAll('*')) env.style(el);
    const reads = [env.fetchImage('a'), env.fetchImage('b')];
    await Promise.all(reads);
    expect(seen.at(-1)).toBe(1);
    // The images were expected from the start, so the fraction only ever grows.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});
