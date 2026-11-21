import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActorUndo, MarkupDoc, type Actor } from '@markup/doc';
import { CopyMenu } from '../src/export/CopyMenu';
import { DocProvider } from '../src/store/DocProvider';
import { SelectionProvider, useSelection } from '../src/canvas/selection';
import { runCommand, type CommandContext } from '../src/commands/commands';
import { setCopiedStyles } from '../src/canvas/canvasOps';
import type { Command } from '../src/commands/keyboard';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

const LABELS = [
  'Select layer…',
  'Select children',
  'Select parent',
  'Deselect',
  'Copy',
  'Copy link',
  'Copy as…',
  'Paste',
  'Paste on top',
  'Paste to replace',
  'Duplicate',
  'Copy styles',
  'Paste styles',
  'Rename',
  'Frame selection',
  'Remove flex',
  'Ungroup',
  'Bring to front',
  'Send to back',
  'Move forward',
  'Move backward',
  'Show / hide',
  'Lock / unlock',
  'Set as thumbnail',
];

beforeEach(() => setCopiedStyles(null));
afterEach(() => {
  document.body.innerHTML = '';
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
});

function setup() {
  const doc = new MarkupDoc({ name: 'Landing' });
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'Artboard', styles: { display: 'flex', width: '400px', height: '300px' } }]);
  const [card, title] = doc.insertNodes(human, artboard!, [
    { type: 'frame', name: 'Card', styles: { width: '100px' } },
    { type: 'text', name: 'Title', text: 'Hi' },
  ]);
  const [label] = doc.insertNodes(human, card!, [{ type: 'text', name: 'Label', text: 'Go' }]);
  return { doc, rootId: page.rootId, artboard: artboard!, card: card!, title: title!, label: label! };
}

function mount(doc: MarkupDoc, rootId: string, initial: string[], opts: { onPick?: (c: Command) => void } = {}) {
  const onClose = vi.fn();
  let selection: ReturnType<typeof useSelection> | null = null;
  const Probe = () => {
    selection = useSelection();
    return null;
  };
  const picks: Command[] = [];
  const ctx = (): CommandContext => ({
    doc,
    actor: human,
    undo: new ActorUndo(doc, human),
    rootId,
    getSelection: () => selection!.get(),
    setSelection: (ids) => selection!.set(ids),
    setTool() {},
    zoomToFit() {},
    zoomTo() {},
    startRename() {},
    collapseLayers() {},
  });
  const onPick = opts.onPick ?? ((c: Command) => (picks.push(c), runCommand(c, ctx())));
  const view = render(
    <DocProvider doc={doc} actor={human}>
      <SelectionProvider initial={initial}>
        <Probe />
        <CopyMenu at={{ x: 50, y: 60 }} onClose={onClose} onPick={onPick} />
      </SelectionProvider>
    </DocProvider>,
  );
  return { onClose, picks, view, selection: () => selection!.get() };
}

const rootMenu = () => screen.getAllByRole('menu')[0]!;
const item = (label: string, menu = rootMenu()) => within(menu).getAllByRole<HTMLButtonElement>('menuitem').find((b) => b.querySelector('.canvas-menu-label')?.textContent === label)!;

/** A rendered canvas: nested [data-node-id] elements inside .canvas-world, all under the click point. */
function canvasAt(ids: string[]) {
  const world = document.createElement('div');
  world.className = 'canvas-world';
  document.body.appendChild(world);
  let parent: HTMLElement = world;
  const els = ids.map((id) => {
    const el = document.createElement('div');
    el.setAttribute('data-node-id', id);
    parent.appendChild(el);
    parent = el;
    return el;
  });
  // Topmost first, as the browser returns them.
  (document as { elementsFromPoint?: unknown }).elementsFromPoint = vi.fn((): Element[] => [...[...els].reverse(), world, document.body]);
}

