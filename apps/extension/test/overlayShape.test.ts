import { afterEach, describe, expect, it } from 'vitest';
import { Overlay } from '../src/picker/overlay';

afterEach(() => {
  document.body.innerHTML = '';
  document.querySelectorAll('[data-markup-snapshot]').forEach((n) => n.remove());
});

describe('overlay highlight', () => {
  it('follows the rounded corners of the picked element', () => {
    document.body.innerHTML = `<div id="card" style="border-top-left-radius:12px;border-top-right-radius:12px;border-bottom-right-radius:4px;border-bottom-left-radius:4px"></div>`;
    const card = document.getElementById('card')!;
    card.getBoundingClientRect = () => new DOMRect(10, 20, 200, 100);
    const overlay = new Overlay(document);
    overlay.highlight(card);
    const box = (overlay as unknown as { box: HTMLElement }).box;
    expect(box.style.borderRadius).toBe('12px 12px 4px 4px');
    overlay.destroy();
  });
});
