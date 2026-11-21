import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { Canvas } from '../src/canvas/Canvas';
import { ValueStore } from '../src/canvas/store';
import { DocProvider } from '../src/store/DocProvider';
import { knownLocalFonts, listLocalFonts, requestLocalFonts, resetLocalFontsCache } from '../src/fonts/localFonts';
import { LOCAL_FONTS_NOTE } from '../src/bridge/fontTools';

import { css2Url, ensureFontsLoaded, familyInfo, googleFont, resetLoadedFonts } from '../src/fonts/fontLoader';
import { runFontTool } from '../src/bridge/fontTools';

const actor: Actor = { id: 'u1', kind: 'human', name: 'KG' };

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

  it('google stylesheet links are CORS-enabled so exports can read them', () => {
    ensureFontsLoaded(['Inter']);
    const link = document.head.querySelector<HTMLLinkElement>('link[href*="family=Inter"]')!;
    expect(link.crossOrigin).toBe('anonymous');
  });
});

describe('desktop content security policy', () => {
  it('lets exports fetch Google fonts and remote images', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const conf = JSON.parse(readFileSync(resolve(__dirname, '../src-tauri/tauri.conf.json'), 'utf8')) as { app: { security: { csp: string } } };
    const directives = Object.fromEntries(conf.app.security.csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    const connect = directives['connect-src'] as string[];
    for (const source of ["'self'", 'ws://127.0.0.1:29980', 'ipc:', 'http://ipc.localhost', 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', 'https:']) expect(connect).toContain(source);
  });
});

describe('local font access', () => {
  const g = globalThis as { queryLocalFonts?: unknown };
  const setPermission = (state: string | 'throw') => {
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: { query: async () => (state === 'throw' ? Promise.reject(new TypeError('bad name')) : { state }) },
    });
  };
  beforeEach(() => resetLocalFontsCache());
  afterEach(() => {
    delete g.queryLocalFonts;
    Reflect.deleteProperty(navigator, 'permissions');
  });

  it('does not call queryLocalFonts on canvas mount when permission is not granted', async () => {
    const query = vi.fn(async () => []);
    g.queryLocalFonts = query;
    setPermission('prompt');
    const doc = new MarkupDoc();
    const rootId = (doc.pages()[0] as { rootId: string }).rootId;
    doc.insertNodes(actor, rootId, [{ type: 'frame', name: 'A', styles: { fontFamily: 'Inter' } }]);
    render(
      <DocProvider doc={doc} actor={actor}>
        <Canvas rootId={rootId} viewport={new ValueStore({ x: 0, y: 0, zoom: 1 })} />
      </DocProvider>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(query).not.toHaveBeenCalled();
    expect(document.head.querySelectorAll('link[href*="family=Inter"]')).toHaveLength(1);
  });

  it('adds the google link without waiting for a pending local-font query', () => {
    g.queryLocalFonts = () => new Promise(() => {});
    setPermission('granted');
    ensureFontsLoaded(['Roboto'], knownLocalFonts());
    expect(document.head.querySelectorAll('link')).toHaveLength(1);
  });

  it('does not cache a denial', async () => {
    let allowed = false;
    g.queryLocalFonts = async () => {
      if (!allowed) throw new DOMException('denied', 'NotAllowedError');
      return [{ family: 'Inter', style: 'Regular' }];
    };
    setPermission('prompt');
    expect(await requestLocalFonts()).toBe(false);
    expect(await listLocalFonts()).toEqual([]);
    allowed = true;
    expect(await requestLocalFonts()).toBe(true);
    expect(await listLocalFonts()).toEqual([{ family: 'Inter', style: 'Regular' }]);
  });

  it('tool notes that local fonts are not granted, and tolerates an unsupported permission name', async () => {
    g.queryLocalFonts = async () => [];
    setPermission('prompt');
    expect((await runFontTool({ familyNames: ['Inter'] })).localFonts).toBe(LOCAL_FONTS_NOTE);
    setPermission('throw');
    const out = await runFontTool({ familyNames: ['Inter'] });
    expect(out.localFonts).toBe(LOCAL_FONTS_NOTE);
    expect(out.families[0]!.source).toBe('google');
    setPermission('granted');
    expect('localFonts' in (await runFontTool({ familyNames: ['Inter'] }))).toBe(false);
  });
});
