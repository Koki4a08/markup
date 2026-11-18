import { describe, expect, it } from 'vitest';
import { MarkupDoc, normalizeStyles, parseHtml, type Actor } from '../src/index';

const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(agent, page.rootId, [{ type: 'frame', name: 'Hero', styles: { width: '1440px', height: '900px' } }]);
  return { doc, artboard: artboard! };
}

describe('normalizeStyles', () => {
  it('camelCases keys and drops banned layout', () => {
    const r = normalizeStyles({ 'background-color': '#fff', margin: '8px', marginTop: '4px', display: 'grid' }, { type: 'frame', isArtboard: false });
    expect(r.styles).toEqual({ backgroundColor: '#fff' });
    expect(r.ignored.sort()).toEqual(['display', 'margin', 'marginTop']);
  });

  it('font props on a frame are ignored', () => {
    const r = normalizeStyles({ fontSize: '16px', color: 'red', gap: '8px' }, { type: 'frame', isArtboard: false });
    expect(r.styles).toEqual({ gap: '8px' });
    expect(r.ignored.sort()).toEqual(['color', 'fontSize']);
  });

  it('font props on text are kept', () => {
    expect(normalizeStyles({ fontSize: '16px', color: 'red' }, { type: 'text', isArtboard: false }).ignored).toEqual([]);
  });

  it('null passes through as removal', () => {
    expect(normalizeStyles({ width: null }, { type: 'frame', isArtboard: false }).styles).toEqual({ width: null });
  });
});

describe('parseHtml', () => {
  it('div with inline styles becomes frame', () => {
    const { specs } = parseHtml('<div style="display: flex; gap: 24px"></div>');
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ type: 'frame', styles: { display: 'flex', gap: '24px' } });
  });

  it('margin and display grid are dropped and reported', () => {
    const { specs, ignored } = parseHtml('<div style="display:grid;margin:10px;padding:4px"></div>');
    expect(specs[0]!.styles).toEqual({ padding: '4px' });
    expect(ignored).toEqual(expect.arrayContaining(['display', 'margin']));
  });

  it('table imports as frames', () => {
    const { specs } = parseHtml('<table><tr><td>A</td><td>B</td></tr></table>');
    expect(specs[0]!.type).toBe('frame');
    const flat = JSON.stringify(specs);
    expect(flat).toContain('"text":"A"');
    expect(flat).toContain('"text":"B"');
  });

  it('var(--color-primary) survives', () => {
    const { specs } = parseHtml('<div style="background-color: var(--color-primary)"></div>');
    expect(specs[0]!.styles!.backgroundColor).toBe('var(--color-primary)');
  });

  it('paragraph with spans becomes one rich text node', () => {
    const { specs } = parseHtml('<p style="font-size:20px">Hi <b>there</b></p>');
    expect(specs[0]).toMatchObject({ type: 'text', text: 'Hi <b>there</b>', styles: { fontSize: '20px' } });
  });

  it('layer-name sets name', () => {
    const { specs } = parseHtml('<div layer-name="Hero"><span>Go</span></div>');
    expect(specs[0]!.name).toBe('Hero');
  });

  it('img keeps markup-asset src, svg keeps outer html', () => {
    const { specs } = parseHtml('<img src="markup-asset:///C:/a.png"><svg viewBox="0 0 2 2"><path d="M0 0h2"/></svg>');
    expect(specs[0]).toMatchObject({ type: 'image', src: 'markup-asset:///C:/a.png' });
    expect(specs[1]!.type).toBe('svg');
    expect(specs[1]!.svg).toContain('<path d="M0 0h2"');
  });

  it('mixed text and element children wrap loose text into text nodes', () => {
    const { specs } = parseHtml('<div>Label<div>Box</div></div>');
    expect(specs[0]!.children!.map((c) => c.type)).toEqual(['text', 'frame']);
  });

  it('x-markup-clone becomes cloneOf', () => {
    const { specs } = parseHtml('<x-markup-clone node-id="N1" style="width: 200px"></x-markup-clone>');
    expect(specs[0]).toMatchObject({ cloneOf: { nodeId: 'N1', styles: { width: '200px' } } });
  });
});

