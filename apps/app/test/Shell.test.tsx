import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Shell } from '../src/App';
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
});
