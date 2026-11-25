import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const execute = vi.fn(async () => ({ code: 0, stdout: 'Added markup to Cursor (/home/u/.cursor/mcp.json).\n', stderr: '', signal: null }));
const sidecar = vi.fn((_program: string, _args: string[]) => ({ execute }));
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { sidecar } }));

const { McpPanel } = await import('../src/panels/McpPanel');

describe('McpPanel', () => {
  it('web build leads with the one-line installer, configs behind a toggle', () => {
    render(<McpPanel onClose={() => {}} desktop={false} />);
    expect(screen.queryByRole('button', { name: /^Add to/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy install command' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Windows' }));
    expect(screen.getByText('irm https://markup.here/install.ps1 | iex')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'macOS, Linux' }));
    expect(screen.getByText('curl -fsSL https://markup.here/install.sh | sh')).toBeTruthy();

    expect(screen.queryByText(/\[mcp_servers\.markup\]/)).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Edit a config by hand' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/\[mcp_servers\.markup\]/)).toBeTruthy();
    expect(screen.getByText(/claude mcp add --scope user markup -- .*\.markup.*markup/)).toBeTruthy();
    for (const name of ['Claude Code', 'Cursor', 'VS Code', 'Codex', 'OpenCode', 'Claude Desktop', 'Windsurf', 'Gemini CLI']) {
      expect(screen.getByRole('button', { name: `Copy ${name} setup` })).toBeTruthy();
    }
  });

  it('desktop runs the sidecar install and shows its output', async () => {
    render(<McpPanel onClose={() => {}} desktop />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add to Cursor' })));
    expect(sidecar).toHaveBeenCalledWith('binaries/markup', ['install', 'cursor']);
    expect(screen.getByRole('status').textContent).toBe('Added markup to Cursor (/home/u/.cursor/mcp.json).\nRestart Cursor so it loads Markup.');
    expect(screen.queryByRole('button', { name: 'Add to Cursor' })).toBeNull();
    expect(screen.getByText('Added')).toBeTruthy();
  });

  it('desktop shows a failed install as an error', async () => {
    execute.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'markup install: claude was not found on PATH.', signal: null });
    render(<McpPanel onClose={() => {}} desktop />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add to Claude Code' })));
    const status = screen.getByRole('status');
    expect(status.className).toContain('is-error');
    expect(status.textContent).toContain('claude was not found on PATH');
    expect(screen.getByRole('button', { name: 'Add to Claude Code' }).textContent).toBe('Try again');
  });

  it('Escape closes it', () => {
    const onClose = vi.fn();
    render(<McpPanel onClose={onClose} desktop={false} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
