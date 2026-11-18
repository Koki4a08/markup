import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureAndCopy } from '../src/capture';
import { fakeEnv } from './fakeEnv';

class FakeItem {
  constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
});

function setup() {
  document.title = 'Acme';
  document.body.innerHTML = '<div id="t" data-rect="0 0 10 10" style="background-color: rgb(1, 2, 3)"></div>';
  vi.stubGlobal('ClipboardItem', FakeItem);
  return document.getElementById('t')!;
}

describe('captureAndCopy', () => {
  it('writes html and plain text in one clipboard item, starting inside the gesture', async () => {
    const el = setup();
    const write = vi.fn(async (_items: FakeItem[]) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { write }, configurable: true });
    const done = captureAndCopy([el], fakeEnv());
    expect(write).toHaveBeenCalledTimes(1); // synchronously, before any await
    await done;
    const item = write.mock.calls[0]![0][0]!.items;
    const html = await (await item['text/html']!).text();
    expect(html).toMatch(/^<!--markup:snapshot v1--><div layer-name="Acme"/);
    expect(await (await item['text/plain']!).text()).toBe(`Acme\n${location.href}`);
  });

  it('falls back to execCommand copy when clipboard.write is refused', async () => {
    const el = setup();
    Object.defineProperty(navigator, 'clipboard', { value: { write: vi.fn(async () => Promise.reject(new Error('denied'))) }, configurable: true });
    const data: Record<string, string> = {};
    document.execCommand = vi.fn(() => {
      const e = new Event('copy', { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(e, 'clipboardData', { value: { setData: (t: string, v: string) => (data[t] = v) } });
      document.dispatchEvent(e);
      return true;
    });
    await captureAndCopy([el], fakeEnv());
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(data['text/html']).toMatch(/^<!--markup:snapshot v1-->/);
    expect(data['text/plain']).toBe(`Acme\n${location.href}`);
    expect(document.querySelector('[contenteditable]')).toBeNull();
  });

  it('rejects with the capture error when capture fails', async () => {
    setup();
    Object.defineProperty(navigator, 'clipboard', { value: { write: vi.fn(async () => {}) }, configurable: true });
    await expect(captureAndCopy([], fakeEnv())).rejects.toThrow('Nothing to capture');
  });
});
