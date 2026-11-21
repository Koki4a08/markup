import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { ThemePanel } from '../src/panels/ThemePanel';
import { SelectionProvider } from '../src/canvas/selection';
import { DocProvider } from '../src/store/DocProvider';
import { analyzeSubtree } from '../src/panels/selectionTheme';
import { parseColor } from '../src/panels/color';
import { parseBorder, parseFilters, parseShadows, visibleSides, writeBorder, writeShadows } from '../src/panels/effects';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [dark] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'Dark card', styles: { backgroundColor: '#18181b', borderRadius: '12px', padding: '16px', gap: '8px' } }]);
  const [title, body] = doc.insertNodes(human, dark!, [
    { type: 'text', name: 'Title', text: 'Hi', styles: { color: '#fafafa', fontFamily: '"Inter", sans-serif', fontWeight: 600, fontSize: '24px' } },
    { type: 'text', name: 'Body', text: 'Yo', styles: { color: 'rgba(250, 250, 250, 0.7)', fontSize: '14px' } },
  ]);
  const [light] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'Light card', styles: { backgroundColor: 'white' } }]);
  return { doc, rootId: page.rootId, dark: dark!, title: title!, body: body!, light: light! };
}

describe('color parsing', () => {
  it('reads hex, rgb, hsl and named colours', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('#00000080')?.a).toBeCloseTo(0.502, 2);
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('var(--x)')).toBeNull();
  });

  it('reads lab, oklch and color() from computed snapshot styles', () => {
    expect(parseColor('lab(98.26 0 0)')).toEqual({ r: 250, g: 250, b: 250, a: 1 });
    expect(parseColor('lab(0.903296 0 0)')).toEqual({ r: 3, g: 3, b: 3, a: 1 });
    expect(parseColor('lab(40.4273 67.2623 53.7441)')).toMatchObject({ r: 193, g: 0, b: 7 });
    expect(parseColor('oklch(62.8% 0.2577 29.23)')).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(parseColor('color(srgb 0.761176 0.838824 0.954118)')).toEqual({ r: 194, g: 214, b: 243, a: 1 });
  });
});

describe('effects parsing', () => {
  it('border shorthands resolve per side, longhands win', () => {
    const sides = parseBorder({ border: '1px solid red', borderBottomWidth: '3px', borderLeft: 'none' });
    expect(visibleSides(sides)).toEqual(['Top', 'Right', 'Bottom']);
    expect(sides.Bottom).toEqual({ width: '3px', style: 'solid', color: 'red' });
    expect(writeBorder({ Top: sides.Top, Bottom: sides.Bottom })).toMatchObject({ border: null, borderTop: '1px solid red', borderBottom: '3px solid red', borderLeft: null });
  });

  it('box-shadow layers round-trip, colours with commas included', () => {
    const list = parseShadows('0 1px 2px rgba(0, 0, 0, 0.2), inset 0 0 0 1px #fff');
    expect(list).toEqual([
      { inset: false, x: '0', y: '1px', blur: '2px', spread: '0px', color: 'rgba(0, 0, 0, 0.2)' },
      { inset: true, x: '0', y: '0', blur: '0', spread: '1px', color: '#fff' },
    ]);
    expect(writeShadows(list)).toBe('0 1px 2px 0px rgba(0, 0, 0, 0.2), inset 0 0 0 1px #fff');
  });

  it('filters split into functions for both properties', () => {
    expect(parseFilters({ filter: 'blur(2px) drop-shadow(0 1px 2px rgba(0,0,0,.3))', backdropFilter: 'blur(12px)' })).toEqual([
      { prop: 'filter', fn: 'blur', arg: '2px' },
      { prop: 'filter', fn: 'drop-shadow', arg: '0 1px 2px rgba(0,0,0,.3)' },
      { prop: 'backdropFilter', fn: 'blur', arg: '12px' },
    ]);
  });
});

