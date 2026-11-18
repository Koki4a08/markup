import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';
import { NodeView } from '../src/canvas/NodeView';
import { DocProvider } from '../src/store/DocProvider';

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };

function setup() {
  const doc = new MarkupDoc();
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [artboard] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'Hero', styles: { display: 'flex', gap: '24px' } }]);
  const utils = render(
    <DocProvider doc={doc} actor={human}>
      <NodeView id={artboard!} />
    </DocProvider>,
  );
  return { doc, artboard: artboard!, ...utils };
}

describe('NodeView', () => {
  it('renders frame styles', () => {
    const { container, artboard } = setup();
    const el = container.querySelector(`[data-node-id="${artboard}"]`) as HTMLElement;
    expect(el.tagName).toBe('DIV');
    expect(el.style.gap).toBe('24px');
    expect(el.style.display).toBe('flex');
  });

  it('text html is sanitized', () => {
    const { container, doc, artboard } = setup();
    act(() => {
      doc.insertNodes(human, artboard, [{ type: 'text', text: 'Hi <b>there</b><script>alert(1)</script><img src=x onerror="alert(1)">' }]);
    });
    const p = container.querySelector('p')!;
    expect(p.innerHTML).toContain('<b>there</b>');
    expect(p.innerHTML).not.toContain('script');
    expect(p.innerHTML).not.toContain('onerror');
  });

  it('useNode re-renders on style change', () => {
    const { container, doc, artboard } = setup();
    act(() => {
      doc.updateStyles(human, [{ nodeIds: [artboard], styles: { gap: '8px' } }]);
    });
    const el = container.querySelector(`[data-node-id="${artboard}"]`) as HTMLElement;
    expect(el.style.gap).toBe('8px');
  });

  it('hidden nodes render display none', () => {
    const { container, doc, artboard } = setup();
    act(() => {
      doc.ydoc.transact(() => doc.yNode(artboard).set('hidden', true), human);
    });
    expect((container.querySelector(`[data-node-id="${artboard}"]`) as HTMLElement).style.display).toBe('none');
  });

  it('numeric px styles render with units', () => {
    const { container, doc, artboard } = setup();
    act(() => {
      doc.updateStyles(human, [{ nodeIds: [artboard], styles: { left: 120, opacity: 0.5 } }]);
    });
    const el = container.querySelector(`[data-node-id="${artboard}"]`) as HTMLElement;
    expect(el.style.left).toBe('120px');
    expect(el.style.opacity).toBe('0.5');
  });

  it('text renders without the browser default paragraph margin', () => {
    const { container, doc, artboard } = setup();
    act(() => {
      doc.insertNodes(human, artboard, [{ type: 'text', text: 'Hi' }]);
    });
    expect((container.querySelector('p') as HTMLElement).style.margin).toBe('0px');
  });
});
