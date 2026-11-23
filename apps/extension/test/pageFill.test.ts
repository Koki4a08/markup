import { parseStyleAttr } from '@markup/doc';
import { afterEach, describe, expect, it } from 'vitest';
import { captureExact } from '../src/capture/exact';
import { fakeEnv } from './fakeEnv';

const META = { title: 'Acme', url: 'https://acme.test/' };

const parse = (html: string) => {
  const holder = document.createElement('div');
  holder.innerHTML = html.replace('<!--markup:snapshot v1-->', '');
  return holder.firstElementChild as HTMLElement;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('whole-page capture', () => {
  it('the page layer fills the snapshot root, so resizing the artboard reveals more of the page', async () => {
    document.body.innerHTML = '<div style="width:100px;height:40px"></div>';
    const root = parse(await captureExact('page', fakeEnv(), META));
    const page = parseStyleAttr(root.firstElementChild!.getAttribute('style')!);
    expect(page).toMatchObject({ position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%' });
  });

  it('a picked element keeps its own size', async () => {
    document.body.innerHTML = '<div id="a" style="width:100px;height:40px"></div><div id="b" style="width:60px;height:20px"></div>';
    const root = parse(await captureExact([document.getElementById('a')!, document.getElementById('b')!], fakeEnv(), META));
    const first = parseStyleAttr(root.firstElementChild!.getAttribute('style')!);
    expect(first.width).not.toBe('100%');
  });
});