describe('selection theme', () => {
  it('detects a dark component and its colours, type, radius and spacing', () => {
    const { doc, dark } = setup();
    const t = analyzeSubtree(doc, [dark]);
    expect(t.mode).toBe('dark');
    expect(t.background).toEqual({ r: 24, g: 24, b: 27, a: 1 });
    expect(t.colors.map((c) => c.uses.length)).toEqual([1, 1, 1]);
    expect(t.fonts).toEqual([
      { family: 'Inter', weight: '600', size: '24px', count: 1 },
      { family: 'Default', weight: '400', size: '14px', count: 1 },
    ]);
    expect(t.radii).toEqual([{ value: '12px', count: 1 }]);
    expect(t.spacing.map((s) => s.value)).toEqual(['8px', '16px']);
  });

  it('ignores invisible strokes and counts text colour per text layer, inherited or not', () => {
    const doc = new MarkupDoc();
    const page = doc.pages()[0]!;
    if (page.type !== 'page') throw new Error('unreachable');
    const [frame] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'Hero', styles: { backgroundColor: 'lab(98.26 0 0)' } }]);
    doc.updateStyles(human, [{ nodeIds: [frame!], styles: { color: 'lab(0.903296 0 0)', borderTopWidth: '0px', borderTopStyle: 'solid', borderTopColor: 'lab(90.72 0 0)' } }], undefined, { dialect: 'any' });
    const [button] = doc.insertNodes(human, frame!, [{ type: 'frame', name: 'Button', styles: { backgroundColor: 'rgb(52, 118, 216)' } }]);
    doc.updateStyles(human, [{ nodeIds: [button!], styles: { color: 'rgb(255, 255, 255)' } }], undefined, { dialect: 'any' });
    doc.insertNodes(human, frame!, [
      { type: 'text', name: 'a', text: 'UI for agents' },
      { type: 'text', name: 'b', text: 'Show AI what good looks like.' },
    ]);
    doc.insertNodes(human, button!, [{ type: 'text', name: 'c', text: 'CONNECT' }]);
    const t = analyzeSubtree(doc, [frame!]);
    expect(t.mode).toBe('light');
    expect(t.background).toEqual({ r: 250, g: 250, b: 250, a: 1 });
    expect(t.text).toEqual({ r: 3, g: 3, b: 3, a: 1 });
    expect(t.colors.map((c) => [c.color.r, c.uses.length])).toEqual([
      [3, 2],
      [52, 1],
      [250, 1],
      [255, 1],
    ]);
    // A child picked alone keeps the hero's light theme and its inherited text colour.
    expect(analyzeSubtree(doc, [button!]).text).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('a child inherits the theme of the background it sits on', () => {
    const { doc, title, light } = setup();
    expect(analyzeSubtree(doc, [title]).mode).toBe('dark');
    expect(analyzeSubtree(doc, [light]).mode).toBe('light');
  });

  it('token colours group under the token', () => {
    const { doc, light } = setup();
    doc.createTokens(human, [{ name: '--brand', type: 'color', value: '#2f6fe8' }]);
    doc.updateStyles(human, [{ nodeIds: [light], styles: { border: '1px solid var(--brand)' } }]);
    const brand = analyzeSubtree(doc, [light]).colors.find((c) => c.token);
    expect(brand).toMatchObject({ token: '--brand', color: { r: 47, g: 111, b: 232, a: 1 } });
  });

  it('Theme tab follows the selection, and shows the page with nothing selected', () => {
    const { doc, rootId, dark } = setup();
    const mount = (ids: string[]) =>
      render(
        <DocProvider doc={doc} actor={human}>
          <SelectionProvider initial={ids}>
            <ThemePanel pageRootId={rootId} />
          </SelectionProvider>
        </DocProvider>,
      );
    const page = mount([]);
    expect(screen.getByRole('region', { name: 'Theme of Page' })).toBeTruthy();
    page.unmount();
    mount([dark]);
    const region = screen.getByRole('region', { name: 'Theme of Dark card' });
    expect(region.textContent).toContain('Dark');
    expect(region.textContent).toContain('18181B');
    expect(region.textContent).toContain('Inter');
    act(() => {
      doc.updateStyles(human, [{ nodeIds: [dark], styles: { backgroundColor: '#ffffff' } }]);
    });
    expect(screen.getByRole('region', { name: 'Theme of Dark card' }).textContent).toContain('Light');
    fireEvent.click(screen.getByRole('button', { name: 'Create token from FFFFFF' }));
    expect(doc.requireNode(dark).styles.backgroundColor).toBe('var(--color-ffffff)');
    expect(screen.getByLabelText('Uses token --color-ffffff')).toBeTruthy();
  });

  it('typing a selection colour previews it on the canvas, and commits once', () => {
    const { doc, rootId, dark } = setup();
    const el = document.createElement('div');
    el.setAttribute('data-node-id', dark);
    el.style.backgroundColor = '#18181b';
    const world = document.createElement('div');
    world.className = 'canvas-world';
    world.appendChild(el);
    document.body.appendChild(world);
    try {
      render(
        <DocProvider doc={doc} actor={human}>
          <SelectionProvider initial={[dark]}>
            <ThemePanel pageRootId={rootId} />
          </SelectionProvider>
        </DocProvider>,
      );
      const before = doc.log().length;
      const hex = screen.getByLabelText('18181B hex') as HTMLInputElement;
      fireEvent.change(hex, { target: { value: '00ff00' } });
      expect(el.style.backgroundColor).toBe('rgb(0, 255, 0)');
      expect(doc.requireNode(dark).styles.backgroundColor).toBe('#18181b');
      fireEvent.change(hex, { target: { value: '0000ff' } });
      expect(el.style.backgroundColor).toBe('rgb(0, 0, 255)');
      fireEvent.blur(hex);
      expect(doc.requireNode(dark).styles.backgroundColor).toBe('#0000ff');
      expect(doc.log()).toHaveLength(before + 1);
    } finally {
      world.remove();
    }
  });
});
