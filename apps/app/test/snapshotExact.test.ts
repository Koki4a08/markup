import { describe, expect, it } from 'vitest';
import { MarkupDoc, parseHtml, type Actor, type MarkupNode } from '@markup/doc';
import { cleanHtml, pasteIntoDoc } from '../src/clipboard/paste';
// The extension's exact capture, run against its layout-free test env, piped into the app's paste path.
import { captureExact } from '../../extension/src/capture/exact';
import { fakeEnv } from '../../extension/test/fakeEnv';
import { EXACT_FIXTURES, FIXTURES, type Fixture } from '../../extension/test/fixtures';

const MARKER = '<!--markup:snapshot v1-->';
const META = { title: 'Acme — Repo', url: 'https://acme.test/repo' };
const UNSAFE = /javascript:|expression\(|-moz-binding|behavior\s*:|@import|image-set\(|\\/i;
const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

async function captured(f: Fixture): Promise<string> {
  document.body.innerHTML = f.html;
  const html = await captureExact(f.targets.map((id) => document.getElementById(id)!), fakeEnv(f.images, f.textRects), META);
  document.body.innerHTML = '';
  return html;
}

/** Every style attribute outside svg markup (the sanitiser's svg handling is not under test here). */
const styleAttrs = (html: string): string[] =>
  Array.from(new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body.querySelectorAll('[style]'))
    .filter((el) => !el.closest('svg'))
    .map((el) => el.getAttribute('style')!);

const all = (doc: MarkupDoc, id: string): MarkupNode[] => {
  const n = doc.requireNode(id);
  return [n, ...n.children.flatMap((c) => all(doc, c))];
};

describe('exact snapshot dialect', () => {
  it.each([...FIXTURES, ...EXACT_FIXTURES].map((f) => [f.name, f] as const))('%s: parses in the any dialect with nothing ignored and survives the sanitiser', async (_name, f) => {
    const html = await captured(f);
    expect(html.startsWith(MARKER)).toBe(true);
    expect(html).not.toMatch(UNSAFE);
    const { specs, ignored } = parseHtml(html.slice(MARKER.length), { dialect: 'any' });
    expect(ignored).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.type).toBe('frame');
    const cleaned = cleanHtml(html);
    expect(cleaned).toContain('data-markup-dialect="any"');
    expect(styleAttrs(cleaned)).toEqual(styleAttrs(html));
  });

  it('pastes as one artboard that keeps margins, grid and inline display', async () => {
    const doc = new MarkupDoc({ name: 'Paste' });
    const page = doc.pages()[0]!;
    if (page.type !== 'page') throw new Error('unreachable');
    for (const name of ['child margins', 'grid template', 'file name']) {
      const f = EXACT_FIXTURES.find((x) => x.name === name)!;
      const ids = await pasteIntoDoc(doc, human, { html: await captured(f) }, { selection: [], rootId: page.rootId, viewportCenter: { x: 0, y: 0 } });
      expect(ids, name).toHaveLength(1);
      const nodes = all(doc, ids[0]!);
      expect(nodes[0]!.name).toBe(META.title);
      if (name === 'child margins') expect(nodes.some((n) => n.styles.marginTop === '12px')).toBe(true);
      if (name === 'grid template') expect(nodes.some((n) => n.styles.display === 'grid' && n.styles.gridTemplateColumns === '100px 200px')).toBe(true);
      if (name === 'file name') {
        const text = nodes.find((n) => n.type === 'text' && /README\.md/.test(n.text ?? ''));
        expect(text?.styles.display).toBe('inline');
        expect(nodes.some((n) => n.styles.display === 'inline-block' && n.styles.overflowX === 'hidden')).toBe(true);
      }
    }
  });
});
