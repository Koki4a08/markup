import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentReports, configPath, defaultServerCommand, detectAgent, entryProblem, findExecutable, install, readCodexEntry, readConfig, removeCodexTable, uninstall, upsertCodexTable, type InstallEnv, type RunResult } from '../src/install';
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

describe('new agents', () => {
  it('claude desktop, windsurf and gemini use mcpServers in their own files', () => {
    expect(configPath('claude-desktop', { ...env, platform: 'win32', appData: path.join(home, 'Roaming') })).toBe(path.join(home, 'Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(configPath('claude-desktop', { ...env, platform: 'darwin' })).toBe(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    for (const agent of ['claude-desktop', 'windsurf', 'gemini'] as const) {
      const file = configPath(agent, env);
      write(file, JSON.stringify({ theme: 'x', mcpServers: { other: { command: 'o', args: [] } } }));
      expect(install(agent, entry, env).ok).toBe(true);
      const json = JSON.parse(read(file));
      expect(json.theme).toBe('x');
      expect(json.mcpServers).toEqual({ other: { command: 'o', args: [] }, markup: { command: entry.command, args: ['mcp'] } });
    }
    expect(configPath('windsurf', env)).toBe(path.join(home, '.codeium', 'windsurf', 'mcp_config.json'));
    expect(configPath('gemini', env)).toBe(path.join(home, '.gemini', 'settings.json'));
  });
});

describe('markup uninstall', () => {
  it('removes only the markup entry from JSON configs, keeping a backup', () => {
    const file = path.join(home, '.cursor', 'mcp.json');
    write(file, JSON.stringify({ mcpServers: { other: { command: 'o' } }, theme: 'dark' }));
    install('cursor', entry, env);
    const installed = read(file);
    expect(uninstall('cursor', env)).toEqual({ ok: true, message: `Removed markup from Cursor (${file}).` });
    expect(JSON.parse(read(file))).toEqual({ mcpServers: { other: { command: 'o' } }, theme: 'dark' });
    expect(read(`${file}.bak`)).toBe(installed);
    expect(uninstall('cursor', env).message).toBe('markup was not set up in Cursor.');
    expect(uninstall('vscode', env).message).toBe('markup was not set up in VS Code.');
    expect(fs.existsSync(configPath('vscode', env))).toBe(false);
  });

  it('removes the codex table and its sub-tables, keeping the rest', () => {
    const text = 'model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.markup]\ncommand = "x"\nargs = ["mcp"]\n\n[mcp_servers.markup.env]\nA = "1"\n\n[profiles.p]\nmodel = "y"\n';
    expect(removeCodexTable(text)).toBe('model = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n\n[profiles.p]\nmodel = "y"\n');
    expect(removeCodexTable('[mcp_servers.markup]\ncommand = "x"\n')).toBe('');
    expect(removeCodexTable('a = 1\n')).toBe('a = 1\n');
    const file = configPath('codex', env);
    write(file, 'model = "o3"\n');
    install('codex', entry, env);
    expect(uninstall('codex', env).ok).toBe(true);
    expect(read(file)).toBe('model = "o3"\n');
  });

  it('claude code goes through claude mcp remove', () => {
    expect(uninstall('claude-code', env)).toEqual({ ok: true, message: 'Removed markup from Claude Code.' });
    expect(calls).toEqual([{ cmd: '/usr/bin/claude', args: ['mcp', 'remove', '--scope', 'user', 'markup'] }]);
    env.run = () => ({ status: 1, stdout: '', stderr: 'No MCP server found with name: markup' });
    expect(uninstall('claude-code', env).message).toBe('markup was not set up in Claude Code.');
  });
});

describe('markup status', () => {
  it('reads what each agent has configured', () => {
    expect(readConfig('cursor', env)).toEqual({ state: 'missing' });
    for (const agent of AGENTS.filter((a) => a !== 'claude-code')) {
      install(agent, entry, env);
      expect(readConfig(agent, env)).toEqual({ state: 'set', entry });
    }
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { markup: { type: 'stdio', command: '/bin/markup', args: ['mcp'], env: {} } } }));
    expect(readConfig('claude-code', env)).toEqual({ state: 'set', entry: { command: '/bin/markup', args: ['mcp'] } });
    write(configPath('cursor', env), '{ nope');
    expect(readConfig('cursor', env).state).toBe('unreadable');
  });

  it('reads a codex entry and ignores other tables', () => {
    expect(readCodexEntry('[mcp_servers.markup]\ncommand = "C:\\\\m.exe" # here\nargs = ["mcp"]\n[x]\ncommand = "no"\n')).toEqual({ command: 'C:\\m.exe', args: ['mcp'] });
    expect(readCodexEntry('[mcp_servers.other]\ncommand = "x"\n')).toBeNull();
  });

  it('flags entries whose binary or script is gone', () => {
    const exists = (p: string) => p === '/ok/markup' || p === '/ok/cli.js';
    expect(entryProblem({ command: '/ok/markup', args: ['mcp'] }, exists)).toBeNull();
    expect(entryProblem({ command: '/gone/markup', args: ['mcp'] }, exists)).toBe('points to a missing file: /gone/markup');
    expect(entryProblem({ command: 'node', args: ['/ok/cli.js', 'mcp'] }, exists)).toBeNull();
    expect(entryProblem({ command: 'node', args: ['/gone/cli.js', 'mcp'] }, exists)).toBe('points to a missing file: /gone/cli.js');
    expect(entryProblem({ command: 'npx', args: ['-y', 'x', 'mcp'] }, exists)).toBeNull();
    expect(entryProblem({ command: '', args: [] }, exists)).toBe('has no command');
  });

  it('detects agents by their folders or commands', () => {
    env.findExecutable = () => null;
    for (const agent of AGENTS) expect(detectAgent(agent, env)).toBeNull();
    fs.mkdirSync(path.join(home, '.cursor'));
    fs.mkdirSync(path.join(home, '.gemini'));
    expect(detectAgent('cursor', env)).toBe(path.join(home, '.cursor'));
    expect(detectAgent('gemini', env)).toBe(path.join(home, '.gemini'));
    env.findExecutable = (name) => (name === 'claude' || name === 'codex' ? `/bin/${name}` : null);
    expect(detectAgent('claude-code', env)).toBe('claude command');
    expect(detectAgent('codex', env)).toBe('codex command');
    expect(detectAgent('windsurf', env)).toBeNull();
  });

  it('follows CODEX_HOME for the codex config', () => {
    env.findExecutable = () => null;
    const codexHome = path.join(home, 'custom-codex');
    const custom = { ...env, codexHome };
    expect(configPath('codex', custom)).toBe(path.join(codexHome, 'config.toml'));
    expect(detectAgent('codex', custom)).toBeNull();
    fs.mkdirSync(codexHome);
    expect(detectAgent('codex', custom)).toBe(codexHome);
    expect(install('codex', entry, custom).ok).toBe(true);
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  });

  it('writes Claude Desktop from the Microsoft Store into its packaged folder', () => {
    const win = { ...env, platform: 'win32' as const, appData: path.join(home, 'Roaming'), localAppData: path.join(home, 'Local') };
    expect(configPath('claude-desktop', win)).toBe(path.join(home, 'Roaming', 'Claude', 'claude_desktop_config.json'));
    // A package folder without the redirected Claude folder is not used.
    fs.mkdirSync(path.join(home, 'Local', 'Packages', 'Claude_abc', 'LocalCache', 'Roaming'), { recursive: true });
    expect(configPath('claude-desktop', win)).toBe(path.join(home, 'Roaming', 'Claude', 'claude_desktop_config.json'));
    const packaged = path.join(home, 'Local', 'Packages', 'Claude_abc', 'LocalCache', 'Roaming', 'Claude');
    fs.mkdirSync(packaged);
    expect(configPath('claude-desktop', win)).toBe(path.join(packaged, 'claude_desktop_config.json'));
    expect(detectAgent('claude-desktop', win)).toBe(packaged);
  });

  it('reports each agent: found, config path and state', () => {
    env.findExecutable = () => null;
    write(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { markup: { command: '/gone/markup', args: ['mcp'] } } }));
    fs.mkdirSync(path.join(home, '.gemini'));
    const reports = agentReports(env, () => false);
    const cursor = reports.find((r) => r.agent === 'cursor');
    expect(cursor).toEqual({ agent: 'cursor', label: 'Cursor', found: path.join(home, '.cursor'), config: path.join(home, '.cursor', 'mcp.json'), state: 'set', command: '/gone/markup', problem: 'points to a missing file: /gone/markup' });
    expect(reports.find((r) => r.agent === 'gemini')).toMatchObject({ found: path.join(home, '.gemini'), state: 'missing' });
    expect(reports.find((r) => r.agent === 'windsurf')).toMatchObject({ found: null, state: 'missing' });
    expect(reports.map((r) => r.agent)).toEqual([...AGENTS]);
  });
});

