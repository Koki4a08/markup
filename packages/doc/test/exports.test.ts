import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DEFAULT_EXPORT, MAX_EXPORT_AREA, MAX_EXPORT_SIDE, MarkupDoc, clampPixelRatio, parseScale, type Actor } from '../src/index';

const ana: Actor = { id: 'local-user', kind: 'human', name: 'Ana' };

function setup() {
  const doc = new MarkupDoc({ name: 'F' });
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [id] = doc.insertNodes(ana, page.rootId, [{ type: 'frame', name: 'Card', styles: { width: 200, height: 100 } }]);
  return { doc, id: id! };
}

describe('export settings', () => {
  it('parseScale x p w h', () => {
    const size = { width: 400, height: 200 };
    expect(parseScale('2x', size)).toBe(2);
    expect(parseScale('0.5x', size)).toBe(0.5);
    expect(parseScale('720p', size)).toBe(3.6);
    expect(parseScale('800w', size)).toBe(2);
    expect(parseScale('100h', size)).toBe(0.5);
  });

  it('invalid scale', () => {
    const size = { width: 400, height: 200 };
    for (const bad of ['2', 'x', '2y', '-1x', '0x', '1.x', ' 2x'])
      expect(() => parseScale(bad, size), bad).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });

  it('export settings persist and are logged', () => {
    const { doc, id } = setup();
    expect(doc.exportsOf(id)).toEqual([]);
    expect(DEFAULT_EXPORT).toEqual({ format: 'png', scale: '2x' });
    doc.setExports(ana, id, [{ format: 'png', scale: '2x' }, { format: 'pdf', scale: '1x', pdfQuality: 'medium' }]);
    expect(doc.exportsOf(id)).toEqual([{ format: 'png', scale: '2x' }, { format: 'pdf', scale: '1x', pdfQuality: 'medium' }]);
    expect(doc.log().at(-1)!.summary).toBe('Changed export settings');

    // Survives a round trip through the Yjs state, like reopening the file.
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc.ydoc));
    expect(new MarkupDoc({ ydoc: copy }).exportsOf(id)).toHaveLength(2);

    expect(() => doc.setExports(ana, id, [{ format: 'gif' as 'png', scale: '1x' }])).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(() => doc.setExports(ana, id, [{ format: 'png', scale: 'big' }])).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
    expect(() => doc.setExports(ana, 'nope', [])).toThrow(expect.objectContaining({ code: 'NODE_NOT_FOUND' }));
    expect(doc.exportsOf(id)).toHaveLength(2);
    const newId = doc.duplicateNodes(ana, [{ id }])[0]!.newId;
    expect(doc.exportsOf(newId)).toEqual(doc.exportsOf(id));
    doc.setExports(ana, id, []);
    expect(doc.exportsOf(id)).toEqual([]);
  });
});

describe('export size limit', () => {
  it('clampPixelRatio keeps the output under 16384 px a side and 16,777,216 px in area', () => {
    expect(MAX_EXPORT_SIDE).toBe(16384);
    expect(MAX_EXPORT_AREA).toBe(16_777_216);
    // Within the limit: unchanged.
    expect(clampPixelRatio(2, { width: 1440, height: 900 })).toEqual({ pixelRatio: 2 });
    // 20x of 1440x900 is ~518M px: clamped to the area limit.
    const big = clampPixelRatio(20, { width: 1440, height: 900 });
    expect(big.clampedScale).toBe(big.pixelRatio);
    expect(big.pixelRatio).toBeLessThan(20);
    expect(Math.round(1440 * big.pixelRatio) * Math.round(900 * big.pixelRatio)).toBeLessThanOrEqual(MAX_EXPORT_AREA);
    // A long thin node hits the side limit first.
    const thin = clampPixelRatio(10, { width: 4000, height: 10 });
    expect(Math.round(4000 * thin.pixelRatio)).toBeLessThanOrEqual(MAX_EXPORT_SIDE);
    expect(thin.clampedScale).toBeCloseTo(16384 / 4000, 3);
  });
});
