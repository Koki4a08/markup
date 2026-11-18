import { describe, expect, it } from 'vitest';
import { MarkupDoc, MarkupError, runDocTool, type Actor } from '../src/index';

const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };

function setup() {
  const doc = new MarkupDoc({ name: 'Pages' });
  const a = doc.pages()[0]!.id;
  const b = doc.createPage(agent, { name: 'B' });
  const c = doc.createPage(agent, { name: 'C' });
  return { doc, a, b, c };
}

const ids = (doc: MarkupDoc) => doc.pages().map((p) => p.id);

describe('update_pages', () => {
  it('renames and sets icon', () => {
    const { doc, a, b } = setup();
    doc.updatePages(agent, [{ pageId: a, name: 'Home', icon: 'design' }, { pageId: b, name: 'Two' }]);
    expect(doc.pages()[0]).toMatchObject({ name: 'Home', icon: 'design' });
    expect(doc.pages()[1]).toMatchObject({ name: 'Two', icon: null });
    expect(doc.log().at(-1)!.summary).toBe('Updated 2 pages');
  });

  it('null icon restores default', () => {
    const { doc, a } = setup();
    doc.updatePages(agent, [{ pageId: a, icon: 'vector' }]);
    doc.updatePages(agent, [{ pageId: a, icon: null }]);
    expect(doc.pages()[0]).toMatchObject({ icon: null });
  });

  it('unknown page is PAGE_NOT_FOUND and changes nothing', () => {
    const { doc, a } = setup();
    expect(() => doc.updatePages(agent, [{ pageId: a, name: 'X' }, { pageId: 'nope', name: 'Y' }])).toThrow(MarkupError);
    expect(doc.pages()[0]).toMatchObject({ name: 'Page 1' });
  });
});

describe('arrange_pages', () => {
  it('reorders and adds a divider', () => {
    const { doc, a, b, c } = setup();
    const result = doc.arrangePages(agent, [c, { type: 'divider' }, a, b]);
    expect(result).toEqual(doc.pages());
    expect(result.map((p) => p.type)).toEqual(['page', 'divider', 'page', 'page']);
    expect([result[0]!.id, result[2]!.id, result[3]!.id]).toEqual([c, a, b]);
    expect(result[1]!.id).toBeTruthy();
    expect(doc.log().at(-1)!.summary).toBe('Arranged pages');
  });

  it('missing page in order is INVALID_ORDER and changes nothing', () => {
    const { doc, a, b } = setup();
    const before = doc.pages();
    expect(() => doc.arrangePages(agent, [b, a])).toThrow(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(() => doc.arrangePages(agent, [a, b, b])).toThrow(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(() => doc.arrangePages(agent, [a, b, 'ghost'])).toThrow(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(doc.pages()).toEqual(before);
  });

  it('removeDividerIds drops dividers', () => {
    const { doc, a, b, c } = setup();
    const [, d] = doc.arrangePages(agent, [a, { type: 'divider' }, b, c]);
    const out = doc.arrangePages(agent, [a, b, c], [d!.id]);
    expect(ids(doc)).toEqual([a, b, c]);
    expect(out).toHaveLength(3);
    // a removed divider must not stay in order, a page cannot be removed
    const [, d2] = doc.arrangePages(agent, [a, { type: 'divider' }, b, c]);
    expect(() => doc.arrangePages(agent, [a, d2!.id, b, c], [d2!.id])).toThrow(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(() => doc.arrangePages(agent, [a, d2!.id, c], [b])).toThrow(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(doc.pages()).toHaveLength(4);
  });

  it('page root ids survive arrange', () => {
    const { doc, a, b, c } = setup();
    const roots = new Map(doc.pages().map((p) => [p.id, p.type === 'page' ? p.rootId : '']));
    doc.arrangePages(agent, [c, b, a]);
    for (const p of doc.pages()) {
      if (p.type === 'page') {
        expect(p.rootId).toBe(roots.get(p.id));
        expect(doc.requireNode(p.rootId).type).toBe('root');
      }
    }
  });
});

describe('page tools via runDocTool', () => {
  it('runDocTool update_pages / arrange_pages', () => {
    const { doc, a, b, c } = setup();
    const run = (m: 'update_pages' | 'arrange_pages', p: unknown) => runDocTool(doc, agent, m, p, { activePageId: a, currentUserId: 'local-user' });
    run('update_pages', { updates: [{ pageId: b, name: 'Renamed', icon: 'paper' }] });
    expect(doc.pages()[1]).toMatchObject({ name: 'Renamed', icon: 'paper' });
    const out = run('arrange_pages', { order: [c, { type: 'divider' }, a, b] }) as { pages: { type: string }[] };
    expect(out.pages.map((p) => p.type)).toEqual(['page', 'divider', 'page', 'page']);
    expect(() => run('arrange_pages', { order: [a] })).toThrow(expect.objectContaining({ code: 'INVALID_ORDER' }));
    expect(() => run('update_pages', { updates: [] })).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }));
  });
});