describe('writeHtml', () => {
  it('inserts children and reports ignored styles', () => {
    const { doc, artboard } = setup();
    const r = doc.writeHtml(agent, artboard, '<div style="margin:4px;gap:8px"><p>Hello</p></div>', 'insert-children');
    expect(r.nodeIds).toHaveLength(1);
    expect(r.ignoredStyles).toContain('margin');
    expect(doc.requireNode(r.nodeIds[0]!).children).toHaveLength(1);
  });

  it('replace mode swaps the target in place', () => {
    const { doc, artboard } = setup();
    const [a, b] = doc.insertNodes(agent, artboard, [{ type: 'frame', name: 'A' }, { type: 'frame', name: 'B' }]);
    const r = doc.writeHtml(agent, a!, '<div layer-name="A2"></div>', 'replace');
    expect(doc.requireNode(artboard).children).toEqual([r.nodeIds[0], b]);
    expect(doc.getNode(a!)).toBeUndefined();
  });

  it('x-markup-clone deep-copies with override', () => {
    const { doc, artboard } = setup();
    const [card] = doc.insertNodes(agent, artboard, [{ type: 'frame', name: 'Card', styles: { width: '100px' }, children: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
    const r = doc.writeHtml(agent, artboard, `<x-markup-clone node-id="${card}" style="width: 300px"></x-markup-clone>`, 'insert-children');
    const clone = doc.requireNode(r.nodeIds[0]!);
    expect(clone.children).toHaveLength(2);
    expect(clone.children).not.toEqual(doc.requireNode(card!).children);
    expect(clone.styles.width).toBe('300px');
    expect(clone.name).toBe('Card');
  });

  it('unknown clone node-id throws NODE_NOT_FOUND', () => {
    const { doc, artboard } = setup();
    expect(() => doc.writeHtml(agent, artboard, '<x-markup-clone node-id="nope"></x-markup-clone>', 'insert-children')).toThrow(
      expect.objectContaining({ code: 'NODE_NOT_FOUND' }),
    );
  });

  it('updateStyles drops inert styles and reports them per node', () => {
    const { doc, artboard } = setup();
    const r = doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { fontSize: '20px', padding: '8px' } }]);
    expect(r.ignoredStyles).toEqual({ [artboard]: ['fontSize'] });
    expect(doc.requireNode(artboard).styles.padding).toBe('8px');
  });
});

describe("the 'any' dialect", () => {
  it('normalizeStyles keeps margin, grid, inline display and text props on a frame', () => {
    const r = normalizeStyles(
      { 'margin-top': ' 12px ', display: 'grid', gridTemplateColumns: '1fr 2fr', color: 'red', fontSize: '14px' },
      { type: 'frame', isArtboard: false },
      'any',
    );
    expect(r.ignored).toEqual([]);
    expect(r.styles).toEqual({ marginTop: '12px', display: 'grid', gridTemplateColumns: '1fr 2fr', color: 'red', fontSize: '14px' });
    for (const display of ['inline', 'inline-block', 'table-cell', 'contents', 'list-item']) {
      expect(normalizeStyles({ display }, { type: 'frame', isArtboard: false }, 'any').styles).toEqual({ display });
    }
  });

  it('parseHtml passes the dialect through; the default stays strict', () => {
    const html = '<div style="display: grid; margin: 4px; color: red"><span style="display: inline; margin-left: 2px">a</span></div>';
    const any = parseHtml(html, { dialect: 'any' });
    expect(any.ignored).toEqual([]);
    expect(any.specs[0]).toMatchObject({ type: 'frame', styles: { display: 'grid', margin: '4px', color: 'red' } });
    expect(any.specs[0]!.children![0]).toMatchObject({ type: 'text', styles: { display: 'inline', marginLeft: '2px' } });
    expect(parseHtml(html).ignored.sort()).toEqual(['color', 'display', 'margin', 'marginLeft']);
  });

  it("parseHtml keeps a text node's edge whitespace in the 'any' dialect (it is inline flow)", () => {
    const { specs } = parseHtml('<div><span style="display:inline">Hello <b>bold</b> </span><span style="display:inline"> world</span></div>', { dialect: 'any' });
    expect(specs[0]!.children!.map((c) => c.text)).toEqual(['Hello <b>bold</b> ', ' world']);
  });

  it('updateStyles accepts the dialect; default strict', () => {
    const { doc, artboard } = setup();
    const strict = doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { marginTop: '4px' } }]);
    expect(strict.ignoredStyles[artboard]).toEqual(['marginTop']);
    expect(doc.requireNode(artboard).styles.marginTop).toBeUndefined();
    const any = doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { marginTop: '4px', display: 'grid' } }], undefined, { dialect: 'any' });
    expect(any.ignoredStyles).toEqual({});
    expect(doc.requireNode(artboard).styles).toMatchObject({ marginTop: '4px', display: 'grid' });
  });
});
