import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_LABELS, AGENTS, claudeAddArgs, claudeAddLine, codexTable, jsonEntry, jsonKey, SERVER_NAME, snippets, type Agent, type JsonAgent, type ServerCommand } from './snippets';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Everything `install` touches on the machine, injectable so tests use a temp dir and never run real commands. */
export interface InstallEnv {
  home: string;
  platform: NodeJS.Platform;
  /** Windows %APPDATA%; defaults to <home>/AppData/Roaming. */
  appData?: string;
  log(line: string): void;
  findExecutable(name: string): string | null;
  run(command: string, args: string[]): RunResult;
}

export interface InstallResult {
  ok: boolean;
  message: string;
}

/** Where the agent keeps its MCP servers. Claude Code's file is only read: changes go through `claude mcp`. */
export function configPath(agent: Agent, env: Pick<InstallEnv, 'home' | 'platform' | 'appData'>): string {
  const { home } = env;
  const appData = env.appData ?? path.join(home, 'AppData', 'Roaming');
  switch (agent) {
    case 'claude-code':
      return path.join(home, '.claude.json');
    case 'cursor':
      return path.join(home, '.cursor', 'mcp.json');
    case 'codex':
      return path.join(home, '.codex', 'config.toml');
    case 'opencode':
      return path.join(home, '.config', 'opencode', 'opencode.json');
    case 'vscode':
      if (env.platform === 'win32') return path.join(appData, 'Code', 'User', 'mcp.json');
      if (env.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
      return path.join(home, '.config', 'Code', 'User', 'mcp.json');
    case 'claude-desktop':
      if (env.platform === 'win32') return path.join(appData, 'Claude', 'claude_desktop_config.json');
      if (env.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
      return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
    case 'windsurf':
      return path.join(home, '.codeium', 'windsurf', 'mcp_config.json');
    case 'gemini':
      return path.join(home, '.gemini', 'settings.json');
  }
}

/** The binary itself when running compiled (the Tauri sidecar or `bun build --compile`), else node with the bundled cli.js. */
export function defaultServerCommand(execPath: string, scriptPath: string): ServerCommand {
  const base = path.basename(execPath.replace(/\\/g, '/')).replace(/\.exe$/i, '');
  if (base === 'markup' || base.startsWith('markup-')) return { command: execPath, args: ['mcp'] };
  return { command: 'node', args: [path.resolve(scriptPath), 'mcp'] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Writes `next` over `file`, copying the current contents to `<file>.bak` first. Unchanged files are left alone. */
function writeWithBackup(file: string, previous: string | undefined, next: string) {
  if (previous === next) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (previous !== undefined) fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, next);
}

const readIfExists = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);

/** A JSON config as an object (`{}` when missing or empty), or why it cannot be used. */
function readJsonConfig(file: string): { previous: string | undefined; config: Record<string, unknown> } | { error: string } {
  const previous = readIfExists(file);
  if (previous === undefined || !previous.trim()) return { previous, config: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(previous);
  } catch (err) {
    return { error: `${file} is not plain JSON (${(err as Error).message}). Left it unchanged` };
  }
  if (!isObject(parsed)) return { error: `${file} does not hold a JSON object. Left it unchanged` };
  return { previous, config: parsed };
}

function installJson(agent: JsonAgent, entry: ServerCommand, env: InstallEnv): InstallResult {
  const file = configPath(agent, env);
  const read = readJsonConfig(file);
  if ('error' in read) return { ok: false, message: `${read.error}; add this by hand:\n${snippets(entry)[agent].code}` };
  const { previous, config } = read;
  const key = jsonKey[agent];
  const servers = config[key];
  if (servers !== undefined && !isObject(servers)) return { ok: false, message: `"${key}" in ${file} is not an object. Left it unchanged.` };
  config[key] = { ...servers, [SERVER_NAME]: jsonEntry[agent](entry) };
  writeWithBackup(file, previous, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, message: `Added markup to ${AGENT_LABELS[agent]} (${file}).` };
}

function uninstallJson(agent: JsonAgent, env: InstallEnv): InstallResult {
  const file = configPath(agent, env);
  const read = readJsonConfig(file);
  if ('error' in read) return { ok: false, message: `${read.error}.` };
  const { previous, config } = read;
  const servers = config[jsonKey[agent]];
  if (!isObject(servers) || !(SERVER_NAME in servers)) return { ok: true, message: `markup was not set up in ${AGENT_LABELS[agent]}.` };
  const { [SERVER_NAME]: _removed, ...rest } = servers;
  config[jsonKey[agent]] = rest;
  writeWithBackup(file, previous, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, message: `Removed markup from ${AGENT_LABELS[agent]} (${file}).` };
}

const HEADER = /^\s*(\[\[?)\s*([^\[\]]+?)\s*\]\]?\s*(#.*)?$/;
const tableName = (raw: string) =>
  raw
    .split('.')
    .map((part) => part.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2'))
    .join('.');

/** Net `[`/`]` depth of a TOML line, ignoring single-line strings and comments. */
function bracketDelta(line: string): number {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '#') break;
    if (c === '"' || c === "'") {
      for (i++; i < line.length && line[i] !== c; i++) if (c === '"' && line[i] === '\\') i++;
    } else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth;
}

interface TomlTable {
  name: string;
  /** Line of the `[header]`. */
  start: number;
  /** Line after the table's last line: the next header, or the end of the file. */
  end: number;
  array: boolean;
}

/** Every table header of a TOML file, skipping brackets inside multi-line arrays. */
function tomlTables(lines: string[]): TomlTable[] {
  const tables: TomlTable[] = [];
  let depth = 0;
  for (const [i, line] of lines.entries()) {
    const header = depth === 0 ? HEADER.exec(line) : null;
    if (header) {
      const last = tables.at(-1);
      if (last) last.end = i;
      tables.push({ name: tableName(header[2] ?? ''), start: i, end: lines.length, array: header[1] === '[[' });
      continue;
    }
    depth = Math.max(0, depth + bracketDelta(line));
  }
  return tables;
}

const CODEX_TABLE = `mcp_servers.${SERVER_NAME}`;
const codexTableOf = (lines: string[]) => tomlTables(lines).find((t) => !t.array && t.name === CODEX_TABLE);

/**
 * Puts the `[mcp_servers.markup]` table into a Codex config.toml: replaces that table's own key/value lines if it exists
 * (sub-tables like `[mcp_servers.markup.env]` and everything else stay), else appends it.
 */
export function upsertCodexTable(text: string, entry: ServerCommand): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const table = codexTable(entry).trimEnd().split('\n');
  const found = codexTableOf(lines);
  const start = found?.start ?? -1;
  const end = found?.end ?? lines.length;
  if (start < 0) {
    const body = text.replace(/(\r?\n)*$/, '');
    return body ? `${body}${eol}${eol}${table.join(eol)}${eol}` : `${table.join(eol)}${eol}`;
  }
  let blankTail = end;
  while (blankTail > start + 1 && !lines[blankTail - 1]?.trim()) blankTail--;
  return [...lines.slice(0, start), ...table, ...lines.slice(blankTail)].join(eol);
}

/** Drops `[mcp_servers.markup]` and its sub-tables, with the blank lines in front of them. */
export function removeCodexTable(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const drop = new Set<number>();
  for (const t of tomlTables(lines)) {
    if (t.array || (t.name !== CODEX_TABLE && !t.name.startsWith(`${CODEX_TABLE}.`))) continue;
    // The table up to its last value, and the blank lines in front of it; the blanks after it keep separating what follows.
    let last = t.end - 1;
    while (last > t.start && !lines[last]?.trim()) last--;
    for (let i = t.start; i <= last; i++) drop.add(i);
    for (let i = t.start - 1; i >= 0 && !drop.has(i) && !lines[i]?.trim(); i--) drop.add(i);
  }
  if (!drop.size) return text;
  const kept = lines.filter((_, i) => !drop.has(i));
  while (kept.length && !kept.at(-1)?.trim()) kept.pop();
  return kept.length ? `${kept.join(eol)}${eol}` : '';
}

/** The command and args of `[mcp_servers.markup]`, read from plain one-line values. */
export function readCodexEntry(text: string): ServerCommand | null {
  const lines = text.split(/\r?\n/);
  const table = codexTableOf(lines);
  if (!table) return null;
  const body = lines.slice(table.start + 1, table.end);
  const value = (key: string): unknown => {
    const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(#.*)?$`);
    const raw = body.map((l) => pattern.exec(l)?.[1]).find(Boolean);
    try {
      return raw === undefined ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const command = value('command');
  const args = value('args');
  return { command: typeof command === 'string' ? command : '', args: Array.isArray(args) ? args.map(String) : [] };
}

function installCodex(entry: ServerCommand, env: InstallEnv): InstallResult {
  const file = configPath('codex', env);
  const previous = readIfExists(file);
  writeWithBackup(file, previous, upsertCodexTable(previous ?? '', entry));
  return { ok: true, message: `Added markup to Codex (${file}).` };
}

function installClaude(entry: ServerCommand, env: InstallEnv): InstallResult {
  const claude = env.findExecutable('claude');
  if (!claude) return { ok: false, message: `claude was not found on PATH or in the usual install folders. Install Claude Code, or run this yourself:\n${claudeAddLine(entry)}` };
  const output = (r: RunResult) => [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
  // Replace any existing user-scope entry. `claude mcp get` would start the server to health-check it, so remove
  // unconditionally: it fails harmlessly when there is no entry.
  env.run(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
  const added = env.run(claude, claudeAddArgs(entry));
  if (added.status !== 0) return { ok: false, message: `claude mcp add failed${added.status === null ? '' : ` (exit ${added.status})`}.\n${output(added)}`.trim() };
  return { ok: true, message: `Added markup to Claude Code (user scope).${output(added) ? `\n${output(added)}` : ''}` };
}

function uninstallCodex(env: InstallEnv): InstallResult {
  const file = configPath('codex', env);
  const previous = readIfExists(file);
  const next = previous === undefined ? undefined : removeCodexTable(previous);
  if (previous === undefined || next === undefined || next === previous) return { ok: true, message: 'markup was not set up in Codex.' };
  writeWithBackup(file, previous, next);
  return { ok: true, message: `Removed markup from Codex (${file}).` };
}

function uninstallClaude(env: InstallEnv): InstallResult {
  const claude = env.findExecutable('claude');
  if (!claude) return { ok: false, message: `claude was not found on PATH or in the usual install folders. Run this yourself:\nclaude mcp remove --scope user ${SERVER_NAME}` };
  const r = env.run(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
  if (r.status === 0) return { ok: true, message: 'Removed markup from Claude Code.' };
  if (/no .*found/i.test(`${r.stdout}\n${r.stderr}`)) return { ok: true, message: 'markup was not set up in Claude Code.' };
  const output = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
  return { ok: false, message: `claude mcp remove failed${r.status === null ? '' : ` (exit ${r.status})`}.\n${output}`.trim() };
}

/** Takes markup out of an agent's config and leaves everything else as it was. */
export function uninstall(agent: Agent, env: InstallEnv): InstallResult {
  try {
    if (agent === 'claude-code') return uninstallClaude(env);
    if (agent === 'codex') return uninstallCodex(env);
    return uninstallJson(agent, env);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** What an agent's config says about markup. */
export type ConfigState = { state: 'missing' } | { state: 'set'; entry: ServerCommand } | { state: 'unreadable'; message: string };

export function readConfig(agent: Agent, env: Pick<InstallEnv, 'home' | 'platform' | 'appData'>): ConfigState {
  const file = configPath(agent, env);
  try {
    if (agent === 'codex') {
      const text = readIfExists(file);
      const entry = text === undefined ? null : readCodexEntry(text);
      return entry ? { state: 'set', entry } : { state: 'missing' };
    }
    const read = readJsonConfig(file);
    if ('error' in read) return { state: 'unreadable', message: read.error };
    // Claude Code keeps user-scope servers under mcpServers in ~/.claude.json.
    const servers = read.config[agent === 'claude-code' ? 'mcpServers' : jsonKey[agent]];
    const raw = isObject(servers) ? servers[SERVER_NAME] : undefined;
    if (!isObject(raw)) return { state: 'missing' };
    // OpenCode keeps the command and its args in one array.
    if (Array.isArray(raw.command)) {
      const [command, ...args] = raw.command.map(String);
      return { state: 'set', entry: { command: command ?? '', args } };
    }
    return { state: 'set', entry: { command: typeof raw.command === 'string' ? raw.command : '', args: Array.isArray(raw.args) ? raw.args.map(String) : [] } };
  } catch (err) {
    return { state: 'unreadable', message: (err as Error).message };
  }
}

/** Why a configured entry cannot start, or null when it looks runnable. Bare commands such as `npx` are left to PATH. */
export function entryProblem(entry: ServerCommand, exists: (file: string) => boolean = fs.existsSync): string | null {
  if (!entry.command) return 'has no command';
  const isPath = (p: string) => path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
  if (isPath(entry.command) && !exists(entry.command)) return `points to a missing file: ${entry.command}`;
  const isNode = path.basename(entry.command.replace(/\\/g, '/')).replace(/\.exe$/i, '') === 'node';
  const script = entry.args.find((a) => /\.[cm]?js$/.test(a));
  if (isNode && script && isPath(script) && !exists(script)) return `points to a missing file: ${script}`;
  return null;
}

/** How we know an agent is on this machine (a folder or a command), or null when nothing points to it. */
export function detectAgent(agent: Agent, env: Pick<InstallEnv, 'home' | 'platform' | 'appData' | 'findExecutable'>): string | null {
  const { home } = env;
  const dir = (p: string) => (fs.existsSync(p) ? p : null);
  const exe = (name: string) => (env.findExecutable(name) ? `${name} command` : null);
  switch (agent) {
    case 'claude-code':
      return exe('claude') ?? dir(path.join(home, '.claude.json'));
    case 'cursor':
      return dir(path.join(home, '.cursor'));
    case 'codex':
      return dir(path.join(home, '.codex')) ?? exe('codex');
    case 'opencode':
      return dir(path.join(home, '.config', 'opencode')) ?? exe('opencode');
    case 'gemini':
      return dir(path.join(home, '.gemini')) ?? exe('gemini');
    case 'windsurf':
      return dir(path.join(home, '.codeium', 'windsurf'));
    case 'vscode':
    case 'claude-desktop':
      return dir(path.dirname(configPath(agent, env)));
  }
}

function printAll(entry: ServerCommand, env: InstallEnv): InstallResult {
  const all = snippets(entry);
  for (const agent of AGENTS) env.log(`# ${AGENT_LABELS[agent]} (${all[agent].where})\n${all[agent].code.trimEnd()}\n`);
  return { ok: true, message: '' };
}

export const INSTALL_TARGETS = [...AGENTS, 'print'] as const;
export type InstallTarget = (typeof INSTALL_TARGETS)[number];

export function install(target: InstallTarget, entry: ServerCommand, env: InstallEnv): InstallResult {
  try {
    switch (target) {
      case 'print':
        return printAll(entry, env);
      case 'claude-code':
        return installClaude(entry, env);
      case 'codex':
        return installCodex(entry, env);
      default:
        return installJson(target, entry, env);
    }
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** Finds `name` on PATH, honouring PATHEXT on Windows. */
export function findOnPath(name: string, platform: NodeJS.Platform = process.platform, pathEnv = process.env.PATH ?? process.env.Path ?? ''): string | null {
  return searchDirs(name, pathEnv.split(platform === 'win32' ? ';' : ':'), platform, process.env, isFileOnDisk);
}

const isFileOnDisk = (file: string) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

function searchDirs(name: string, dirs: string[], platform: NodeJS.Platform, vars: Record<string, string | undefined>, isFile: (file: string) => boolean): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const exts = platform === 'win32' ? (vars.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs.filter(Boolean)) for (const ext of exts) {
    const candidate = p.join(dir, name + ext);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** What findExecutable reads from the machine; injectable for tests. */
export interface LookupEnv {
  home: string;
  platform: NodeJS.Platform;
  pathEnv: string;
  /** Windows %APPDATA%; defaults to <home>/AppData/Roaming. */
  appData?: string;
  /** Environment variables read: SHELL, NPM_CONFIG_PREFIX, PATHEXT. */
  env: Record<string, string | undefined>;
  isFile(file: string): boolean;
  run(command: string, args: string[]): RunResult;
}

/**
 * Where CLIs like claude are usually installed. Apps started from Finder or the Dock get
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin, so PATH alone misses most of them.
 */
function knownBinDirs(env: LookupEnv): string[] {
  const { home } = env;
  const prefix = env.env.NPM_CONFIG_PREFIX ?? env.env.npm_config_prefix;
  if (env.platform === 'win32') {
    const p = path.win32;
    const appData = env.appData ?? p.join(home, 'AppData', 'Roaming');
    return [p.join(appData, 'npm'), p.join(home, '.local', 'bin'), p.join(home, '.claude', 'local'), ...(prefix ? [prefix] : []), p.join(home, '.bun', 'bin'), p.join(home, '.volta', 'bin')];
  }
  const p = path.posix;
  return [
    p.join(home, '.local', 'bin'),
    p.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...(prefix ? [p.join(prefix, 'bin')] : []),
    p.join(home, '.npm-global', 'bin'),
    p.join(home, '.bun', 'bin'),
    p.join(home, '.volta', 'bin'),
  ];
}

/** Finds `name` on PATH, then in the usual install folders, then (macOS/Linux) by asking the user's login shell. */
export function findExecutable(name: string, env: LookupEnv): string | null {
  const found = searchDirs(name, env.pathEnv.split(env.platform === 'win32' ? ';' : ':'), env.platform, env.env, env.isFile) ?? searchDirs(name, knownBinDirs(env), env.platform, env.env, env.isFile);
  if (found || env.platform === 'win32' || !/^[\w.-]+$/.test(name)) return found;
  // nvm, asdf, fnm and custom prefixes are only known to the login shell's profile.
  const shell = env.env.SHELL || (env.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
  const r = env.run(shell, ['-lc', `command -v ${name}`]);
  const line = r.status === 0 ? r.stdout.trim().split('\n').pop()?.trim() : undefined;
  return line && line.startsWith('/') && env.isFile(line) ? line : null;
}

/** cmd.exe quoting for .cmd/.bat shims, which Node can only start through a shell. */
const cmdQuote = (s: string) => (/[\s"&|<>^()%!,;=]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function runCommand(command: string, args: string[]): RunResult {
  const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const r = viaShell
    ? spawnSync([command, ...args].map(cmdQuote).join(' '), { shell: true, encoding: 'utf8' })
    : spawnSync(command, args, { encoding: 'utf8' });
  if (r.error) return { status: null, stdout: '', stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function systemEnv(home: string): InstallEnv {
  return {
    home,
    platform: process.platform,
    appData: process.env.APPDATA,
    log: (line) => process.stdout.write(`${line}\n`),
    findExecutable: (name) =>
      findExecutable(name, { home, platform: process.platform, pathEnv: process.env.PATH ?? process.env.Path ?? '', appData: process.env.APPDATA, env: process.env, isFile: isFileOnDisk, run: runCommand }),
    run: runCommand,
  };
}
