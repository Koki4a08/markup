import { parseStyleAttr } from '@markup/doc';
import { beforeEach, describe, expect, it } from 'vitest';
import { capture, TOO_LARGE, type CaptureLimits } from '../src/capture/serialize';
import { fakeEnv } from './fakeEnv';
import { fixture, PNG } from './fixtures';

const META = { title: 'Acme — Home', url: 'https://acme.test/' };

async function run(name: string, limits?: CaptureLimits) {
  const f = fixture(name);
  document.body.innerHTML = f.html;
  const env = fakeEnv(f.images, f.textRects);
  const html = await capture(f.targets.map((id) => document.getElementById(id)!), env, META, limits);
  const holder = document.createElement('div');
  holder.innerHTML = html;
  const root = holder.querySelector(':scope > div')!;
  return { html, root, env };
}

const css = (el: Element | null | undefined) => parseStyleAttr(el?.getAttribute('style') ?? '');

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('capture', () => {
  it('keeps the whole font stack so system fonts still resolve', async () => {
    document.body.innerHTML = `<p id="t" data-rect="0 0 100 20" style="font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Arial, sans-serif">Hi</p>`;
    const html = await capture([document.getElementById('t')!], fakeEnv({}), META);
    const holder = document.createElement('div');
    holder.innerHTML = html;
    expect(css(holder.querySelector('p')).fontFamily).toBe("-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif");
  });

  it('root takes the background behind the target', async () => {
    document.body.innerHTML = `<div style="background-color: rgb(13, 17, 23)" data-rect="0 0 400 200"><div id="t" data-rect="10 10 100 50"></div></div>`;
    const html = await capture([document.getElementById('t')!], fakeEnv({}), META);
    const holder = document.createElement('div');
    holder.innerHTML = html;
    expect(css(holder.querySelector(':scope > div')).backgroundColor).toBe('rgb(13, 17, 23)');
  });

  it('root falls back to white when nothing behind the target is opaque', async () => {
    document.body.innerHTML = `<div id="t" data-rect="0 0 100 50"></div>`;
    const html = await capture([document.getElementById('t')!], fakeEnv({}), META);
    const holder = document.createElement('div');
    holder.innerHTML = html;
    expect(css(holder.querySelector(':scope > div')).backgroundColor).toBe('rgb(255, 255, 255)');
  });

  it('an image that cannot be fetched is cut from the visible tab', async () => {
    document.body.innerHTML = `<img id="t" src="https://private.test/a.png" data-rect="0 0 40 30">`;
    const regions: DOMRect[] = [];
    const env = { ...fakeEnv({}), snapshotRegion: async (r: DOMRect) => (regions.push(r), PNG) };
    const html = await capture([document.getElementById('t')!], env, META);
    expect(html).toContain(`src="${PNG}"`);
    expect(html).not.toContain('Image unavailable');
    expect(regions[0]).toMatchObject({ x: 0, y: 0, width: 40, height: 30 });
  });

  it('wraps the capture in a snapshot root', async () => {
    const { html, root } = await run('flex row');
    expect(html.startsWith('<!--markup:snapshot v1-->')).toBe(true);
    expect(root.getAttribute('layer-name')).toBe(META.title);
    expect(root.getAttribute('data-markup-snapshot')).toBe('v1');
    expect(root.getAttribute('data-source')).toBe(META.url);
    expect(css(root)).toEqual({ position: 'relative', width: '200px', height: '50px' });
  });

  it('flex row keeps flex and gap', async () => {
    const { root } = await run('flex row');
    const frame = root.firstElementChild!;
    const s = css(frame);
    expect(s).toMatchObject({ display: 'flex', flexDirection: 'row', gap: '8px', alignItems: 'center', paddingTop: '4px', paddingLeft: '4px' });
    expect(s.width).toBe('200px');
    const kids = [...frame.children];
    expect(kids).toHaveLength(2);
    for (const k of kids) {
      expect(css(k).position).toBeUndefined();
      expect(css(k).width).toBe('50px');
    }
    expect(css(kids[1]).borderTopLeftRadius).toBe('6px');
  });

  it('grid container falls back to absolute children', async () => {
    const { root } = await run('grid');
    const frame = root.firstElementChild!;
    expect(css(frame)).toMatchObject({ position: 'absolute', left: '0px', top: '0px', width: '300px', height: '100px' });
    expect(css(frame).display).toBeUndefined();
    const [a, b] = [...frame.children];
    expect(css(a)).toMatchObject({ position: 'absolute', left: '0px', top: '0px', width: '100px', height: '50px' });
    expect(css(b)).toMatchObject({ position: 'absolute', left: '140px', top: '0px' });
  });

  it('margins become positions', async () => {
    const { root, html } = await run('margins');
    const frame = root.firstElementChild!;
    expect(css(frame).display).toBeUndefined();
    const [a, b] = [...frame.children];
    expect(css(a)).toMatchObject({ position: 'absolute', left: '20px', top: '10px' });
    expect(css(b)).toMatchObject({ position: 'absolute', left: '120px', top: '0px' });
    expect(html).not.toMatch(/margin/);
  });

  it('text keeps inline formatting', async () => {
    const { root } = await run('text');
    const p = root.firstElementChild!;
    expect(p.tagName).toBe('P');
    expect(css(p)).toMatchObject({
      width: '201px',
      color: 'rgb(17, 17, 17)',
      fontSize: '14px',
      fontFamily: "'Inter Display', system-ui, sans-serif",
      lineHeight: '20px',
      textAlign: 'center',
    });
    expect(p.textContent).toBe('Hello bold and rednext');
    expect(css(p.querySelector('b'))).toMatchObject({ fontWeight: '700' });
    expect(css(p.querySelector('em'))).toMatchObject({ color: 'rgb(255, 0, 0)', fontStyle: 'italic' });
    expect(p.querySelector('br')).not.toBeNull();
  });

  it('mixed content puts loose text in text layers and frames around boxes', async () => {
    const { root } = await run('mixed content');
    const frame = root.firstElementChild!;
    const texts = [...frame.children].filter((c) => c.tagName === 'P');
    expect(texts.map((t) => t.textContent)).toEqual(['Loose text run']);
    expect(css(texts[0]).color).toBe('rgb(50, 50, 50)');
    expect(css(frame).color).toBeUndefined();
    const inner = [...frame.children].find((c) => c.tagName === 'DIV')!;
    expect(css(inner)).toMatchObject({ backgroundColor: 'rgb(255, 255, 255)', borderTopLeftRadius: '4px' });
    expect(inner.querySelector('p')?.textContent).toBe('Inner');
    const button = [...frame.children].filter((c) => c.tagName === 'DIV')[1]!;
    expect(css(button).backgroundColor).toBe('rgb(37, 99, 235)');
    expect(css(button.querySelector('p')).color).toBe('rgb(255, 255, 255)');
  });

  it('pseudo-element content is captured', async () => {
    const { root } = await run('pseudo');
    const frame = root.firstElementChild!;
    const star = [...frame.querySelectorAll('p')].find((p) => p.textContent === '★')!;
    expect(star).toBeDefined();
    expect(css(star)).toMatchObject({ position: 'absolute', left: '4px', top: '6px', color: 'rgb(255, 0, 0)' });
    const line = [...frame.children].find((c) => css(c).backgroundColor === 'rgb(0, 0, 0)');
    expect(css(line)).toMatchObject({ left: '0px', top: '38px', width: '100px', height: '2px' });
  });

  it('hidden elements are skipped', async () => {
    const { root, html } = await run('hidden');
    expect(root.textContent).toContain('shown');
    expect(html).not.toMatch(/gone-|bad\(\)/);
  });

  it('failed image fetch becomes a placeholder', async () => {
    const { root, env } = await run('images');
    const frame = root.firstElementChild!;
    const placeholder = frame.querySelector('[layer-name="Image unavailable"]')!;
    expect(placeholder.tagName).toBe('DIV');
    expect(css(placeholder)).toMatchObject({ width: '120px', height: '80px', backgroundColor: '#e4e4e7' });
    const img = frame.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(PNG);
    expect(css(img)).toMatchObject({ objectFit: 'cover', left: '140px' });
    expect(css(frame).backgroundImage).toBe(`linear-gradient(rgb(255, 0, 0), rgb(0, 0, 255)), url(${PNG})`);
    expect(css(frame).backgroundSize).toBe('auto, cover');
    expect(env.fetched.sort()).toEqual(['https://cdn.test/bg.png', 'https://cdn.test/missing.png', 'https://cdn.test/ok.png']);
  });

  it('svg currentColor is resolved', async () => {
    const { root, html } = await run('svg');
    const svg = root.querySelector('svg')!;
    expect(html).not.toMatch(/currentColor/i);
    expect(svg.querySelector('path')!.getAttribute('fill')).toBe('rgb(255, 0, 0)');
    expect(svg.querySelector('path')!.getAttribute('stroke')).toBe('rgb(255, 0, 0)');
    expect(svg.querySelector('circle')!.getAttribute('fill')).toBe('rgb(0, 128, 0)');
    expect(css(svg)).toMatchObject({ position: 'absolute', left: '8px', top: '8px', width: '24px', height: '24px' });
  });

  it('input shows its placeholder', async () => {
    const { root } = await run('form');
    const frame = root.firstElementChild!;
    const [email, name, iframe] = [...frame.children];
    expect(css(email)).toMatchObject({ width: '200px', height: '32px', borderTop: '1px solid rgb(200, 200, 200)', display: 'flex', alignItems: 'center' });
    expect(email!.querySelector('p')!.textContent).toBe('Email');
    expect(css(email!.querySelector('p'))).toMatchObject({ color: 'rgb(117, 117, 117)', fontSize: '14px' });
    expect(name!.querySelector('p')!.textContent).toBe('Ada');
    expect(iframe!.getAttribute('layer-name')).toBe('video.example.com');
    expect(iframe!.textContent).toBe('video.example.com');
  });

  it('text after an inline-level sibling keeps its measured left edge', async () => {
    const { root } = await run('icon then text');
    const frame = root.firstElementChild!;
    const svg = frame.querySelector('svg')!;
    const p = frame.querySelector('p')!;
    expect(css(svg)).toMatchObject({ left: '0px', top: '4px' });
    expect(p.textContent).toBe('Download');
    expect(css(p)).toMatchObject({ position: 'absolute', left: '20px', top: '4px', width: '100px', color: 'rgb(0, 0, 238)' });
  });

  it('a flex container with a hidden child falls back to absolute so siblings keep their place', async () => {
    for (const name of ['hidden flex child', 'zero-size flex child']) {
      const { root, html } = await run(name);
      const frame = root.firstElementChild!;
      expect(css(frame).display, name).toBeUndefined();
      const kids = [...frame.children];
      expect(kids, name).toHaveLength(2);
      expect(css(kids[1]).left, name).toBe(name === 'hidden flex child' ? '116px' : '66px');
      expect(html, name).not.toMatch(/rgb\(0, 255, 0\)/);
    }
  });

  it('images past the byte budget become placeholders', async () => {
    const { root } = await run('images', { imageBytes: PNG.length * 1.5 });
    const frame = root.firstElementChild!;
    // The background image is charged first; the <img> no longer fits.
    expect(css(frame).backgroundImage).toContain(PNG);
    expect(frame.querySelector('img')).toBeNull();
    expect(frame.querySelectorAll('[layer-name="Image unavailable"]')).toHaveLength(2);
  });

  it('caps concurrent image fetches', async () => {
    document.body.innerHTML = `<div id="t" data-rect="0 0 1000 10">${Array.from({ length: 10 }, (_, i) => `<img src="https://cdn.test/${i}.png" data-rect="${i * 20} 0 10 10">`).join('')}</div>`;
    let inFlight = 0;
    let peak = 0;
    const env = fakeEnv();
    env.fetchImage = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return PNG;
    };
    const html = await capture([document.getElementById('t')!], env, META, { concurrency: 3 });
    expect(peak).toBe(3);
    expect(html.match(/<img /g)).toHaveLength(10);
  });

  it('a page past the element cap fails with a clear message', async () => {
    document.body.innerHTML = `<div id="t" data-rect="0 0 100 100">${'<div data-rect="0 0 10 10"></div>'.repeat(5)}</div>`;
    await expect(capture([document.getElementById('t')!], fakeEnv(), META, { maxNodes: 3 })).rejects.toThrow(TOO_LARGE);
  });

  it('two targets sit 80px apart', async () => {
    const { root } = await run('two targets');
    expect(css(root)).toMatchObject({ width: '300px', height: '60px' });
    const [a, b] = [...root.children];
    expect(css(a)).toMatchObject({ position: 'absolute', left: '0px', top: '0px', width: '100px' });
    expect(css(b)).toMatchObject({ position: 'absolute', left: '180px', top: '0px', width: '120px' });
  });
});

describe('shadow DOM', () => {
  it('captures open shadow roots and slotted content instead of empty frames', async () => {
    document.body.innerHTML = `<shreddit-post id="t" data-rect="0 0 300 100" style="display: block"><p data-rect="10 40 200 20">Slotted body</p></shreddit-post>`;
    const host = document.getElementById('t')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<div class="card" data-rect="0 0 300 100" style="background-color: rgb(255, 0, 0)"><h3 data-rect="10 10 200 20">Shadow title</h3><slot></slot><slot name="empty"><span data-rect="10 70 100 20">Fallback</span></slot></div>`;
    const env = fakeEnv({}, { 'Shadow title': '10 10 200 20', 'Slotted body': '10 40 200 20', Fallback: '10 70 100 20' });
    const html = await capture([host], env, META);
    const holder = document.createElement('div');
    holder.innerHTML = html;
    expect(holder.textContent).toContain('Shadow title');
    expect(holder.textContent).toContain('Slotted body');
    expect(holder.textContent).toContain('Fallback');
    const red = [...holder.querySelectorAll('div')].find((d) => css(d).backgroundColor === 'rgb(255, 0, 0)');
    expect(red).toBeDefined();
    expect(red!.textContent).toContain('Slotted body');
  });
});
