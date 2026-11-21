import { parseStyleAttr } from '@markup/doc';
import { afterEach, describe, expect, it } from 'vitest';
import { captureExact } from '../src/capture/exact';
import type { MotionRecord } from '../src/capture/motion';
import { relativeMotion } from '../src/capture/motion';
import { capture } from '../src/capture/serialize';
import { SvgDefs } from '../src/capture/svgDefs';
import { fakeEnv } from './fakeEnv';

const META = { title: 'Acme', url: 'https://acme.test/' };
const SVG_NS = 'http://www.w3.org/2000/svg';

const parse = (html: string) => {
  const holder = document.createElement('div');
  holder.innerHTML = html.replace('<!--markup:snapshot v1-->', '');
  return holder.firstElementChild as HTMLElement;
};

const fade: MotionRecord = {
  label: 'fadeUp',
  frames: [
    { offset: 0, easing: 'ease-out', props: [['opacity', '0'], ['transform', 'translateY(20px)']] },
    { offset: 1, easing: 'linear', props: [['opacity', '1'], ['transform', 'none']] },
  ],
  duration: 600,
  delay: 0,
  iterations: 1,
  direction: 'normal',
  fill: 'both',
};

/** A page-level hidden svg of shared definitions, as sites put at the top of <body>. */
const DEFS = `<svg width="0" height="0" style="position:absolute"><defs>
  <filter id="goo"><feGaussianBlur in="SourceGraphic" stdDeviation="8"/><feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"/></filter>
  <filter id="remote"><feImage href="https://evil.test/x.png"/><feGaussianBlur stdDeviation="2"/></filter>
  <clipPath id="blob" clipPathUnits="objectBoundingBox"><path d="M0.5 0 L1 1 L0 1 Z"/></clipPath>
  <linearGradient id="brand"><stop offset="0" stop-color="#f0f"/><stop offset="1" stop-color="#0ff"/></linearGradient>
</defs></svg>`;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SVG definitions', () => {
  it('copies a filter a CSS value points at under a content id, and drops what it cannot copy', () => {
    document.body.innerHTML = `${DEFS}<div id="a"></div>`;
    const a = document.getElementById('a')!;
    const defs = new SvgDefs();
    const kept = defs.rewrite('filter', 'url("#goo") drop-shadow(rgb(0, 0, 0) 0px 4px 8px)', a)!;
    expect(kept).toMatch(/^url\(#mk-filter-\w+\) drop-shadow/);
    expect(defs.rewrite('filter', 'url(#goo)', a)).toBe(kept.split(' ')[0]); // one copy per definition
    expect(defs.rewrite('filter', 'url(#missing)', a)).toBeNull();
    expect(defs.rewrite('filter', 'url(https://x.test/f.svg#f)', a)).toBeNull();
    expect(defs.rewrite('clip-path', 'url(#goo)', a)).toBeNull(); // a filter is no clip path
    expect(defs.rewrite('clip-path', 'url(#blob)', a)).toMatch(/^url\(#mk-clippath-\w+\)$/);
    // A filter that loads a file keeps its other primitives, never the file.
    defs.rewrite('filter', 'url(#remote)', a);
    const layer = defs.html();
    expect(layer).toContain('layer-name="SVG effects"');
    expect(layer).toContain('feGaussianBlur');
    expect(layer).not.toContain('evil.test');
  });

  it('inline svgs get outside gradients copied in and ids no other svg shares', async () => {
    document.body.innerHTML = `${DEFS}<div id="t" style="width:100px;height:40px">
      <svg id="s1" viewBox="0 0 10 10" style="width:20px;height:20px"><defs><linearGradient id="g"><stop stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>
      <svg id="s2" viewBox="0 0 10 10" style="width:20px;height:20px"><defs><linearGradient id="g"><stop stop-color="blue"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>
      <svg id="s3" viewBox="0 0 10 10" style="width:20px;height:20px"><rect width="10" height="10" fill="url(#brand)"/></svg>
    </div>`;
    const root = parse(await captureExact([document.getElementById('t')!], fakeEnv(), META));
    const svgs = [...root.querySelectorAll('svg')];
    const [g1, g2] = svgs.slice(0, 2).map((s) => s.querySelector('linearGradient')!.id);
    expect(g1).not.toBe(g2);
    expect(svgs[0]!.querySelector('rect')!.getAttribute('fill')).toBe(`url(#${g1})`);
    expect(svgs[1]!.querySelector('rect')!.getAttribute('fill')).toBe(`url(#${g2})`);
    const brand = svgs[2]!.querySelector('linearGradient')!;
    expect(brand.querySelectorAll('stop')).toHaveLength(2);
    expect(svgs[2]!.querySelector('rect')!.getAttribute('fill')).toBe(`url(#${brand.id})`);
  });

  it('exact snapshots carry SVG filters and clip paths in a hidden layer', async () => {
    document.body.innerHTML = `${DEFS}<div id="t" style="width:100px;height:40px;filter:url(#goo);clip-path:url(#blob)"></div>`;
    const root = parse(await captureExact([document.getElementById('t')!], fakeEnv(), META));
    // The lone target is the snapshot root; the hidden layer is its first child.
    const layer = root.firstElementChild!;
    expect(layer.getAttribute('layer-name')).toBe('SVG effects');
    const style = parseStyleAttr(root.getAttribute('style')!);
    expect(style.filter).toBe(`url(#${layer.querySelector('filter')!.id})`);
    expect(style.clipPath).toBe(`url(#${layer.querySelector('clipPath')!.id})`);
  });
});

describe('simplified snapshot effects', () => {
  it('keeps animations, masks, shape clips, SVG filters and text effects', async () => {
    document.body.innerHTML = `${DEFS}<div id="t" data-rect="0 0 200 100" style="width:200px;height:100px">
      <div id="card" data-rect="0 0 100 50" style="width:100px;height:50px;background-color:red;mask-image:linear-gradient(black, transparent);clip-path:polygon(0 0, 100% 0, 50% 100%);filter:url(#goo)"></div>
      <p id="title" data-rect="0 60 100 20" style="text-shadow:rgb(0, 0, 0) 0px 2px 4px;-webkit-text-stroke-width:1px;-webkit-text-stroke-color:rgb(255, 0, 0)">Hello</p>
    </div>`;
    const card = document.getElementById('card')!;
    const env = { ...fakeEnv(), motions: (el: Element, pseudo?: string) => (el === card && !pseudo ? [fade] : []) };
    const html = await capture([document.getElementById('t')!], env, META);
    const root = parse(html);
    expect(root.getAttribute('data-markup-keyframes')).toMatch(/@keyframes mk-fadeUp-\w+/);
    const cardOut = root.querySelector('[style*="mk-fadeUp"]')!;
    const style = parseStyleAttr(cardOut.getAttribute('style')!);
    expect(style).toMatchObject({ animationDuration: '600ms', animationFillMode: 'both', maskImage: 'linear-gradient(black, transparent)', clipPath: 'polygon(0 0, 100% 0, 50% 100%)' });
    expect(style.filter).toMatch(/^url\(#mk-filter-\w+\)$/);
    expect(root.querySelector('[layer-name="SVG effects"] filter')).not.toBeNull();
    const title = parseStyleAttr(root.querySelector('p')!.getAttribute('style')!);
    expect(title).toMatchObject({ textShadow: 'rgb(0, 0, 0) 0px 2px 4px', WebkitTextStrokeWidth: '1px', WebkitTextStrokeColor: 'rgb(255, 0, 0)' });
  });

  it('a layer placed at its measured position keeps an entrance movement only when it rests untransformed', () => {
    const at = (transform: string) => ({ getPropertyValue: (p: string) => (p === 'transform' ? transform : 'none') }) as unknown as CSSStyleDeclaration;
    expect(relativeMotion([fade], at('none'))).toEqual([fade]);
    const [kept] = relativeMotion([fade], at('matrix(1, 0, 0, 1, -50, -50)'));
    expect(kept!.frames.map((f) => f.props.map(([p]) => p))).toEqual([['opacity'], ['opacity']]);
    const loop = { ...fade, iterations: Infinity };
    expect(relativeMotion([loop], at('matrix(1, 0, 0, 1, -50, -50)'))).toEqual([loop]);
  });
});
