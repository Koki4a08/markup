import { describe, expect, it } from 'vitest';
import { MarkupDoc, parseHtml, type Actor } from '@markup/doc';
import { cleanHtml, pasteIntoDoc } from '../src/paste';
// The real extension capture, run against its layout-free test env, piped into the app's paste path.
import { capture } from '../../extension/src/capture/serialize';
import { fakeEnv } from '../../extension/test/fakeEnv';
import { fixture } from '../../extension/test/fixtures';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };
const META = { title: 'Acme — Home', url: 'https://acme.test/' };

async function captured(name: string): Promise<string> {
  const f = fixture(name);
  document.body.innerHTML = f.html;
  const html = await capture(f.targets.map((id) => document.getElementById(id)!), fakeEnv(f.images, f.textRects), META);
  document.body.innerHTML = '';
  return html;
}

/** What Chrome's async clipboard sanitiser can do to text/html: drop comments. */
const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, '');

describe('extension snapshot pasted into the app', () => {
  it.each([
    ['with the marker comment', (html: string) => html],
    ['with comments stripped by the clipboard', stripComments],
  ])('%s: one artboard per snapshot root, named after the page, no ignored styles', async (_name, transform) => {
    for (const name of ['flex row', 'two targets', 'mixed content']) {
      const html = transform(await captured(name));
      if (transform === stripComments) expect(html).not.toContain('<!--');
      const cleaned = cleanHtml(html);
      const parsed = parseHtml(cleaned);
      expect(parsed.ignored, name).toEqual([]);
      const roots = new DOMParser().parseFromString(`<body>${cleaned}</body>`, 'text/html').body.querySelectorAll(':scope > div');
      const doc = new MarkupDoc({ name: 'Paste' });
      const page = doc.pages()[0]!;
      if (page.type !== 'page') throw new Error('unreachable');
      const ids = await pasteIntoDoc(doc, human, { html }, { selection: [], rootId: page.rootId, viewportCenter: { x: 0, y: 0 } });
      expect(ids, name).toHaveLength(roots.length);
      for (const id of ids) {
        const node = doc.requireNode(id);
        expect(node.parentId).toBe(page.rootId);
        expect(node.name).toBe(META.title);
        expect(node.styles.position).toBe('absolute');
        // The snapshot root itself is the artboard, not wrapped in an extra one.
        expect(node.children.map((c) => doc.requireNode(c).name), name).not.toContain(META.title);
        expect(node.styles.height, name).not.toBe('fit-content');
      }
    }
  });
});
