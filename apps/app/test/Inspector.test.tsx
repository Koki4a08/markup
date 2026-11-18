import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { Inspector } from '../src/panels/Inspector';
import { SelectionProvider } from '../src/selection';
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

  it('mixed selection shows Mixed', () => {
    const { a, b, mount } = setup();
    mount([a, b]);
    const gap = screen.getByLabelText('Gap') as HTMLInputElement;
    expect(gap.value).toBe('');
    expect(gap.placeholder).toBe('Mixed');
  });

  it('unknown style appears in Other styles', () => {
    const { a, mount } = setup();
    mount([a]);
    expect((screen.getByLabelText('mixBlendMode') as HTMLInputElement).value).toBe('multiply');
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

  it('Other styles edits use the permissive dialect (a pasted margin can be edited)', () => {
    const { doc, a, mount } = setup();
    doc.updateStyles(human, [{ nodeIds: [a], styles: { marginTop: '4px' } }], undefined, { dialect: 'any' });
    mount([a]);
    const field = screen.getByLabelText('marginTop') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '12px' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(doc.requireNode(a).styles.marginTop).toBe('12px');
    fireEvent.change(screen.getByLabelText('New property'), { target: { value: 'margin-left' } });
    fireEvent.change(screen.getByLabelText('New value'), { target: { value: '8px' } });
    fireEvent.submit(screen.getByLabelText('New property').closest('form')!);
    expect(doc.requireNode(a).styles.marginLeft).toBe('8px');
  });

  it('shows an empty state with no selection', () => {
    const { mount } = setup();
    mount([]);
    expect(screen.getByText('Select a layer to edit its styles.')).toBeTruthy();
  });
});
