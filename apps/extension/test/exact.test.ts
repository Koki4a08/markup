import { afterEach, describe, expect, it } from 'vitest';
import { captureExact } from '../src/capture/exact';
import { fakeEnv } from './fakeEnv';
import { exactFixture, PNG } from './fixtures';

const MARKER = '<!--markup:snapshot v1-->';
const META = { title: 'Acme', url: 'https://acme.test/repo' };

async function exact(name: string): Promise<{ html: string; root: HTMLElement; target: HTMLElement }> {
  const f = exactFixture(name);
  document.body.innerHTML = f.html;
  const html = await captureExact(f.targets.map((id) => document.getElementById(id)!), fakeEnv(f.images, f.textRects), META);
  document.body.innerHTML = '';
  const holder = document.createElement('div');
  holder.innerHTML = html.slice(MARKER.length);
  const root = holder.firstElementChild as HTMLElement;
  return { html, root, target: root.firstElementChild as HTMLElement };
}

/** A style attribute as a map (the output uses `prop:value` joined by `;`). */
const styles = (el: Element | null | undefined): Record<string, string> =>
  Object.fromEntries(
    (el?.getAttribute('style') ?? '')
      .split(/;(?![^(]*\))/)
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')), d.slice(d.indexOf(':') + 1)]),
  );

afterEach(() => {
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
});