describe('canvas context menu', () => {
  it('lists every entry in order, grouped, with platform shortcuts', () => {
    const { doc, rootId, card } = setup();
    mount(doc, rootId, [card]);
    const labels = within(rootMenu())
      .getAllByRole('menuitem')
      .map((b) => b.querySelector('.canvas-menu-label')?.textContent);
    expect(labels).toEqual(LABELS);
    expect(within(rootMenu()).getAllByRole('separator')).toHaveLength(7);
    expect(item('Copy').querySelector('kbd')?.textContent).toBe('Ctrl+C');
    expect(item('Paste').querySelector('kbd')?.textContent).toBe('Ctrl+V');
    expect(item('Copy styles').querySelector('kbd')?.textContent).toBe('Ctrl+Alt+C');
    expect(item('Bring to front').querySelector('kbd')?.textContent).toBe(']');
    expect(item('Deselect').querySelector('kbd')?.textContent).toBe('Shift+Esc');
  });

  it('disables selection entries without a selection', () => {
    const { doc, rootId } = setup();
    mount(doc, rootId, []);
    expect(item('Copy').disabled).toBe(true);
    expect(item('Duplicate').disabled).toBe(true);
    expect(item('Copy link').disabled).toBe(false);
    expect(item('Paste').disabled).toBe(false);
  });

  it('enables Paste styles once styles were copied', () => {
    const { doc, rootId, card } = setup();
    const first = mount(doc, rootId, [card]);
    expect(item('Paste styles').disabled).toBe(true);
    fireEvent.click(item('Copy styles'));
    expect(first.picks).toEqual(['copyStyles']);
    expect(first.onClose).toHaveBeenCalled();
    first.view.unmount();
    mount(doc, rootId, [card]);
    expect(item('Paste styles').disabled).toBe(false);
  });

  it('enables Remove flex only for a flex frame and Ungroup only for a frame with children', () => {
    const { doc, rootId, card, artboard, title } = setup();
    const one = mount(doc, rootId, [card]);
    expect(item('Remove flex').disabled).toBe(true);
    expect(item('Ungroup').disabled).toBe(false);
    one.view.unmount();
    const two = mount(doc, rootId, [artboard]);
    expect(item('Remove flex').disabled).toBe(false);
    two.view.unmount();
    mount(doc, rootId, [title]);
    expect(item('Ungroup').disabled).toBe(true);
  });

  it('Copy as SVG is only enabled for svg layers', () => {
    const { doc, rootId, card } = setup();
    mount(doc, rootId, [card]);
    fireEvent.mouseEnter(item('Copy as…'));
    const sub = screen.getAllByRole('menu')[1]!;
    expect(within(sub).getAllByRole('menuitem').map((b) => b.querySelector('.canvas-menu-label')?.textContent)).toEqual([
      'Copy as React',
      'Copy as Tailwind',
      'Copy as HTML',
      'Copy as PNG',
      'Copy as SVG',
    ]);
    expect(item('Copy as SVG', sub).disabled).toBe(true);
    expect(item('Copy as PNG', sub).querySelector('kbd')?.textContent).toBe('Ctrl+Shift+C');
  });

  it('Select layer lists the layers under the point, deepest first, and selects the one clicked', () => {
    const { doc, rootId, artboard, card, label } = setup();
    canvasAt([artboard, card, label]);
    const m = mount(doc, rootId, [label]);
    fireEvent.mouseEnter(item('Select layer…'));
    const sub = screen.getAllByRole('menu')[1]!;
    const rows = within(sub).getAllByRole('menuitem');
    expect(rows.map((b) => b.querySelector('.canvas-menu-label')?.textContent)).toEqual(['Label', 'Card', 'Artboard']);
    expect(rows.map((b) => b.getAttribute('data-depth'))).toEqual(['2', '1', '0']);
    fireEvent.click(item('Artboard', sub));
    expect(m.selection()).toEqual([artboard]);
    expect(m.onClose).toHaveBeenCalled();
  });

  it('right-clicking a layer outside the selection selects it', () => {
    const { doc, rootId, artboard, card, title } = setup();
    canvasAt([artboard, card]);
    const m = mount(doc, rootId, [title]);
    expect(m.selection()).toEqual([card]);
  });

  it('keeps a selection that already holds the layer', () => {
    const { doc, rootId, artboard, card, title } = setup();
    canvasAt([artboard, card]);
    const m = mount(doc, rootId, [title, card]);
    expect(m.selection()).toEqual([title, card]);
  });

  it('Escape closes the menu', () => {
    const { doc, rootId, card } = setup();
    const m = mount(doc, rootId, [card]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(m.onClose).toHaveBeenCalledTimes(1);
  });

  it('arrow keys move focus, open and close submenus; Enter activates', () => {
    const { doc, rootId, card } = setup();
    const onPick = vi.fn();
    const m = mount(doc, rootId, [card], { onPick });
    // Select layer… is disabled here (nothing under the point), so focus starts on Select children.
    expect(document.activeElement).toBe(item('Select children'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(item('Copy as…'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    const sub = screen.getAllByRole('menu')[1]!;
    expect(document.activeElement).toBe(item('Copy as React', sub));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(document.activeElement).toBe(item('Copy as…'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('copyTailwind');
    expect(m.onClose).toHaveBeenCalled();
  });

  it('Escape in a submenu closes only the submenu', () => {
    const { doc, rootId, card } = setup();
    const m = mount(doc, rootId, [card]);
    act(() => item('Copy as…').focus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(m.onClose).not.toHaveBeenCalled();
  });

  it('closes on an outside click', () => {
    const { doc, rootId, card } = setup();
    const m = mount(doc, rootId, [card]);
    fireEvent.pointerDown(document.body);
    expect(m.onClose).toHaveBeenCalled();
  });
});
