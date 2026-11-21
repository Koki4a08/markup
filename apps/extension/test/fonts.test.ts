import { describe, expect, it } from 'vitest';
import { embedFonts, familiesIn, familiesUsed, parseFontFaces, rangeCovers } from '../src/capture/fonts';

describe('capture fonts', () => {
  it('reads named families from stacks, generic ones left out', () => {
    expect(familiesIn(`"Matter", 'Inter Variable', system-ui, sans-serif`)).toEqual(['Matter', 'Inter Variable']);
    expect([...familiesUsed('<p style="font-family:Matter, sans-serif;color:red">x</p><span style="font-family:&quot;Paper Mono&quot;, monospace">y</span>')]).toEqual(['matter', 'paper mono']);
  });

  it('parses @font-face blocks, woff2 first, resolved against the sheet', () => {
    const [face] = parseFontFaces(`@font-face{font-family:"Matter";src:url(/f/m.woff) format("woff"),url(/f/m.woff2) format("woff2");font-weight:400 700;unicode-range:U+0000-00FF}`, 'https://site.test/css/a.css');
    expect(face!.family).toBe('Matter');
    expect(face!.urls).toEqual(['https://site.test/f/m.woff2', 'https://site.test/f/m.woff']);
    expect(face!.descriptors['font-weight']).toBe('400 700');
  });

  it('keeps only unicode-range subsets the text uses', () => {
    const latin = new Set([...'Hello'].map((c) => c.codePointAt(0)!));
    const cyrillic = new Set([...'Здравей'].map((c) => c.codePointAt(0)!));
    expect(rangeCovers('U+0000-00FF, U+0131', latin)).toBe(true);
    expect(rangeCovers('U+0400-045F', latin)).toBe(false);
    expect(rangeCovers('U+0400-045F', cyrillic)).toBe(true);
    expect(rangeCovers('U+04??', cyrillic)).toBe(true);
    expect(rangeCovers(undefined, latin)).toBe(true);
  });

  it('inlines the faces a capture uses as self-contained rules', async () => {
    const style = document.createElement('style');
    style.textContent = `@font-face{font-family:"Matter";src:url(/m.woff2) format("woff2");font-weight:400}@font-face{font-family:"Unused";src:url(/u.woff2)}`;
    document.head.appendChild(style);
    try {
      const css = await embedFonts(document, '<p style="font-family:Matter, sans-serif">Hi</p>', 'Hi', {
        fetchFont: async () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'font/woff2' }),
        fetchText: async () => null,
      });
      expect(css).toContain('font-family:"Matter"');
      expect(css).toContain('src:url(data:font/woff2;base64,AQIDBA==)');
      expect(css).toContain('font-weight:400');
      expect(css).not.toContain('Unused');
    } finally {
      style.remove();
    }
  });
});
