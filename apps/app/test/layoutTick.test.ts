import { describe, expect, it, vi } from 'vitest';
import { layoutTick, watchLayout } from '../src/canvas/layoutTick';

describe('layout tick', () => {
  it('bumps when an image inside a layer loads or a layer is edited inline, not for other UI', async () => {
    watchLayout();
    const layer = document.createElement('div');
    layer.setAttribute('data-node-id', 'n1');
    const img = document.createElement('img');
    layer.appendChild(img);
    const panel = document.createElement('input');
    document.body.append(layer, panel);
    const start = layoutTick.get();
    panel.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    expect(layoutTick.get()).toBe(start);
    img.dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(layoutTick.get()).toBe(start + 1));
    layer.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(layoutTick.get()).toBe(start + 2));
    document.body.innerHTML = '';
  });
});
