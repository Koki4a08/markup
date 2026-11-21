import { describe, expect, it } from 'vitest';
import { rootClip, visibleShape } from '../src/capture/clip';
import { captureExact } from '../src/capture/exact';
import { fakeEnv } from './fakeEnv';

const META = { title: 'Card', url: 'https://x.test/' };
const el = (id: string) => document.getElementById(id)!;
const css = (html: string) => {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  return holder.querySelector(':scope > div')!.getAttribute('style') ?? '';
};

/** A rounded, bordered box that clips; the table inside fills it. */
const ROUNDED = `<div id="box" data-rect="0 0 302 102" style="overflow-x:hidden;overflow-y:hidden;border-top-width:1px;border-right-width:1px;border-bottom-width:1px;border-left-width:1px;border-top-style:solid;border-right-style:solid;border-bottom-style:solid;border-left-style:solid;border-top-left-radius:6px;border-top-right-radius:6px;border-bottom-right-radius:6px;border-bottom-left-radius:6px">
  <div id="t" data-rect="1 1 300 100" style="background-color:rgb(13, 17, 23)"></div>
  <div id="mid" data-rect="40 40 20 20"></div>
</div>`;

describe('visible shape', () => {
  it("takes the clipping ancestor's inner radius where the target fills its corners", () => {
    document.body.innerHTML = ROUNDED;
    const shape = visibleShape(el('t'), fakeEnv({}));
    expect(shape.clipped).toBe(true);
    expect(shape.radii).toEqual(['5px', '5px', '5px', '5px']);
    expect(shape.rect).toMatchObject({ x: 1, y: 1, width: 300, height: 100 });
  });

  it('keeps square corners for an element that does not reach the clip corners', () => {
    document.body.innerHTML = ROUNDED;
    const shape = visibleShape(el('mid'), fakeEnv({}));
    expect(shape.clipped).toBe(false);
    expect(shape.radii).toEqual(['0px', '0px', '0px', '0px']);
  });

  it('uses the element\'s own radius', () => {
    document.body.innerHTML = `<div id="c" data-rect="0 0 100 50" style="border-top-left-radius:12px;border-top-right-radius:12px;border-bottom-right-radius:4px;border-bottom-left-radius:4px"></div>`;
    expect(visibleShape(el('c'), fakeEnv({})).radii).toEqual(['12px', '12px', '4px', '4px']);
  });

  it('cuts the part a scroll container hides', () => {
    document.body.innerHTML = `<div id="s" data-rect="0 0 100 100" style="overflow-y:auto"><div id="long" data-rect="0 0 100 300"></div></div>`;
    const shape = visibleShape(el('long'), fakeEnv({}));
    expect(shape.clipped).toBe(true);
    expect(shape.rect).toMatchObject({ x: 0, y: 0, width: 100, height: 100 });
  });
});

describe('root clip', () => {
  it('rounds the snapshot root like the page clips the target', () => {
    document.body.innerHTML = ROUNDED;
    expect(rootClip(el('t'), fakeEnv({}))).toEqual([['clip-path', 'inset(0px 0px 0px 0px round 5px 5px 5px 5px)']]);
  });

  it('is empty when nothing clips the target', () => {
    document.body.innerHTML = ROUNDED;
    expect(rootClip(el('mid'), fakeEnv({}))).toEqual([]);
  });

  it('exact capture applies the clip and skips the square backdrop behind an opaque target', async () => {
    document.body.innerHTML = ROUNDED;
    const style = css(await captureExact([el('t')], fakeEnv({}), META));
    expect(style).toContain('clip-path:inset(0px 0px 0px 0px round 5px 5px 5px 5px)');
    // The target is the snapshot root: its own background, no backdrop ahead of it.
    expect(style.match(/background-color/g)).toHaveLength(1);
  });

  it('a rounded opaque card has no square backdrop behind its corners', async () => {
    document.body.innerHTML = `<div style="background-color:rgb(255, 255, 255)" data-rect="0 0 400 300"><div id="card" data-rect="10 10 200 100" style="background-color:rgb(13, 17, 23);border-top-left-radius:12px;border-top-right-radius:12px;border-bottom-right-radius:12px;border-bottom-left-radius:12px"></div></div>`;
    const style = css(await captureExact([el('card')], fakeEnv({}), META));
    expect(style.match(/background-color:[^;]*/g)).toEqual(['background-color:rgb(13, 17, 23)']);
  });

  it('a transparent target stays transparent: no page colour behind it', async () => {
    document.body.innerHTML = `<div style="background-color:rgb(13, 17, 23)" data-rect="0 0 400 300"><div id="txt" data-rect="10 10 200 100"></div></div>`;
    expect(css(await captureExact([el('txt')], fakeEnv({}), META))).not.toContain('background-color');
  });
});
