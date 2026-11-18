import { beforeEach, describe, expect, it } from 'vitest';
import { css2Url, ensureFontsLoaded, familyInfo, googleFont, resetLoadedFonts } from '../src/fonts/fontLoader';
import { runFontTool } from '../src/bridge/fontTools';

beforeEach(() => {
  resetLoadedFonts();
  document.head.innerHTML = '';
});

describe('font info', () => {
  it('google family reports weights and axes', () => {
    const [inter] = familyInfo(['Inter'], []);
    expect(inter).toMatchObject({ family: 'Inter', available: true, source: 'google' });
    const upright = inter!.styleGroups.find((g) => !g.italic)!;
    expect(upright.weights).toContain(400);
    expect(upright.weights).toContain(900);
    expect(upright.axes).toContainEqual({ tag: 'wght', min: 100, max: 900 });
    expect(inter!.styleGroups.some((g) => g.italic)).toBe(true);
  });

  it('local font wins over google', () => {
    const [inter] = familyInfo(['inter'], [
      { family: 'Inter', style: 'Regular' },
      { family: 'Inter', style: 'Bold Italic' },
    ]);
    expect(inter!.source).toBe('local');
    expect(inter!.styleGroups).toEqual([
      { italic: false, width: 'normal', weights: [400], axes: [] },
      { italic: true, width: 'normal', weights: [700], axes: [] },
    ]);
    ensureFontsLoaded(['Inter'], [{ family: 'Inter', style: 'Regular' }]);
    expect(document.head.querySelectorAll('link')).toHaveLength(0);
  });

  it('unknown family is unavailable', async () => {
    expect(familyInfo(['Not A Real Font'], [])[0]).toEqual({ family: 'Not A Real Font', available: false, source: null, styleGroups: [] });
    const out = await runFontTool({ familyNames: ['Not A Real Font'] });
    expect(out.families[0]!.available).toBe(false);
  });

  it('css2 url encodes axes ranges', () => {
    const inter = googleFont('Inter')!;
    expect(css2Url(inter)).toBe('https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap');
    expect(css2Url({ family: 'Open Sans', styles: [{ weight: 400, italic: false }, { weight: 700, italic: false }], axes: [] })).toBe(
      'https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap',
    );
    expect(css2Url({ family: 'X', styles: [], axes: [{ tag: 'wght', min: 1, max: 9 }, { tag: 'CASL', min: 0, max: 1 }, { tag: 'slnt', min: -15, max: 0 }] })).toContain(
      ':slnt,wght,CASL@-15..0,1..9,0..1',
    );
  });

  it('adds one link per google family and dedupes across calls', () => {
    ensureFontsLoaded(['Inter', 'Roboto', 'Arial Custom']);
    ensureFontsLoaded(['Inter']);
    const hrefs = [...document.head.querySelectorAll('link')].map((l) => l.href);
    expect(hrefs).toHaveLength(2);
    expect(hrefs[0]).toContain('family=Inter');
  });
});
