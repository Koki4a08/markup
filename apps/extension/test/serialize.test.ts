import { parseStyleAttr } from '@markup/doc';
import { beforeEach, describe, expect, it } from 'vitest';
import { capture } from '../src/capture/serialize';
import { fakeEnv } from './fakeEnv';
import { fixture, PNG } from './fixtures';

const META = { title: 'Acme — Home', url: 'https://acme.test/' };

async function run(name: string) {
  const f = fixture(name);
  document.body.innerHTML = f.html;
  const env = fakeEnv(f.images);
  const html = await capture(f.targets.map((id) => document.getElementById(id)!), env, META);
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
  it('wraps the capture in a snapshot root', async () => {
    const { html, root } = await run('flex row');
    expect(html.startsWith('<!--markup:snapshot v1-->')).toBe(true);
    expect(root.getAttribute('layer-name')).toBe(META.title);
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
      fontFamily: "'Inter Display'",
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

  it('two targets sit 80px apart', async () => {
    const { root } = await run('two targets');
    expect(css(root)).toMatchObject({ width: '300px', height: '60px' });
    const [a, b] = [...root.children];
    expect(css(a)).toMatchObject({ position: 'absolute', left: '0px', top: '0px', width: '100px' });
    expect(css(b)).toMatchObject({ position: 'absolute', left: '180px', top: '0px', width: '120px' });
  });
});
