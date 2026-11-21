import { describe, expect, it } from 'vitest';
import { viewportCrop } from '../src/capture/screen';

const view = { scrollX: 0, scrollY: 100, width: 1000, height: 800 };

describe('viewportCrop', () => {
  it('maps a page rect to screenshot pixels using the device scale', () => {
    // Screenshot is 2x the viewport (devicePixelRatio 2).
    expect(viewportCrop(new DOMRect(50, 150, 200, 100), view, { width: 2000, height: 1600 })).toEqual({ sx: 100, sy: 100, sw: 400, sh: 200 });
  });

  it('returns null when the rect is not fully on screen', () => {
    expect(viewportCrop(new DOMRect(50, 0, 200, 150), view, { width: 1000, height: 800 })).toBeNull();
    expect(viewportCrop(new DOMRect(900, 150, 200, 100), view, { width: 1000, height: 800 })).toBeNull();
  });

  it('returns null for an empty rect', () => {
    expect(viewportCrop(new DOMRect(10, 150, 0, 10), view, { width: 1000, height: 800 })).toBeNull();
  });
});