describe('finding claude outside PATH', () => {
  const none: RunResult = { status: 1, stdout: '', stderr: '' };
  const lookup = (over: Partial<Parameters<typeof findExecutable>[1]>) => ({
    home: '/Users/kg',
    platform: 'darwin' as NodeJS.Platform,
    pathEnv: '/usr/bin:/bin:/usr/sbin:/sbin',
    env: {},
    isFile: () => false,
    run: () => none,
    ...over,
  });

  it('checks the usual install folders when an app started from Finder has a bare PATH', () => {
    const shell: string[][] = [];
    for (const dir of ['/Users/kg/.local/bin', '/Users/kg/.claude/local', '/opt/homebrew/bin', '/usr/local/bin']) {
      const found = findExecutable('claude', lookup({ isFile: (p) => p === `${dir}/claude`, run: (c, a) => (shell.push([c, ...a]), none) }));
      expect(found).toBe(`${dir}/claude`);
    }
    expect(shell).toEqual([]);
    // The npm global prefix.
    expect(findExecutable('claude', lookup({ env: { NPM_CONFIG_PREFIX: '/Users/kg/.npm-global' }, isFile: (p) => p === '/Users/kg/.npm-global/bin/claude' }))).toBe('/Users/kg/.npm-global/bin/claude');
  });

  it('asks the login shell as a last resort', () => {
    const calls: string[][] = [];
    const nvm = '/Users/kg/.nvm/versions/node/v24.1.0/bin/claude';
    const found = findExecutable('claude', lookup({ env: { SHELL: '/bin/zsh' }, isFile: (p) => p === nvm, run: (c, a) => (calls.push([c, ...a]), { status: 0, stdout: `${nvm}\n`, stderr: '' }) }));
    expect(found).toBe(nvm);
    expect(calls).toEqual([['/bin/zsh', '-lc', 'command -v claude']]);
    expect(findExecutable('claude', lookup({}))).toBeNull();
  });

  it('checks %APPDATA%/npm and %USERPROFILE%/.local/bin on Windows', () => {
    const w = (...parts: string[]) => path.win32.join('C:\\Users\\kg', ...parts);
    const win = { home: w(), platform: 'win32' as NodeJS.Platform, pathEnv: 'C:\\Windows\\System32', env: { PATHEXT: '.EXE;.CMD' }, run: () => none };
    const npmShim = w('AppData', 'Roaming', 'npm', 'claude.cmd');
    expect(findExecutable('claude', { ...win, appData: w('AppData', 'Roaming'), isFile: (p) => p === npmShim })).toBe(npmShim);
    const local = w('.local', 'bin', 'claude.exe');
    expect(findExecutable('claude', { ...win, isFile: (p) => p === local })).toBe(local);
    // PATH still wins.
    const onPath = path.win32.join('C:\\tools', 'claude.exe');
    expect(findExecutable('claude', { ...win, pathEnv: 'C:\\tools', isFile: (p) => p === onPath || p === local })).toBe(onPath);
  });
});
