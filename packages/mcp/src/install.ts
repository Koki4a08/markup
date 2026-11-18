import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_LABELS, AGENTS, claudeAddArgs, claudeAddLine, codexTable, jsonEntry, jsonKey, SERVER_NAME, snippets, type Agent, type ServerCommand } from './snippets';

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

type FileAgent = Exclude<Agent, 'claude-code'>;

export function configPath(agent: FileAgent, env: Pick<InstallEnv, 'home' | 'platform' | 'appData'>): string {
  const { home } = env;
  switch (agent) {
    case 'cursor':
      return path.join(home, '.cursor', 'mcp.json');
    case 'codex':
      return path.join(home, '.codex', 'config.toml');
    case 'opencode':
      return path.join(home, '.config', 'opencode', 'opencode.json');
    case 'vscode':
      if (env.platform === 'win32') return path.join(env.appData ?? path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
      if (env.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
      return path.join(home, '.config', 'Code', 'User', 'mcp.json');
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

function installJson(agent: 'cursor' | 'vscode' | 'opencode', entry: ServerCommand, env: InstallEnv): InstallResult {
  const file = configPath(agent, env);
  const previous = readIfExists(file);
  let config: Record<string, unknown> = {};
  if (previous !== undefined && previous.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(previous);
    } catch (err) {
      return { ok: false, message: `${file} is not plain JSON (${(err as Error).message}). Left it unchanged; add this by hand:\n${snippets(entry)[agent].code}` };
    }
    if (!isObject(parsed)) return { ok: false, message: `${file} does not hold a JSON object. Left it unchanged.` };
    config = parsed;
  }
  const key = jsonKey[agent];
  const servers = config[key];
  if (servers !== undefined && !isObject(servers)) return { ok: false, message: `"${key}" in ${file} is not an object. Left it unchanged.` };
  config[key] = { ...servers, [SERVER_NAME]: jsonEntry[agent](entry) };
  writeWithBackup(file, previous, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, message: `Added markup to ${AGENT_LABELS[agent]} (${file}).` };
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

/**
 * Puts the `[mcp_servers.markup]` table into a Codex config.toml: replaces that table's own key/value lines if it exists
 * (sub-tables like `[mcp_servers.markup.env]` and everything else stay), else appends it.
 */
export function upsertCodexTable(text: string, entry: ServerCommand): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const target = `mcp_servers.${SERVER_NAME}`;
  const table = codexTable(entry).trimEnd().split('\n');
  let depth = 0;
  let start = -1;
  let end = lines.length;
  for (const [i, line] of lines.entries()) {
    const header = depth === 0 ? HEADER.exec(line) : null;
    if (header) {
      if (start >= 0) {
        end = i;
        break;
      }
      if (header[1] === '[' && tableName(header[2] ?? '') === target) start = i;
      continue;
    }
    depth = Math.max(0, depth + bracketDelta(line));
  }
  if (start < 0) {
    const body = text.replace(/(\r?\n)*$/, '');
    return body ? `${body}${eol}${eol}${table.join(eol)}${eol}` : `${table.join(eol)}${eol}`;
  }
  let blankTail = end;
  while (blankTail > start + 1 && !lines[blankTail - 1]?.trim()) blankTail--;
  return [...lines.slice(0, start), ...table, ...lines.slice(blankTail)].join(eol);
}

function installCodex(entry: ServerCommand, env: InstallEnv): InstallResult {
  const file = configPath('codex', env);
  const previous = readIfExists(file);
  writeWithBackup(file, previous, upsertCodexTable(previous ?? '', entry));
  return { ok: true, message: `Added markup to Codex (${file}).` };
}

function installClaude(entry: ServerCommand, env: InstallEnv): InstallResult {
  const claude = env.findExecutable('claude');
  if (!claude) return { ok: false, message: `claude was not found on PATH. Install Claude Code, or run this yourself:\n${claudeAddLine(entry)}` };
  const output = (r: RunResult) => [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
  // Replace any existing user-scope entry. `claude mcp get` would start the server to health-check it, so remove
  // unconditionally: it fails harmlessly when there is no entry.
  env.run(claude, ['mcp', 'remove', '--scope', 'user', SERVER_NAME]);
  const added = env.run(claude, claudeAddArgs(entry));
  if (added.status !== 0) return { ok: false, message: `claude mcp add failed${added.status === null ? '' : ` (exit ${added.status})`}.\n${output(added)}`.trim() };
  return { ok: true, message: `Added markup to Claude Code (user scope).${output(added) ? `\n${output(added)}` : ''}` };
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
  const exts = platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
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
    findExecutable: (name) => findOnPath(name),
    run: runCommand,
  };
}
