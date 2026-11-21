import { describe, expect, it } from 'vitest';
import { findNodes, MarkupDoc, resolveTokenValue, type Actor } from '../src/index';

const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(agent, page.rootId, [{ type: 'frame', name: 'Hero' }]);
  return { doc, artboard: artboard! };
}

describe('tokens', () => {
  it('invalid name returns error entry, others still created', () => {
    const { doc } = setup();
    const res = doc.createTokens(agent, [
      { type: 'color', name: 'bad name', value: '#fff' },
      { type: 'color', name: '--color-bg', value: '#fff' },
    ]);
    expect(res[0]).toMatchObject({ name: 'bad name', result: 'error' });
    expect(res[1]).toEqual({ name: '--color-bg', result: 'created' });
    expect(doc.getTokens()).toEqual([{ type: 'color', name: '--color-bg', value: '#fff' }]);
  });

  it('description over 1024 chars is rejected', () => {
    const { doc } = setup();
    const [r] = doc.createTokens(agent, [{ type: 'color', name: '--c', value: '#000', description: 'x'.repeat(1025) }]);
    expect(r!.result).toBe('error');
  });

  it('alias resolves through two hops', () => {
    const { doc } = setup();
    doc.createTokens(agent, [
      { type: 'color', name: '--blue-500', value: '#2563eb' },
      { type: 'color', name: '--color-primary', value: 'var(--blue-500)' },
      { type: 'color', name: '--button-bg', value: 'var(--color-primary)' },
    ]);
    expect(resolveTokenValue(doc, 'var(--button-bg)')).toBe('#2563eb');
  });

  it('alias cycle stops instead of looping', () => {
    const { doc } = setup();
    doc.createTokens(agent, [
      { type: 'color', name: '--a', value: 'var(--b)' },
      { type: 'color', name: '--b', value: 'var(--a)' },
    ]);
    expect(() => resolveTokenValue(doc, 'var(--a)')).not.toThrow();
  });

  it('rename rewrites var references in styles and tokens', () => {
    const { doc, artboard } = setup();
    doc.createTokens(agent, [
      { type: 'color', name: '--brand', value: '#f00' },
      { type: 'color', name: '--button', value: 'var(--brand)' },
    ]);
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { backgroundColor: 'var(--brand)' } }]);
    const [r] = doc.setTokens(agent, [{ name: '--brand', newName: '--color-brand' }]);
    expect(r).toEqual({ name: '--brand', result: 'updated' });
    expect(doc.requireNode(artboard).styles.backgroundColor).toBe('var(--color-brand)');
    expect((doc.getTokens() as { name: string; value: unknown }[]).find((t) => t.name === '--button')!.value).toBe('var(--color-brand)');
  });

  it('delete removes token and unknown name errors', () => {
    const { doc } = setup();
    doc.createTokens(agent, [{ type: 'radius', name: '--r', value: '8px' }]);
    const res = doc.setTokens(agent, [{ name: '--r', delete: true }, { name: '--missing', value: '1px' }]);
    expect(res[0]).toEqual({ name: '--r', result: 'deleted' });
    expect(res[1]).toMatchObject({ name: '--missing', result: 'error' });
    expect(doc.getTokens()).toEqual([]);
  });

  it('filters by type and name pattern', () => {
    const { doc } = setup();
    doc.createTokens(agent, [
      { type: 'color', name: '--color-a', value: '#000' },
      { type: 'spacing', name: '--space-1', value: '4px' },
    ]);
    expect(doc.getTokens({ types: ['spacing'] })).toHaveLength(1);
    expect(doc.getTokens({ namePattern: '--color-*' })).toHaveLength(1);
  });

  it('css format', () => {
    const { doc } = setup();
    doc.createTokens(agent, [
      { type: 'color', name: '--color-bg', value: '#fff' },
      { type: 'spacing', name: '--space-2', value: '8px' },
    ]);
    expect(doc.getTokens({ format: 'css' })).toBe(':root {\n  --color-bg: #fff;\n  --space-2: 8px;\n}');
  });

  it('tailwind format namespaces by type', () => {
    const { doc } = setup();
    doc.createTokens(agent, [
      { type: 'color', name: '--color-bg', value: '#fff' },
      { type: 'color', name: '--brand', value: '#f00' },
      { type: 'fontSize', name: '--body', value: '16px' },
    ]);
    expect(doc.getTokens({ format: 'tailwind' })).toBe('@theme {\n  --color-bg: #fff;\n  --color-brand: #f00;\n  --text-body: 16px;\n}');
  });

  it('findNodes literal color finds token-bound usage reported as var(--x)', () => {
    const { doc, artboard } = setup();
    doc.createTokens(agent, [{ type: 'color', name: '--brand', value: '#ff0000' }]);
    doc.updateStyles(agent, [{ nodeIds: [artboard], styles: { backgroundColor: 'var(--brand)' } }]);
    const res = findNodes(doc, { filters: [{ styleValue: 'rgb(255, 0, 0)' }] });
    expect(res).toEqual([{ id: artboard, name: 'Hero', component: 'Frame', matched: [{ styleName: 'backgroundColor', styleValue: 'var(--brand)' }] }]);
  });
});