describe('exact snapshot', () => {
  it('root carries marker, dialect attr, backdrop and inherited font', async () => {
    document.body.setAttribute('style', 'background-color: rgb(9, 9, 9)');
    const f = exactFixture('inherited');
    document.body.innerHTML = f.html;
    const html = await captureExact([document.getElementById('t')!], fakeEnv(), META);
    expect(html.startsWith(`${MARKER}<div data-markup-snapshot="v1"`)).toBe(true);
    const holder = document.createElement('div');
    holder.innerHTML = html.slice(MARKER.length);
    const root = holder.firstElementChild!;
    expect(root.getAttribute('data-markup-dialect')).toBe('any');
    expect(root.getAttribute('layer-name')).toBe('Acme');
    expect(root.getAttribute('data-source')).toBe(META.url);
    expect(styles(root)).toMatchObject({
      position: 'relative',
      width: '200px',
      height: '60px',
      'background-color': 'rgb(9, 9, 9)',
      color: 'rgb(0, 0, 0)',
      'font-family': 'Arial, sans-serif',
      'font-size': '16px',
      'font-weight': '400',
      'line-height': 'normal',
    });
    // The target is placed by the root.
    expect(styles(root.firstElementChild)).toMatchObject({ position: 'absolute', left: '0px', top: '0px' });
  });

  it('grid layout keeps display grid and template columns', async () => {
    const { target } = await exact('grid template');
    expect(target.localName).toBe('div');
    expect(styles(target)).toMatchObject({ display: 'grid', 'grid-template-columns': '100px 200px', 'row-gap': '8px', 'column-gap': '16px' });
    const kids = Array.from(target.children);
    expect(kids).toHaveLength(2);
    for (const k of kids) expect(styles(k).position, k.outerHTML).toBeUndefined();
    expect(styles(kids[1])['grid-column-start']).toBe('2');
  });

  it('margins are kept', async () => {
    const { target, html } = await exact('child margins');
    expect(styles(target)).toMatchObject({ display: 'flex', 'padding-top': '8px' });
    const [a, b] = Array.from(target.children);
    expect(styles(a)['margin-top']).toBe('12px');
    expect(styles(b)['margin-left']).toBe('4px');
    expect(styles(a).position).toBeUndefined();
    expect(html.match(/position:absolute/g)).toHaveLength(1); // only the target's placement
  });

  it('inline text stays inline', async () => {
    const { target } = await exact('inline text');
    expect(target.localName).toBe('div');
    const kids = Array.from(target.children);
    expect(kids.map((k) => k.localName)).toEqual(['span', 'p', 'span']);
    const [hello, badge, world] = kids;
    expect(styles(hello)).toEqual({ display: 'inline' });
    expect(hello!.innerHTML).toMatch(/^Hello <b[^>]*>bold<\/b> $/);
    expect(styles(hello!.querySelector('b'))['font-weight']).toBe('700');
    expect(styles(world)).toEqual({ display: 'inline' });
    expect(world!.textContent).toBe(' world');
    expect(badge!.textContent).toBe('3');
    expect(styles(badge)).toMatchObject({ display: 'inline', 'background-color': 'rgb(221, 244, 255)', 'padding-left': '6px', 'padding-right': '6px' });
    expect(styles(badge).width).toBeUndefined();
    expect(styles(badge).height).toBeUndefined();
  });

  it('inherited props only where they change', async () => {
    const { target } = await exact('inherited');
    expect(styles(target)).toMatchObject({ color: 'rgb(10, 20, 30)', 'font-size': '14px' });
    expect(styles(target)['font-family']).toBeUndefined();
    const [same, diff] = Array.from(target.children);
    expect(same!.localName).toBe('p');
    expect(styles(same).color).toBeUndefined();
    expect(styles(same)['font-size']).toBeUndefined();
    expect(styles(diff).color).toBe('rgb(200, 0, 0)');
  });

  it('table rows keep table display', async () => {
    const { target, html } = await exact('table');
    expect(html).not.toMatch(/<(table|tbody|tr|td)\b/);
    expect(target.localName).toBe('div');
    expect(styles(target)).toMatchObject({ display: 'table', 'border-collapse': 'collapse' });
    const body = target.firstElementChild!;
    expect(styles(body).display).toBe('table-row-group');
    const row = body.firstElementChild!;
    expect(row.localName).toBe('div');
    expect(styles(row).display).toBe('table-row');
    const [c1, c2] = Array.from(row.children);
    expect(c1!.localName).toBe('div');
    expect(styles(c1)).toMatchObject({ display: 'table-cell', 'padding-top': '4px', 'vertical-align': 'middle' });
    expect(styles(c2).display).toBe('table-cell');
    expect(c2!.textContent!.trim()).toBe('B');
  });

  it('pseudo-element becomes a child', async () => {
    const { target } = await exact('pseudo children');
    const first = target.firstElementChild!;
    expect(first.localName).toBe('span');
    expect(first.textContent).toBe('★');
    expect(styles(first).color).toBe('rgb(255, 0, 0)');
    const last = target.lastElementChild!;
    expect(last.localName).toBe('div');
    expect(styles(last)).toMatchObject({ position: 'absolute', top: '38px', width: '100px', height: '2px', 'background-color': 'rgb(0, 0, 0)' });
    expect(target.children[1]!.textContent).toBe('Starred');
  });

  it('pseudo-element url() content becomes an img', async () => {
    document.body.innerHTML = `<div id="t" data-rect="0 0 20 20" data-before="content: url(&quot;https://cdn.test/i.png&quot;); width: 16px; height: 16px">x</div>`;
    const html = await captureExact([document.getElementById('t')!], fakeEnv({ 'https://cdn.test/i.png': PNG }), META);
    expect(html).toContain(`<img src="${PNG}"`);
  });

  it('file-name style truncation', async () => {
    const { target } = await exact('file name');
    expect(styles(target)).toMatchObject({ display: 'table-cell', 'padding-left': '16px' });
    const column = target.firstElementChild!;
    expect(styles(column)).toMatchObject({ display: 'flex', 'align-items': 'center' });
    // column > overflow-hidden > filename-cell > truncate
    const truncate = column.firstElementChild!.firstElementChild!.firstElementChild!;
    expect(truncate.localName).toBe('div');
    expect(styles(truncate)).toMatchObject({ display: 'inline-block', width: '120px', 'overflow-x': 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
    const text = truncate.querySelector('p')!;
    expect(text).not.toBeNull();
    expect(text.textContent!.trim()).toBe('README.md');
    expect(styles(text)).toMatchObject({ display: 'inline', color: 'rgb(31, 35, 40)' });
    expect(styles(text).width).toBeUndefined();
    expect(text.outerHTML).not.toContain('href');
  });

  it('position fixed becomes absolute and sticky becomes relative without its offset', async () => {
    const { target } = await exact('fixed and sticky');
    const [f, st] = Array.from(target.children);
    expect(styles(f)).toMatchObject({ position: 'absolute', top: '0px', left: '0px' });
    expect(styles(st).position).toBe('relative');
    expect(styles(st).top).toBeUndefined();
  });

  it('several targets sit side by side 80px apart', async () => {
    const { root } = await exact('two targets');
    const [a, b] = Array.from(root.children);
    expect(styles(a)).toMatchObject({ position: 'absolute', left: '0px', top: '0px' });
    expect(styles(b)).toMatchObject({ position: 'absolute', left: '180px', top: '0px' });
    expect(styles(root)).toMatchObject({ width: '300px', height: '60px' });
  });

  it('images, svg and fields reuse the simplified handling', async () => {
    const images = await exact('images');
    expect(images.html).toContain(`<img src="${PNG}"`);
    expect(images.html).toContain('layer-name="Image unavailable"');
    expect(images.html).not.toContain('missing.png');
    const svg = await exact('svg');
    expect(svg.html).toContain('fill="rgb(255, 0, 0)"');
    const form = await exact('form');
    expect(form.html).toContain('>Email</p>');
    expect(form.html).toContain('>Ada</p>');
    expect(form.html).toContain('video.example.com');
    expect(form.html).not.toMatch(/<(input|iframe)\b/);
  });

  it('skips hidden nodes and scripts', async () => {
    const { html } = await exact('hidden');
    expect(html).not.toMatch(/gone-|bad\(\)/);
    expect(html).toContain('shown');
  });

  it('gives up on huge pages', async () => {
    document.body.innerHTML = `<div id="t" data-rect="0 0 10 10">${'<div data-rect="0 0 1 1"></div>'.repeat(30)}</div>`;
    await expect(captureExact([document.getElementById('t')!], fakeEnv(), META, { maxNodes: 10 })).rejects.toThrow(/too large/);
  });
});
