import { describe, expect, it, vi } from 'vitest';
import { cleanSvg } from '../src/capture/dom';
import type { CaptureEnv } from '../src/capture/env';
import { concat } from '../src/capture/images';
import { watchNetwork } from '../src/capture/prepare';
import { memoStyles } from '../src/capture/styleMemo';
import { base64 } from '../src/imageFetch';

describe('memoStyles', () => {
  it('reads each property once per element and pseudo-element, and keeps the rest of the env', () => {
    const reads: string[] = [];
    const style = vi.fn((el: Element, pseudo?: string) => ({
      getPropertyValue: (p: string) => (reads.push(`${el.id}${pseudo ?? ''}:${p}`), `${el.id}${pseudo ?? ''}-${p}`),
    }) as unknown as CSSStyleDeclaration);
    const fetchImage = async () => null;
    const env = memoStyles({ style, rect: () => new DOMRect(), fetchImage } as CaptureEnv);
    const a = document.createElement('div');
    a.id = 'a';
    expect(env.style(a).getPropertyValue('color')).toBe('a-color');
    expect(env.style(a).getPropertyValue('color')).toBe('a-color');
    expect(env.style(a, '::before').getPropertyValue('color')).toBe('a::before-color');
    expect(env.style(a)).toBe(env.style(a));
    expect(reads).toEqual(['a:color', 'a::before:color']);
    expect(style).toHaveBeenCalledTimes(2);
    expect(env.fetchImage).toBe(fetchImage);
  });
});

describe('concat', () => {
  it('joins parts in order', () => {
    expect(concat([])).toBe('');
    expect(concat(['<a>', '', 'b', '</a>'])).toBe('<a>b</a>');
  });
});

describe('base64', () => {
  it('matches btoa over the bytes', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 31) % 256);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    expect(base64(bytes)).toBe(btoa(bin));
  });
});

describe('cleanSvg sprites', () => {
  const env = { style: () => ({ getPropertyValue: () => '' }) } as unknown as CaptureEnv;

  it('inlines each external <use>, and skips ids that earlier copies brought into the svg', () => {
    document.body.innerHTML = `
      <svg style="display:none"><symbol id="icon" viewBox="0 0 10 10"><path id="dot" d="M0 0"/></symbol></svg>
      <svg id="t"><use href="#icon"/><use href="#icon"/><use href="#dot"/></svg>`;
    const clone = cleanSvg(document.getElementById('t') as unknown as SVGSVGElement, env, 10, 10);
    expect(clone.querySelectorAll('use')).toHaveLength(1);
    expect(clone.querySelectorAll('svg > path')).toHaveLength(2);
    document.body.innerHTML = '';
  });
});

describe('watchNetwork', () => {
  it('counts image, CSS and fetch loads but not beacons or other pings', () => {
    let notify: ((list: { getEntries(): unknown[] }) => void) | null = null;
    class FakeObserver {
      constructor(cb: (list: { getEntries(): unknown[] }) => void) {
        notify = cb;
      }
      observe() {}
      disconnect() {}
    }
    const net = watchNetwork({ PerformanceObserver: FakeObserver } as unknown as Window);
    expect(net.last()).toBe(0);
    notify!({ getEntries: () => [{ initiatorType: 'beacon' }, { initiatorType: 'other' }] });
    expect(net.last()).toBe(0);
    notify!({ getEntries: () => [{ initiatorType: 'img' }] });
    expect(net.last()).toBeGreaterThan(0);
    net.stop();
  });
});
