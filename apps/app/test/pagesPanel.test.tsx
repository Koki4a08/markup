import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { LayersPanel } from '../src/panels/LayersPanel';
import { SelectionProvider } from '../src/canvas/selection';
import { DocProvider } from '../src/store/DocProvider';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

function setup(pages = 2) {
  const doc = new MarkupDoc();
  for (let i = 1; i < pages; i++) doc.createPage(human);
  const first = doc.pages()[0]!.id;
  const onPage = vi.fn();
  const view = render(
    <DocProvider doc={doc} actor={human}>
      <SelectionProvider>
        <LayersPanel activePageId={first} onPage={onPage} renamingId={null} onRenameDone={() => undefined} collapseSignal={0} />
      </SelectionProvider>
    </DocProvider>,
  );
  const row = (name: string) => [...view.container.querySelectorAll<HTMLElement>('.page-row')].find((r) => r.textContent?.includes(name))!;
  return { doc, onPage, view, row };
}

const names = (doc: MarkupDoc) => doc.pages().flatMap((p) => (p.type === 'page' ? [p.name] : []));

describe('pages panel', () => {
  it('renames a page by double-click, Enter commits and Escape cancels', () => {
    const { doc, row } = setup();
    fireEvent.doubleClick(row('Page 1'));
    const input = row('').querySelector('input')!;
    fireEvent.change(input, { target: { value: 'Home' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(names(doc)).toEqual(['Home', 'Page 2']);

    fireEvent.keyDown(row('Page 2'), { key: 'F2' });
    const second = document.querySelector<HTMLInputElement>('.page-row input')!;
    fireEvent.change(second, { target: { value: 'Nope' } });
    fireEvent.keyDown(second, { key: 'Escape' });
    fireEvent.blur(second);
    expect(names(doc)).toEqual(['Home', 'Page 2']);
  });

  it('deletes from the context menu and moves off the deleted active page', () => {
    const { doc, onPage, row, view } = setup(3);
    const [, second] = doc.pages();
    fireEvent.contextMenu(row('Page 1'));
    const del = [...view.container.querySelectorAll<HTMLButtonElement>('.context-menu button')].find((b) => b.textContent === 'Delete')!;
    act(() => del.click());
    expect(names(doc)).toEqual(['Page 2', 'Page 3']);
    expect(onPage).toHaveBeenCalledWith(second!.id);
    expect(view.container.querySelector('.context-menu')).toBeNull();
  });

  it('deletes with the trash button but never the last page', () => {
    const { doc, row, view } = setup(2);
    act(() => row('Page 2').querySelector<HTMLButtonElement>('.icon-button')!.click());
    expect(names(doc)).toEqual(['Page 1']);
    expect(view.container.querySelector('.page-row .icon-button')).toBeNull();
    fireEvent.keyDown(row('Page 1'), { key: 'Delete' });
    expect(names(doc)).toEqual(['Page 1']);
  });
});
