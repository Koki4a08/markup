import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LOCAL_USER, Shell } from '../src/App';
import { isMacPlatform } from '../src/keyboard';
import { Surfaces, WorkspaceProvider } from '../src/workspace/WorkspaceProvider';
import { memoryWorkspace } from './memoryWorkspace';

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

describe('shell', () => {
  it('open_file on the file already in front brings its editor back from the dashboard', async () => {
    const { workspace, addFile } = memoryWorkspace();
    const id = addFile('Landing');
    await workspace.open(id);
    const prev = globalThis.WebSocket;
    globalThis.WebSocket = NoSocket as unknown as typeof WebSocket;
    try {
      const { container } = render(
        <WorkspaceProvider workspace={workspace} surfaces={new Surfaces()}>
          <Shell />
        </WorkspaceProvider>,
      );
      expect(container.querySelector('.editor')).not.toBeNull();
      act(() => screen.getByTitle(/^Files/).click());
      expect(container.querySelector('.dashboard')).not.toBeNull();
      // What resourceTools' open_file does for an agent.
      await act(async () => {
        await workspace.open(id);
      });
      expect(container.querySelector('.dashboard')).toBeNull();
      expect(container.querySelector('.editor')).not.toBeNull();
    } finally {
      globalThis.WebSocket = prev;
    }
  });

  it('undo history, viewport and selection survive switching tabs and the dashboard', async () => {
    const { workspace, addFile } = memoryWorkspace();
    const a = addFile('A');
    const b = addFile('B');
    const docA = await workspace.open(a);
    await workspace.open(b);
    await act(async () => {
      await workspace.open(a);
    });
    const prev = globalThis.WebSocket;
    globalThis.WebSocket = NoSocket as unknown as typeof WebSocket;
    try {
      const { container } = render(
        <WorkspaceProvider workspace={workspace} surfaces={new Surfaces()}>
          <Shell />
        </WorkspaceProvider>,
      );
      const page = docA.pages()[0]!;
      if (page.type !== 'page') throw new Error('unreachable');
      let card = '';
      act(() => {
        card = docA.insertNodes(LOCAL_USER, page.rootId, [{ type: 'frame', name: 'Card', styles: { position: 'absolute', left: 0, top: 0, width: 10, height: 10 } }])[0]!;
      });
      act(() => {
        container.querySelector('.canvas')!.dispatchEvent(new WheelEvent('wheel', { deltaX: 30, deltaY: 40, bubbles: true, cancelable: true }));
      });
      const transform = () => (container.querySelector('.canvas-world') as HTMLElement).style.transform;
      const moved = transform();
      expect(moved).toContain('translate(50px, 40px)');
      act(() => (container.querySelector('.layer-row') as HTMLElement).click());
      expect(container.querySelector('.layer-row.is-selected')).not.toBeNull();

      // To tab B, to the dashboard, and back to A.
      act(() => workspace.activate(b));
      expect(transform()).not.toBe(moved);
      act(() => screen.getByTitle(/^Files/).click());
      expect(container.querySelector('.dashboard')).not.toBeNull();
      await act(async () => {
        await workspace.open(a);
      });
      expect(transform()).toBe(moved);
      expect(container.querySelector('.layer-row.is-selected')).not.toBeNull();
      act(() => {
        fireEvent.keyDown(window, { code: 'KeyZ', key: 'z', ctrlKey: !isMacPlatform(), metaKey: isMacPlatform() });
      });
      expect(docA.getNode(card)).toBeUndefined();

      // Closing the tab drops its state; reopening starts fresh.
      act(() => workspace.close(a));
      await act(async () => {
        await workspace.open(a);
      });
      expect(transform()).not.toBe(moved);
    } finally {
      globalThis.WebSocket = prev;
    }
  });
});
