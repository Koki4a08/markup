import { describe, expect, it, vi } from 'vitest';
import { sharedImageFetches, type CaptureEnv } from '../src/capture/env';
import { ImageLoader } from '../src/capture/images';

const png = (n: number) => `data:image/png;base64,${'A'.repeat(n)}`;

describe('capture sharing across the whole-page pass', () => {
  it('downloads each image URL once for every serialization that shares the env', async () => {
    const fetchImage = vi.fn(async (url: string) => png(10) + url.length);
    const env = sharedImageFetches({ style: () => ({}) as CSSStyleDeclaration, rect: () => new DOMRect(), fetchImage } as CaptureEnv);
    const pass = new ImageLoader(env);
    const final = new ImageLoader(env);
    await pass.get('https://x/a.png');
    await final.get('https://x/a.png');
    await final.get('https://x/b.png');
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('charges recorded subtree images against the capture budget', () => {
    const loader = new ImageLoader({} as CaptureEnv, { imageBytes: 100, concurrency: 1 });
    const html = `<div><img src="${png(40)}"><p>text</p></div>`;
    expect(loader.admitHtml(html)).toBe(true);
    expect(loader.admitHtml(html)).toBe(false);
    expect(loader.admitHtml('<p>no images</p>')).toBe(true);
    // A failed charge takes nothing, so a smaller image still fits.
    expect(loader.admit(png(10))).not.toBeNull();
  });
});
