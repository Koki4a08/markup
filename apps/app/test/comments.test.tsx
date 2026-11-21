import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, MarkupDoc } from '@markup/doc';
import { Editor } from '../src/editor/Editor';
import { CommentsPanel } from '../src/comments/CommentsPanel';
import { DEFAULT_FILTER, type CommentFilter } from '../src/comments/state';
import { resolveShortcut } from '../src/commands/keyboard';
import { DocProvider } from '../src/store/DocProvider';
import { Surfaces, WorkspaceProvider } from '../src/workspace/WorkspaceProvider';
import { memoryWorkspace } from './memoryWorkspace';

const me: Actor = { id: 'local-user', kind: 'human', name: 'You' };
const agent: Actor = { id: 'agent-1', kind: 'agent', name: 'Claude' };

class NoSocket {
  readyState = 0;
  OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {}
}

const pageOf = (doc: MarkupDoc) => {
  const p = doc.pages().find((x) => x.type === 'page');
  if (!p || p.type !== 'page') throw new Error('no page');
  return p;
};

async function mountEditor() {
  const { workspace, addFile } = memoryWorkspace();
  const doc = await workspace.open(addFile('Doc'));
  const page = pageOf(doc);
  const [artboard] = doc.insertNodes(me, page.rootId, [{ type: 'frame', name: 'Artboard', styles: { position: 'absolute', left: 0, top: 0, width: '400px', height: '300px' } }]);
  const view = render(
    <WorkspaceProvider workspace={workspace} surfaces={new Surfaces()}>
      <DocProvider doc={doc} actor={me}>
        <Editor />
      </DocProvider>
    </WorkspaceProvider>,
  );
  return { doc, page, artboard: artboard!, ...view };
}

let prevSocket: typeof WebSocket;
let rectSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  prevSocket = globalThis.WebSocket;
  globalThis.WebSocket = NoSocket as unknown as typeof WebSocket;
  // jsdom has no layout: every element measures as the same 1000x1000 box at the origin.
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 1000, width: 1000, height: 1000, toJSON: () => ({}) });
});
afterEach(() => {
  globalThis.WebSocket = prevSocket;
  rectSpy.mockRestore();
});

function placeComment(container: HTMLElement) {
  const canvas = container.querySelector('.canvas')!;
  const ev = new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 100, button: 0 });
  act(() => {
    canvas.dispatchEvent(ev);
  });
}

