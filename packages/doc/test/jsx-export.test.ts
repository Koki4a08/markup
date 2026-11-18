import { describe, expect, it } from 'vitest';
import { findNodes, MarkupDoc, toJsx, toTailwindClasses, treeSummary, type Actor } from '../src/index';

const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(agent, page.rootId, [
    { type: 'frame', name: 'Hero', styles: { position: 'absolute', left: 0, top: 0, width: '1440px', height: '900px' } },
  ]);
  return { doc, rootId: page.rootId, artboard: artboard! };
}

describe('toJsx', () => {
  it('inline jsx includes ids by default', () => {
    const { doc, artboard } = setup();
    const [t] = doc.writeHtml(agent, artboard, '<p style="font-size:20px">Hi</p>', 'insert-children').nodeIds;
    const jsx = toJsx(doc, artboard);
    expect(jsx).toContain(`id="${artboard}"`);
    expect(jsx).toContain(`<p id="${t}" style={{ fontSize: "20px" }}>Hi</p>`);
  });

  it('includeNodeIds false strips them', () => {
    const { doc, artboard } = setup();
    expect(toJsx(doc, artboard, { includeNodeIds: false })).not.toContain('id=');
  });

  it('root position stripped unless includeRootPositioning', () => {
    const { doc, artboard } = setup();
    const plain = toJsx(doc, artboard);
    expect(plain).not.toContain('position');
    expect(plain).not.toContain('left');
    expect(plain).toContain('width: "1440px"');
    expect(toJsx(doc, artboard, { includeRootPositioning: true })).toContain('position: "absolute"');
  });

  it('nests children with two-space indentation', () => {
    const { doc, artboard } = setup();
    doc.writeHtml(agent, artboard, '<div style="gap:8px"><p>A</p></div>', 'insert-children');
    const lines = toJsx(doc, artboard, { includeNodeIds: false }).split('\n');
    expect(lines[1]).toMatch(/^ {2}<div/);
    expect(lines[2]).toMatch(/^ {4}<p>A<\/p>$/);
  });

  it('tailwind maps flex column gap and keeps unmapped inline', () => {
    expect(toTailwindClasses({ display: 'flex', flexDirection: 'column', gap: '24px', backgroundColor: '#0F3B4C', mixBlendMode: 'multiply' })).toEqual({
      className: 'flex flex-col gap-[24px] bg-[#0F3B4C]',
      rest: { mixBlendMode: 'multiply' },
    });
    const { doc, artboard } = setup();
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { display: 'flex', mixBlendMode: 'multiply' } }]);
    const jsx = toJsx(doc, artboard, { format: 'tailwind', includeNodeIds: false });
    expect(jsx).toContain('className="flex w-[1440px] h-[900px]"');
    expect(jsx).toContain('style={{ mixBlendMode: "multiply" }}');
  });

  it('round-trips non-latin text', () => {
    const { doc, artboard } = setup();
    doc.writeHtml(agent, artboard, '<p>Здравей 你好 👋</p>', 'insert-children');
    expect(toJsx(doc, artboard)).toContain('Здравей 你好 👋');
  });

  it('renders image and svg nodes', () => {
    const { doc, artboard } = setup();
    doc.writeHtml(agent, artboard, '<img src="markup-asset:///a.png"><svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>', 'insert-children');
    const jsx = toJsx(doc, artboard, { includeNodeIds: false });
    expect(jsx).toContain('<img src="markup-asset:///a.png" />');
    expect(jsx).toContain('<svg viewBox="0 0 1 1"><path d="M0 0"></path></svg>');
  });
});

describe('queries', () => {
  it('treeSummary respects depth and shows child counts', () => {
    const { doc, artboard } = setup();
    doc.writeHtml(agent, artboard, '<div layer-name="Card"><div layer-name="Inner"><p>x</p><p>y</p></div></div>', 'insert-children');
    const summary = treeSummary(doc, artboard, 2);
    expect(summary.split('\n')[0]).toBe(`frame "Hero" (${artboard}) 1440×900`);
    expect(summary).toContain('  frame "Card"');
    expect(summary).toContain('    frame "Inner"');
    expect(summary).toContain('… 2 children');
    expect(summary).not.toContain('text "x"');
  });

  it('treeSummary caps depth at 10', () => {
    const { doc, artboard } = setup();
    let html = '<p>leaf</p>';
    for (let i = 0; i < 12; i++) html = `<div>${html}</div>`;
    doc.writeHtml(agent, artboard, html, 'insert-children');
    expect(treeSummary(doc, artboard, 50).split('\n').length).toBe(11 + 1);
  });

  it('findNodes text wildcard', () => {
    const { doc, artboard } = setup();
    const [a] = doc.writeHtml(agent, artboard, '<p>Get started</p>', 'insert-children').nodeIds;
    doc.writeHtml(agent, artboard, '<p>Forget it</p>', 'insert-children');
    const res = findNodes(doc, { textValue: 'get *' });
    expect(res.map((r) => r.id)).toEqual([a]);
    expect(res[0]!.matched).toEqual([{ textValue: 'Get started' }]);
  });

  it('findNodes color equivalence', () => {
    const { doc, artboard } = setup();
    const [a] = doc.writeHtml(agent, artboard, '<div style="background-color: rgb(204, 204, 204)"></div>', 'insert-children').nodeIds;
    const res = findNodes(doc, { filters: [{ styleName: 'background*', styleValue: '#ccc' }] });
    expect(res.map((r) => r.id)).toEqual([a]);
    expect(res[0]!.matched).toEqual([{ styleName: 'backgroundColor', styleValue: 'rgb(204, 204, 204)' }]);
  });

  it('findNodes filters combine with AND and scope to nodeId', () => {
    const { doc, artboard } = setup();
    doc.writeHtml(agent, artboard, '<div style="gap:8px;padding:4px"></div><div style="gap:8px"></div>', 'insert-children');
    expect(findNodes(doc, { nodeId: artboard, filters: [{ styleName: 'gap', styleValue: '8px' }, { styleName: 'padding' }] })).toHaveLength(1);
  });
});
