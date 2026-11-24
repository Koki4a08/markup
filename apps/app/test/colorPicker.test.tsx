import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { Inspector } from '../src/panels/Inspector';
import { SelectionProvider } from '../src/canvas/selection';
import { DocProvider } from '../src/store/DocProvider';
import { convertSpace, cssStrings, fromOklch, parsePicked, toCss, toOklch } from '../src/panels/colorSpace';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

describe('colour space maths', () => {
  it('round-trips sRGB hex through the picker model', () => {
    for (const hex of ['#0d0d0d', '#ff0000', '#3b82f6', '#ffffff', '#000000']) expect(toCss(parsePicked(hex)!)).toBe(hex);
    expect(toCss(parsePicked('rgba(33, 28, 23, 0.12)')!)).toBe('rgba(33, 28, 23, 0.12)');
  });

  it('keeps Display P3 channels and writes color(display-p3 …)', () => {
    const p = parsePicked('color(display-p3 1 0 0 / 0.5)')!;
    expect(p.space).toBe('display-p3');
    expect(toCss(p)).toBe('color(display-p3 1 0 0 / 0.5)');
    // sRGB red sits inside P3; P3 red clamps back to sRGB red.
    expect(toCss(convertSpace(parsePicked('#ff0000')!, 'display-p3'))).toBe('color(display-p3 0.9175 0.2003 0.1386)');
    expect(toCss(convertSpace(parsePicked('color(display-p3 1 0 0)')!, 'srgb'))).toBe('#ff0000');
  });

  it('shows OKLCH like CSS does and edits through it', () => {
    const o = toOklch(parsePicked('#0d0d0d')!);
    expect(Math.round(o.l * 1000) / 10).toBe(15.9);
    expect(o.c).toBe(0);
    expect(cssStrings(parsePicked('#0d0d0d')!).oklch).toBe('oklch(15.9% 0 0)');
    const red = toOklch(parsePicked('#ff0000')!);
    expect(toCss(fromOklch('srgb', red.l, red.c, red.h, 1))).toBe('#ff0000');
  });

  it('copies each row as CSS, with alpha', () => {
    const s = cssStrings(parsePicked('rgba(255, 0, 0, 0.5)')!);
    expect(s.rgb).toBe('rgb(255 0 0 / 50%)');
    expect(s.hsl).toBe('hsl(0 100% 50% / 50%)');
    expect(s.hex).toBe('#FF000080');
  });
});

describe('ColorPicker in the inspector', () => {
  function setup() {
    const doc = new MarkupDoc();
    const page = doc.pages()[0]!;
    if (page.type !== 'page') throw new Error('unreachable');
    const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'A', styles: { display: 'flex' } }]);
    const [a] = doc.insertNodes(human, artboard!, [{ type: 'frame', name: 'a', styles: { backgroundColor: '#0d0d0d' } }]);
    render(
      <div className="app-shell">
        <DocProvider doc={doc} actor={human}>
          <SelectionProvider initial={[a!]}>
            <Inspector />
          </SelectionProvider>
        </DocProvider>
      </div>,
    );
    return { doc, a: a! };
  }

  it('opens from the swatch, commits a typed value once, and closes on Escape', () => {
    const { doc, a } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Background picker' }));
    const dialog = screen.getByRole('dialog', { name: 'Background colour' });
    expect((screen.getByLabelText('Hex') as HTMLInputElement).value).toBe('0D0D0D');
    expect((screen.getByLabelText('OKLCH L') as HTMLInputElement).value).toBe('15.9');
    expect(screen.getByRole('tab', { name: 'sRGB' }).getAttribute('aria-selected')).toBe('true');

    const before = doc.log().length;
    const red = screen.getByLabelText('RGB R') as HTMLInputElement;
    fireEvent.change(red, { target: { value: '255' } });
    fireEvent.keyDown(red, { key: 'Enter' });
    expect(doc.requireNode(a).styles.backgroundColor).toBe('#ff0d0d');
    expect(doc.log()).toHaveLength(before + 1);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Background colour' })).toBeNull();
  });

  it('switches to Display P3 and changes opacity', () => {
    const { doc, a } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Background picker' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Display P3' }));
    expect(doc.requireNode(a).styles.backgroundColor).toMatch(/^color\(display-p3 /);
    const opacity = screen.getByLabelText('Alpha value') as HTMLInputElement;
    fireEvent.change(opacity, { target: { value: '50' } });
    fireEvent.keyDown(opacity, { key: 'Enter' });
    expect(doc.requireNode(a).styles.backgroundColor).toMatch(/ \/ 0\.5\)$/);
  });

  it('restores the previous colour', () => {
    const { doc, a } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Background picker' }));
    const hex = screen.getByLabelText('Hex') as HTMLInputElement;
    fireEvent.change(hex, { target: { value: '3b82f6' } });
    fireEvent.keyDown(hex, { key: 'Enter' });
    expect(doc.requireNode(a).styles.backgroundColor).toBe('#3b82f6');
    fireEvent.click(screen.getByRole('button', { name: 'Restore the previous colour' }));
    expect(doc.requireNode(a).styles.backgroundColor).toBe('#0d0d0d');
  });
});