describe('comments', () => {
  it('C selects the comment tool', async () => {
    expect(resolveShortcut({ key: 'c', code: 'KeyC', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, false)).toBe('tool:comment');
    await mountEditor();
    expect(screen.getByRole('button', { name: /^Comment/ }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC' });
    expect(screen.getByRole('button', { name: /^Comment/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('posting creates a thread at the node', async () => {
    const { doc, artboard, container } = await mountEditor();
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC' });
    placeComment(container);
    const box = screen.getByLabelText('Add a comment') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'line one' } });
    // Shift+Enter is a newline, not a send.
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(doc.threads()).toHaveLength(0);
    fireEvent.keyDown(box, { key: 'Enter' });
    const [thread] = doc.threads();
    expect(thread).toMatchObject({ nodeId: artboard, status: 'open', x: 200, y: 200 });
    expect(thread!.messages[0]).toMatchObject({ body: 'line one', authorId: 'local-user' });
    expect(screen.getByRole('button', { name: 'Comment thread 1' })).toBeTruthy();
  });

  it('resolve hides the pin', async () => {
    const { doc, container } = await mountEditor();
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC' });
    placeComment(container);
    const box = screen.getByLabelText('Add a comment');
    fireEvent.change(box, { target: { value: 'fix this' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(doc.threads()[0]!.status).toBe('resolved');
    expect(screen.queryByRole('button', { name: 'Comment thread 1' })).toBeNull();
  });

  it('Enter on a focused popover button activates it and runs no canvas command', async () => {
    const { doc, container } = await mountEditor();
    fireEvent.keyDown(window, { key: 'c', code: 'KeyC' });
    placeComment(container);
    const box = screen.getByLabelText('Add a comment');
    fireEvent.change(box, { target: { value: 'fix this' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const resolve = screen.getByRole('button', { name: 'Resolve' });
    resolve.focus();
    // Not default-prevented, so the browser still turns Enter into a click.
    expect(fireEvent.keyDown(resolve, { key: 'Enter', code: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(resolve, { key: 'Backspace', code: 'Backspace' })).toBe(true);
    expect(fireEvent.keyDown(resolve, { key: 'v', code: 'KeyV' })).toBe(true);
    fireEvent.click(resolve);
    expect(doc.threads()[0]!.status).toBe('resolved');
  });

  it('a focused toolbar button still passes tool letters and modifier chords through', async () => {
    await mountEditor();
    const frame = screen.getByRole('button', { name: /^Frame/ });
    fireEvent.click(frame);
    frame.focus();
    expect(frame.getAttribute('aria-pressed')).toBe('true');
    // Enter and Delete stay with the button; V and Ctrl+Z reach the canvas.
    expect(fireEvent.keyDown(frame, { key: 'Enter', code: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(frame, { key: 'Delete', code: 'Delete' })).toBe(true);
    expect(fireEvent.keyDown(frame, { key: 'z', code: 'KeyZ', ctrlKey: true })).toBe(false);
    expect(fireEvent.keyDown(frame, { key: 'v', code: 'KeyV' })).toBe(false);
    expect(screen.getByRole('button', { name: /^Move/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('Backspace on a focused panel button does not reach the canvas', async () => {
    await mountEditor();
    const tab = screen.getByRole('tab', { name: /^Comments/ });
    tab.focus();
    expect(fireEvent.keyDown(tab, { key: 'Backspace', code: 'Backspace' })).toBe(true);
    expect(fireEvent.keyDown(tab, { key: 'Enter', code: 'Enter' })).toBe(true);
    // Outside any control the shortcut still applies.
    expect(fireEvent.keyDown(window, { key: 'Backspace', code: 'Backspace' })).toBe(false);
  });

  describe('panel', () => {

    async function panelSetup() {
      const { workspace, addFile } = memoryWorkspace();
      const doc = await workspace.open(addFile('Doc'));
      const page = pageOf(doc);
      const [artboard] = doc.insertNodes(me, page.rootId, [{ type: 'frame', name: 'A' }]);
      const a = doc.createThread(agent, { pageId: page.id, nodeId: artboard!, x: 1, y: 1, body: 'The headline is too tight' });
      const b = doc.createThread(agent, { pageId: page.id, nodeId: artboard!, x: 2, y: 2, body: 'Swap the hero image' });
      const selected: string[] = [];
      function Harness() {
        const [filter, setFilter] = useState<CommentFilter>(DEFAULT_FILTER);
        return (
          <DocProvider doc={doc} actor={me}>
            <CommentsPanel activePageId={page.id} filter={filter} onFilter={setFilter} selectedId={null} onSelect={(id) => selected.push(id)} />
          </DocProvider>
        );
      }
      render(<Harness />);
      return { doc, a, b, selected };
    }

    it('panel search filters threads', async () => {
      await panelSetup();
      const list = () => screen.getByRole('list', { name: 'Comment threads' });
      expect(within(list()).getAllByRole('listitem')).toHaveLength(2);
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search comments' }), { target: { value: 'hero' } });
      const items = within(list()).getAllByRole('listitem');
      expect(items).toHaveLength(1);
      expect(items[0]!.textContent).toContain('Swap the hero image');
    });

    it('unread dot clears when opened', async () => {
      const { a, selected } = await panelSetup();
      expect(screen.getAllByLabelText('Unread')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: /The headline is too tight/ }));
      expect(selected).toEqual([a]);
      expect(screen.getAllByLabelText('Unread')).toHaveLength(1);
    });
  });
});
