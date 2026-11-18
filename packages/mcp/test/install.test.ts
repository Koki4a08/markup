import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, defaultServerCommand, install, upsertCodexTable, type InstallEnv, type RunResult } from '../src/install';
import { AGENTS, snippets } from '../src/snippets';

const entry = { command: 'C:\\Program Files\\Markup\\markup.exe', args: ['mcp'] };

let home: string;
let out: string[];
let calls: { cmd: string; args: string[] }[];
let env: InstallEnv;

const ok: RunResult = { status: 0, stdout: '', stderr: '' };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'markup-install-'));
  out = [];
  calls = [];
  env = {
    home,
    platform: 'linux',
    log: (s) => out.push(s),
    findExecutable: (name) => (name === 'claude' ? '/usr/bin/claude' : null),
    run: (cmd, args) => {
      calls.push({ cmd, args });
      return ok;
    },
  };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const read = (p: string) => fs.readFileSync(p, 'utf8');
const write = (p: string, text: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

describe('markup install', () => {
  it('cursor config merged with existing servers', () => {
    const file = path.join(home, '.cursor', 'mcp.json');
    write(file, JSON.stringify({ mcpServers: { other: { command: 'other', args: [] } }, theme: 'dark' }));
    expect(install('cursor', entry, env).ok).toBe(true);
    const json = JSON.parse(read(file));
    expect(json.theme).toBe('dark');
    expect(json.mcpServers.other).toEqual({ command: 'other', args: [] });
    expect(json.mcpServers.markup).toEqual({ command: entry.command, args: ['mcp'] });
  });

  it('creates missing config and parent dirs', () => {
    expect(install('opencode', entry, env).ok).toBe(true);
    const json = JSON.parse(read(path.join(home, '.config', 'opencode', 'opencode.json')));
    expect(json.mcp.markup).toEqual({ type: 'local', command: [entry.command, 'mcp'], enabled: true });
    expect(fs.existsSync(path.join(home, '.config', 'opencode', 'opencode.json.bak'))).toBe(false);
  });

  it('vscode uses servers key and stdio type', () => {
    for (const [platform, expected] of [
      ['linux', path.join(home, '.config', 'Code', 'User', 'mcp.json')],
      ['darwin', path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')],
      ['win32', path.join(home, 'Roaming', 'Code', 'User', 'mcp.json')],
    ] as const) {
      expect(configPath('vscode', { ...env, platform, appData: path.join(home, 'Roaming') })).toBe(expected);
    }
    const file = configPath('vscode', env);
    write(file, JSON.stringify({ servers: { gh: { type: 'http', url: 'https://x' } }, inputs: [] }));
    expect(install('vscode', entry, env).ok).toBe(true);
    const json = JSON.parse(read(file));
    expect(json.servers.gh).toEqual({ type: 'http', url: 'https://x' });
    expect(json.servers.markup).toEqual({ type: 'stdio', command: entry.command, args: ['mcp'] });
    expect(json.inputs).toEqual([]);
    expect(json.mcpServers).toBeUndefined();
  });

  it('codex toml appended once', () => {
    const file = path.join(home, '.codex', 'config.toml');
    write(file, 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n');
    expect(install('codex', entry, env).ok).toBe(true);
    expect(install('codex', { command: '/new/markup', args: ['mcp'] }, env).ok).toBe(true);
    const text = read(file);
    expect(text.match(/\[mcp_servers\.markup\]/g)).toHaveLength(1);
    expect(text).toContain('model = "o3"');
    expect(text).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(text).toContain('[mcp_servers.markup]\ncommand = "/new/markup"\nargs = ["mcp"]\n');
    expect(text).not.toContain('Program Files');
  });

  it('codex table is replaced in place, keeping what follows', () => {
    const before = 'a = 1\n[mcp_servers.markup]\ncommand = "old"\nargs = [\n  "x",\n]\nenv = { A = "1" }\n\n[mcp_servers.markup.env]\nB = "2"\n[profiles.x]\nmodel = "y"\n';
    const after = upsertCodexTable(before, entry);
    expect(after).toBe(
      'a = 1\n[mcp_servers.markup]\ncommand = "C:\\\\Program Files\\\\Markup\\\\markup.exe"\nargs = ["mcp"]\n\n[mcp_servers.markup.env]\nB = "2"\n[profiles.x]\nmodel = "y"\n',
    );
    expect(upsertCodexTable('', entry)).toBe('[mcp_servers.markup]\ncommand = "C:\\\\Program Files\\\\Markup\\\\markup.exe"\nargs = ["mcp"]\n');
    expect(upsertCodexTable('x = 1', entry)).toBe('x = 1\n\n[mcp_servers.markup]\ncommand = "C:\\\\Program Files\\\\Markup\\\\markup.exe"\nargs = ["mcp"]\n');
  });

  it('backup written before change', () => {
    const file = path.join(home, '.cursor', 'mcp.json');
    const original = '{ "mcpServers": { "markup": { "command": "old", "args": [] } } }';
    write(file, original);
    expect(install('cursor', entry, env).ok).toBe(true);
    expect(read(`${file}.bak`)).toBe(original);
    expect(JSON.parse(read(file)).mcpServers.markup.command).toBe(entry.command);
  });

  it('refuses to touch a config it cannot parse', () => {
    const file = path.join(home, '.cursor', 'mcp.json');
    write(file, '{ // comment\n "mcpServers": {} }');
    const result = install('cursor', entry, env);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(file);
    expect(read(file)).toBe('{ // comment\n "mcpServers": {} }');
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
  });

  it('claude code removes any user entry, then runs claude mcp add', () => {
    expect(install('claude-code', entry, env).ok).toBe(true);
    expect(calls).toEqual([
      { cmd: '/usr/bin/claude', args: ['mcp', 'remove', '--scope', 'user', 'markup'] },
      { cmd: '/usr/bin/claude', args: ['mcp', 'add', '--scope', 'user', 'markup', '--', entry.command, 'mcp'] },
    ]);
  });

  it('claude code adds even when there was no entry to remove, and reports a failed add', () => {
    env.run = (cmd, args) => {
      calls.push({ cmd, args });
      return args[1] === 'remove' ? { status: 1, stdout: '', stderr: 'No MCP server found' } : ok;
    };
    expect(install('claude-code', entry, env).ok).toBe(true);
    expect(calls.map((c) => c.args[1])).toEqual(['remove', 'add']);
    env.run = () => ({ status: 2, stdout: '', stderr: 'boom' });
    expect(install('claude-code', entry, env)).toEqual({ ok: false, message: 'claude mcp add failed (exit 2).\nboom' });
  });

  it('claude code without claude on PATH prints the command and fails', () => {
    env.findExecutable = () => null;
    const result = install('claude-code', entry, env);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('claude was not found on PATH');
    expect(result.message).toContain('claude mcp add --scope user markup -- "C:\\Program Files\\Markup\\markup.exe" mcp');
    expect(calls).toEqual([]);
  });

  it('print shows every agent', () => {
    expect(install('print', entry, env).ok).toBe(true);
    const text = out.join('\n');
    for (const agent of AGENTS) expect(text).toContain(snippets(entry)[agent].code);
    expect(text).toContain('claude mcp add --scope user markup --');
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('"servers"');
    expect(text).toContain('[mcp_servers.markup]');
    expect(text).toContain('"type": "local"');
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('default command is the binary when compiled, else node with cli.js', () => {
    expect(defaultServerCommand('C:\\Program Files\\Markup\\markup.exe', '/x/dist/cli.js')).toEqual({ command: 'C:\\Program Files\\Markup\\markup.exe', args: ['mcp'] });
    expect(defaultServerCommand('/app/markup-x86_64-unknown-linux-gnu', '/x/dist/cli.js')).toEqual({ command: '/app/markup-x86_64-unknown-linux-gnu', args: ['mcp'] });
    expect(defaultServerCommand('/usr/bin/node', 'dist/cli.js')).toEqual({ command: 'node', args: [path.resolve('dist/cli.js'), 'mcp'] });
  });
});
