import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { code: number; stdout: string; stderr: string; signal: null };
const report = (over: Record<string, unknown>[] = []) => ({
  home: '/home/u',
  command: { command: '/opt/markup/markup', args: ['mcp'] },
  agents: [
    { agent: 'claude-code', label: 'Claude Code', found: 'claude command', config: '/home/u/.claude.json', state: 'missing' },
    { agent: 'cursor', label: 'Cursor', found: '/home/u/.cursor', config: '/home/u/.cursor/mcp.json', state: 'missing' },
    { agent: 'vscode', label: 'VS Code', found: null, config: '/home/u/.config/Code/User/mcp.json', state: 'missing' },
    { agent: 'codex', label: 'Codex', found: '/home/u/.codex', config: '/home/u/.codex/config.toml', state: 'set', command: '/opt/markup/markup' },
    { agent: 'opencode', label: 'OpenCode', found: null, config: '/home/u/.config/opencode/opencode.json', state: 'missing' },
    { agent: 'claude-desktop', label: 'Claude Desktop', found: null, config: '/home/u/.config/Claude/claude_desktop_config.json', state: 'missing' },
    { agent: 'windsurf', label: 'Windsurf', found: '/home/u/.codeium/windsurf', config: '/home/u/.codeium/windsurf/mcp_config.json', state: 'set', command: '/gone/markup', problem: 'points to a missing file: /gone/markup' },
    { agent: 'gemini', label: 'Gemini CLI', found: null, config: '/home/u/.gemini/settings.json', state: 'missing' },
  ].map((a) => ({ ...a, ...over.find((o) => o.agent === a.agent) })),
});
const ok = (stdout: string): Result => ({ code: 0, stdout, stderr: '', signal: null });
let scan: () => Result;
const install = vi.fn(async (): Promise<Result> => ok('Added markup to Cursor (/home/u/.cursor/mcp.json).\n'));
const sidecar = vi.fn((_program: string, args: string[]) => ({ execute: args[0] === 'agents' ? async () => scan() : install }));
beforeEach(() => {
  scan = () => ok(JSON.stringify(report()));
});
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

  it('desktop lists only the agents found on this computer, with their real config paths', async () => {
    await act(async () => void render(<McpPanel onClose={() => {}} desktop />));
    expect(sidecar).toHaveBeenCalledWith('binaries/markup', ['agents', '--json']);
    const names = screen.getAllByRole('listitem').map((li) => li.querySelector('.mcp-agent-name')?.textContent).filter(Boolean);
    expect(names).toEqual(['Claude Code', 'Cursor', 'Codex', 'Windsurf']);
    expect(screen.getByText('~/.cursor/mcp.json')).toBeTruthy();
    expect(screen.getByText('claude mcp, user scope')).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add to Codex' })).toBeNull();
    expect(screen.getByText('points to a missing file: /gone/markup')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add to Windsurf' }).textContent).toBe('Repair');
    expect(screen.queryByRole('button', { name: 'Add to VS Code' })).toBeNull();
    expect(screen.getByText('Not found on this computer: VS Code, OpenCode, Claude Desktop, Gemini CLI.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit a config by hand' }));
    expect(screen.getByText(/claude mcp add --scope user markup -- \/opt\/markup\/markup mcp/)).toBeTruthy();
    expect(screen.queryByText(/Replace “you”/)).toBeNull();
  });

  it('desktop says so when no agent is installed', async () => {
    scan = () => ok(JSON.stringify(report(['claude-code', 'cursor', 'codex', 'windsurf'].map((agent) => ({ agent, found: null })))));
    await act(async () => void render(<McpPanel onClose={() => {}} desktop />));
    expect(screen.getByText(/No coding agents found on this computer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Add to/ })).toBeNull();
  });

  it('desktop runs the sidecar install and shows its output', async () => {
    await act(async () => void render(<McpPanel onClose={() => {}} desktop />));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add to Cursor' })));
    expect(sidecar).toHaveBeenCalledWith('binaries/markup', ['install', 'cursor']);
    expect(screen.getByRole('status').textContent).toBe('Added markup to Cursor (/home/u/.cursor/mcp.json).\nRestart Cursor so it loads Markup.');
    expect(screen.queryByRole('button', { name: 'Add to Cursor' })).toBeNull();
    expect(screen.getByText('Added')).toBeTruthy();
  });

  it('desktop shows a failed install as an error', async () => {
    install.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'markup install: claude was not found on PATH.', signal: null });
    await act(async () => void render(<McpPanel onClose={() => {}} desktop />));
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
