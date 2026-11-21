import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { Inspector } from '../src/panels/Inspector';
import { SelectionProvider } from '../src/canvas/selection';
import { DocProvider } from '../src/store/DocProvider';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

function setup(parentStyles: Record<string, string> = { display: 'flex', flexDirection: 'column' }) {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'A', styles: parentStyles }]);
  const [a, b] = doc.insertNodes(human, artboard!, [
    { type: 'frame', name: 'a', styles: { display: 'flex', gap: '8px', mixBlendMode: 'multiply' } },
    { type: 'frame', name: 'b', styles: { display: 'flex', gap: '16px' } },
  ]);
  const mount = (ids: string[]) =>
    render(
      <DocProvider doc={doc} actor={human}>
        <SelectionProvider initial={ids}>
          <Inspector />
        </SelectionProvider>
      </DocProvider>,
    );
  return { doc, artboard: artboard!, a: a!, b: b!, mount };
}

describe('Inspector', () => {
  it('editing gap writes one updateStyles op', () => {
    const { doc, a, mount } = setup();
    mount([a]);
    const before = doc.log().length;
    const gap = screen.getByLabelText('Gap') as HTMLInputElement;
    expect(gap.value).toBe('8');
    fireEvent.change(gap, { target: { value: '24' } });
    fireEvent.keyDown(gap, { key: 'Enter' });
    expect(doc.requireNode(a).styles.gap).toBe('24px');
    expect(doc.log()).toHaveLength(before + 1);
  });

  it('typing previews on the canvas and commits once; Escape restores', () => {
    const { doc, a, mount } = setup();
    const world = document.createElement('div');
    world.className = 'canvas-world';
    const el = document.createElement('div');
    el.setAttribute('data-node-id', a);
    el.style.gap = '8px';
    world.appendChild(el);
    document.body.appendChild(world);
    try {
      mount([a]);
      const before = doc.log().length;
      const gap = screen.getByLabelText('Gap') as HTMLInputElement;
      fireEvent.change(gap, { target: { value: '30' } });
      expect(el.style.gap).toBe('30px');
      expect(doc.requireNode(a).styles.gap).toBe('8px');
      expect(doc.log()).toHaveLength(before);
      fireEvent.keyDown(gap, { key: 'Escape' });
      expect(el.style.gap).toBe('8px');
      fireEvent.change(gap, { target: { value: '12' } });
      fireEvent.change(gap, { target: { value: '14' } });
      fireEvent.keyDown(gap, { key: 'Enter' });
      expect(doc.requireNode(a).styles.gap).toBe('14px');
      expect(doc.log()).toHaveLength(before + 1);
    } finally {
      world.remove();
    }
  });

  it('mixed selection shows Mixed', () => {
    const { a, b, mount } = setup();
    mount([a, b]);
    const gap = screen.getByLabelText('Gap') as HTMLInputElement;
    expect(gap.value).toBe('');
    expect(gap.placeholder).toBe('Mixed');
  });

  it('has no free-form Other styles section; effects sections start collapsed', () => {
    const { a, mount } = setup();
    mount([a]);
    expect(screen.queryByRole('region', { name: 'Other styles' })).toBeNull();
    for (const title of ['Outline', 'Border', 'Shadow', 'Inner shadow', 'Filters']) expect(screen.getByRole('region', { name: title })).toBeTruthy();
    expect(screen.queryByLabelText('Border color')).toBeNull();
  });

  it('Fill sizing sets flex 1 in a row parent', () => {
    const { doc, a, mount } = setup({ display: 'flex', flexDirection: 'row' });
    mount([a]);
    fireEvent.change(screen.getByLabelText('Width sizing'), { target: { value: 'fill' } });
    expect(doc.requireNode(a).styles).toMatchObject({ flex: 1 });
    expect(doc.requireNode(a).styles.width).toBeUndefined();
  });

  it('Fill sizing on the cross axis stretches', () => {
    const { doc, a, mount } = setup({ display: 'flex', flexDirection: 'row' });
    mount([a]);
    fireEvent.change(screen.getByLabelText('Height sizing'), { target: { value: 'fill' } });
    expect(doc.requireNode(a).styles.alignSelf).toBe('stretch');
  });

  it('adds, edits and removes a border', () => {
    const { doc, a, mount } = setup();
    mount([a]);
    fireEvent.click(screen.getByRole('button', { name: 'Add border' }));
    expect(doc.requireNode(a).styles.border).toBe('1px solid #000000');
    const width = screen.getByLabelText('Border width') as HTMLInputElement;
    fireEvent.change(width, { target: { value: '2' } });
    fireEvent.keyDown(width, { key: 'Enter' });
    expect(doc.requireNode(a).styles.border).toBe('2px solid #000000');
    fireEvent.change(screen.getByLabelText('Border sides'), { target: { value: 'Bottom' } });
    expect(doc.requireNode(a).styles.border).toBeUndefined();
    expect(doc.requireNode(a).styles.borderBottom).toBe('2px solid #000000');
    fireEvent.click(screen.getByRole('button', { name: 'Remove border' }));
    expect(doc.requireNode(a).styles.borderBottom).toBeUndefined();
  });

  it('shadow and inner shadow share box-shadow', () => {
    const { doc, a, mount } = setup();
    mount([a]);
    fireEvent.click(screen.getByRole('button', { name: 'Add shadow' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add inner shadow' }));
    expect(doc.requireNode(a).styles.boxShadow).toBe('0px 4px 12px 0px rgba(0, 0, 0, 0.25), inset 0px 2px 4px 0px rgba(0, 0, 0, 0.15)');
    const blur = screen.getByLabelText('Shadow blur') as HTMLInputElement;
    fireEvent.change(blur, { target: { value: '20' } });
    fireEvent.keyDown(blur, { key: 'Enter' });
    expect(doc.requireNode(a).styles.boxShadow).toBe('0px 4px 20px 0px rgba(0, 0, 0, 0.25), inset 0px 2px 4px 0px rgba(0, 0, 0, 0.15)');
    fireEvent.click(screen.getByRole('button', { name: 'Remove inner shadow' }));
    expect(doc.requireNode(a).styles.boxShadow).toBe('0px 4px 20px 0px rgba(0, 0, 0, 0.25)');
  });

  it('filters: layer blur and background blur', () => {
    const { doc, a, mount } = setup();
    mount([a]);
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(doc.requireNode(a).styles.filter).toBe('blur(4px)');
    fireEvent.change(screen.getByLabelText('Filter 1 type'), { target: { value: 'backdrop:blur' } });
    expect(doc.requireNode(a).styles.filter).toBeUndefined();
    expect(doc.requireNode(a).styles.backdropFilter).toBe('blur(4px)');
  });

  it('selection colors list the subtree colours and recolour every use', () => {
    const { doc, artboard, a, mount } = setup();
    const [t] = doc.insertNodes(human, a, [{ type: 'text', name: 't', text: 'Hi', styles: { color: '#211c17' } }]);
    doc.updateStyles(human, [{ nodeIds: [a], styles: { backgroundColor: '#211C17', boxShadow: '0px 2px 4px 0px rgba(33, 28, 23, 0.12)' } }]);
    mount([artboard]);
    const list = screen.getByRole('list', { name: 'Selection colors' });
    const hexes = [...list.querySelectorAll<HTMLInputElement>('.sel-color-hex')].map((i) => i.value);
    expect(hexes).toEqual(['211C17', '211C17']);
    expect(screen.getByLabelText('Select 2 layers using 211C17')).toBeTruthy();
    const hex = list.querySelector<HTMLInputElement>('.sel-color-hex')!;
    fireEvent.change(hex, { target: { value: 'ff0000' } });
    fireEvent.blur(hex);
    expect(doc.requireNode(a).styles.backgroundColor).toBe('#ff0000');
    expect(doc.requireNode(t!).styles.color).toBe('#ff0000');
    expect(doc.requireNode(a).styles.boxShadow).toContain('rgba(33, 28, 23, 0.12)');
  });

  it('shows an empty state with no selection', () => {
    const { mount } = setup();
    mount([]);
    expect(screen.getByText('Select a layer to edit its styles.')).toBeTruthy();
  });
  it('token edits re-render the colour swatches that reference them', () => {
    const { doc, a, mount } = setup();
    doc.createTokens(human, [{ name: '--brand', type: 'color', value: '#ff0000' }]);
    doc.updateStyles(human, [{ nodeIds: [a], styles: { backgroundColor: 'var(--brand)' } }]);
    const { container } = mount([a]);
    const fill = () => (container.querySelector('.swatch-fill') as HTMLElement).style.background;
    expect(fill()).toBe('rgb(255, 0, 0)');
    act(() => {
      doc.setTokens(human, [{ name: '--brand', value: '#0000ff' }]);
    });
    expect(fill()).toBe('rgb(0, 0, 255)');
  });
  it('text color covers the whole layer: inline runs and an inherited text fill give way', () => {
    const { doc, artboard, mount } = setup();
    doc.updateStyles(human, [{ nodeIds: [artboard], styles: { WebkitTextFillColor: 'rgb(0, 0, 0)' } }], undefined, { dialect: 'any' });
    const [t] = doc.insertNodes(human, artboard, [{ type: 'text', name: 't', text: 'Hi <span style="color: red; font-weight: 700">there</span>', styles: { color: '#111111' } }]);
    mount([t!]);
    const color = screen.getByLabelText('Color') as HTMLInputElement;
    fireEvent.change(color, { target: { value: '#00ff00' } });
    fireEvent.keyDown(color, { key: 'Enter' });
    const node = doc.requireNode(t!);
    expect(node.styles.color).toBe('#00ff00');
    expect(node.styles.WebkitTextFillColor).toBe('currentcolor');
    expect(node.text).toBe('Hi <span style="font-weight: 700;">there</span>');
  });

  it('gradient text keeps its transparent fill when the colour changes', () => {
    const { doc, artboard, mount } = setup();
    const [t] = doc.insertNodes(human, artboard, [{ type: 'text', name: 't', text: 'Hi', styles: { color: '#111111' } }]);
    doc.updateStyles(human, [{ nodeIds: [t!], styles: { WebkitTextFillColor: 'transparent' } }], undefined, { dialect: 'any' });
    mount([t!]);
    const color = screen.getByLabelText('Color') as HTMLInputElement;
    fireEvent.change(color, { target: { value: '#00ff00' } });
    fireEvent.keyDown(color, { key: 'Enter' });
    expect(doc.requireNode(t!).styles.WebkitTextFillColor).toBe('transparent');
  });

  it('font weight reads keyword values', () => {
    const { doc, artboard, mount } = setup();
    const [t] = doc.insertNodes(human, artboard, [{ type: 'text', name: 't', text: 'Hi', styles: { fontWeight: 'bold' } }]);
    mount([t!]);
    expect((screen.getByLabelText('Weight') as HTMLSelectElement).value).toBe('700');
  });

  it('gap and radius edit captured longhands', () => {
    const { doc, a, mount } = setup();
    doc.updateStyles(human, [{ nodeIds: [a], styles: { gap: null, rowGap: '4px', columnGap: '4px', borderTopLeftRadius: '6px', borderTopRightRadius: '6px', borderBottomRightRadius: '6px', borderBottomLeftRadius: '6px' } }], undefined, { dialect: 'any' });
    mount([a]);
    const gap = screen.getByLabelText('Gap') as HTMLInputElement;
    expect(gap.value).toBe('4');
    fireEvent.change(gap, { target: { value: '20' } });
    fireEvent.keyDown(gap, { key: 'Enter' });
    const radius = screen.getByRole('textbox', { name: 'Radius' }) as HTMLInputElement;
    expect(radius.value).toBe('6');
    fireEvent.change(radius, { target: { value: '12' } });
    fireEvent.keyDown(radius, { key: 'Enter' });
    const s = doc.requireNode(a).styles;
    expect(s.gap).toBe('20px');
    expect(s.rowGap).toBeUndefined();
    expect(s.borderRadius).toBe('12px');
    expect(s.borderTopLeftRadius).toBeUndefined();
  });

  it('images and vectors get a radius section', () => {
    const { doc, artboard, mount } = setup();
    const [img] = doc.insertNodes(human, artboard, [{ type: 'image', name: 'i', src: 'data:image/png;base64,' }]);
    mount([img!]);
    expect(screen.getByRole('textbox', { name: 'Radius' })).toBeTruthy();
  });
  it('layout edits in a mixed selection change frames only', () => {
    const { doc, artboard, a, mount } = setup();
    const [t] = doc.insertNodes(human, artboard, [{ type: 'text', name: 't', text: 'Hi' }]);
    mount([a, t!]);
    fireEvent.click(screen.getByRole('radio', { name: 'Block' }));
    expect(doc.requireNode(a).styles.display).toBeUndefined();
    expect(doc.requireNode(t!).styles.display).toBeUndefined();
    fireEvent.click(screen.getByRole('radio', { name: 'Flex' }));
    expect(doc.requireNode(a).styles.display).toBe('flex');
    expect(doc.requireNode(t!).styles.display).toBeUndefined();
  });

  it('inline-flex frames show their flex controls', () => {
    const { doc, a, mount } = setup();
    doc.updateStyles(human, [{ nodeIds: [a], styles: { display: 'inline-flex' } }], undefined, { dialect: 'any' });
    mount([a]);
    expect(screen.getByRole('radio', { name: 'Flex' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByLabelText('Gap')).toBeTruthy();
  });

  it('a typed width ends Fill sizing and lifts a clamping max width', () => {
    const { doc, a, mount } = setup({ display: 'flex', flexDirection: 'row' });
    doc.updateStyles(human, [{ nodeIds: [a], styles: { flexGrow: 1, flexBasis: '0%', maxWidth: '100px' } }], undefined, { dialect: 'any' });
    mount([a]);
    const w = screen.getByLabelText('W') as HTMLInputElement;
    fireEvent.change(w, { target: { value: '300' } });
    fireEvent.keyDown(w, { key: 'Enter' });
    const s = doc.requireNode(a).styles;
    expect(s.width).toBe('300px');
    expect(s.flexGrow).toBeUndefined();
    expect(s.flexBasis).toBeUndefined();
    expect(s.maxWidth).toBeUndefined();
  });

  it('a background colour edit shows over a stored background shorthand', () => {
    const { doc, a, mount } = setup();
    doc.updateStyles(human, [{ nodeIds: [a], styles: { background: '#ffffff' } }], undefined, { dialect: 'any' });
    mount([a]);
    const bg = screen.getByLabelText('Background') as HTMLInputElement;
    expect(bg.value).toBe('#ffffff');
    fireEvent.change(bg, { target: { value: '#000000' } });
    fireEvent.keyDown(bg, { key: 'Enter' });
    const s = doc.requireNode(a).styles;
    expect(s.backgroundColor).toBe('#000000');
    expect(s.background).toBeUndefined();
  });

  it('text layers get a text shadow, without spread or inner shadow', () => {
    const { doc, artboard, mount } = setup();
    const [t] = doc.insertNodes(human, artboard, [{ type: 'text', name: 't', text: 'Hi' }]);
    mount([t!]);
    expect(screen.queryByRole('button', { name: 'Add inner shadow' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add shadow' }));
    const s = doc.requireNode(t!).styles;
    expect(s.textShadow).toBe('0px 4px 12px rgba(0, 0, 0, 0.25)');
    expect(s.boxShadow).toBeUndefined();
  });

  it('letter spacing gets px and a large bare line height is px', () => {
    const { doc, artboard, mount } = setup();
    const [t] = doc.insertNodes(human, artboard, [{ type: 'text', name: 't', text: 'Hi' }]);
    mount([t!]);
    for (const [label, typed] of [['Letter spacing', '2'], ['Line height', '24']] as const) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      fireEvent.change(input, { target: { value: typed } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    const s = doc.requireNode(t!).styles;
    expect(s.letterSpacing).toBe('2px');
    expect(s.lineHeight).toBe('24px');
  });

  it('a select shows a stored value its options do not name', () => {
    const { doc, a, mount } = setup();
    doc.updateStyles(human, [{ nodeIds: [a], styles: { justifyContent: 'start' } }], undefined, { dialect: 'any' });
    mount([a]);
    expect((screen.getByLabelText('Justify') as HTMLSelectElement).value).toBe('start');
  });

  it('artboards cannot be set to fill a container', () => {
    const { artboard, mount } = setup();
    mount([artboard]);
    const options = [...(screen.getByLabelText('Width sizing') as HTMLSelectElement).options].map((o) => o.value);
    expect(options).not.toContain('fill');
  });
  it('vector layers take an icon colour', () => {
    const { doc, artboard, mount } = setup();
    const [v] = doc.insertNodes(human, artboard, [{ type: 'svg', name: 'v', svg: '<svg viewBox="0 0 1 1"><path stroke="currentColor" d="M0 0L1 1"/></svg>' }]);
    mount([v!]);
    const color = screen.getByLabelText('Icon color') as HTMLInputElement;
    fireEvent.change(color, { target: { value: '#ff0000' } });
    fireEvent.keyDown(color, { key: 'Enter' });
    expect(doc.requireNode(v!).styles.color).toBe('#ff0000');
  });
});
