import { describe, expect, it, vi } from 'vitest';
import { fetchImage, isTrustedSender } from '../src/imageFetch';

function res(chunks: Uint8Array[], headers: Record<string, string>, onRead?: () => void) {
  let i = 0;
  const cancel = vi.fn(async () => {});
  const read = vi.fn(async () => {
    onRead?.();
    return i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined };
  });
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: { getReader: () => ({ read, cancel }), cancel },
    read,
    cancel,
  };
}
const fx = (r: ReturnType<typeof res>) => vi.fn(async () => r as unknown as Response);

describe('fetchImage', () => {
  it('rejects Content-Length over the cap without reading', async () => {
    const r = res([new Uint8Array(1)], { 'content-type': 'image/png', 'content-length': '100' });
    expect(await fetchImage('https://x.test/a.png', fx(r), 10)).toEqual({ error: 'image too large' });
    expect(r.read).not.toHaveBeenCalled();
  });

  it('aborts a streamed body that passes the cap', async () => {
    const r = res([new Uint8Array(6), new Uint8Array(6), new Uint8Array(6)], { 'content-type': 'image/png' });
    expect(await fetchImage('https://x.test/a.png', fx(r), 10)).toEqual({ error: 'image too large' });
    expect(r.read).toHaveBeenCalledTimes(2);
    expect(r.cancel).toHaveBeenCalled();
  });

  it('rejects non-image and missing content types', async () => {
    const a = res([new Uint8Array(1)], { 'content-type': 'text/html' });
    const b = res([new Uint8Array(1)], {});
    expect(await fetchImage('https://x.test/a', fx(a))).toEqual({ error: 'not an image' });
    expect(await fetchImage('https://x.test/a', fx(b))).toEqual({ error: 'not an image' });
  });

  it('rejects non-http(s) urls without fetching', async () => {
    const f = vi.fn();
    for (const u of ['file:///etc/passwd', 'data:image/png;base64,AA==', 'chrome://x', 'nope'])
      expect(await fetchImage(u, f as never)).toHaveProperty('error');
    expect(f).not.toHaveBeenCalled();
  });

  it('returns a data url for a small image and omits credentials', async () => {
    const r = res([new Uint8Array([104, 105])], { 'content-type': 'image/png; charset=x' });
    const f = fx(r);
    expect(await fetchImage('https://x.test/a.png', f)).toEqual({ dataUrl: 'data:image/png;base64,aGk=' });
    expect(f).toHaveBeenCalledWith('https://x.test/a.png', expect.objectContaining({ credentials: 'omit' }));
  });
});

describe('isTrustedSender', () => {
  it('accepts only own-extension content scripts', () => {
    expect(isTrustedSender({ id: 'me', tab: {} }, 'me')).toBe(true);
    expect(isTrustedSender({ id: 'other', tab: {} }, 'me')).toBe(false);
    expect(isTrustedSender({ id: 'me' }, 'me')).toBe(false);
    expect(isTrustedSender(undefined, 'me')).toBe(false);
  });
});
