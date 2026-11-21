import { describe, expect, it } from 'vitest';
import { addFontFaces, fontFaces, MarkupDoc } from '../src';

const face = (weight: number, data = 'AAAA') => `@font-face{font-family:"Matter";src:url(data:font/woff2;base64,${data});font-weight:${weight}}`;

describe('embedded fonts', () => {
  it('stores inlined faces once per face, outside history', () => {
    const doc = new MarkupDoc();
    const before = doc.log().length;
    expect(addFontFaces(doc, face(400) + face(700))).toBe(2);
    expect(addFontFaces(doc, face(400))).toBe(0);
    // The same face with a new file replaces the old one.
    expect(addFontFaces(doc, face(400, 'BBBB'))).toBe(1);
    expect(fontFaces(doc)).toHaveLength(2);
    expect(fontFaces(doc).join('')).toContain('BBBB');
    expect(doc.log()).toHaveLength(before);
  });

  it('never stores a face that loads from the network', () => {
    const doc = new MarkupDoc();
    expect(addFontFaces(doc, '@font-face{font-family:"X";src:url(https://evil.test/x.woff2)}')).toBe(0);
    expect(addFontFaces(doc, '@font-face{font-family:"X";src:url(data:text/html;base64,AAAA)}')).toBe(0);
    expect(fontFaces(doc)).toHaveLength(0);
  });
});
