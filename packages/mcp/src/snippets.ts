/** Agent config snippets for `markup mcp`. No Node imports: the editor's web build renders these too. */

export const AGENTS = ['claude-code', 'cursor', 'vscode', 'codex', 'opencode', 'claude-desktop', 'windsurf', 'gemini'] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<Agent, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  vscode: 'VS Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  'claude-desktop': 'Claude Desktop',
  windsurf: 'Windsurf',
  gemini: 'Gemini CLI',
};

/** One agent as `markup agents --json` reports it: whether it is on this machine, where its config lives, what that says. */
export interface AgentReport {
  agent: Agent;
  label: string;
  /** The folder or command that shows the agent is installed, or null when nothing does. */
  found: string | null;
  /** The file markup writes to (Claude Code: the file `claude mcp` keeps). */
  config: string;
  state: 'missing' | 'set' | 'unreadable';
  /** The command the config starts, when markup is set up. */
  command?: string;
  /** Why the configured entry cannot start, or why the config cannot be read. */
  problem?: string;
}

/** Output of `markup agents --json`. */
export interface AgentsReport {
  home: string;
  /** What `markup install` would write: the binary that answered. */
  command: ServerCommand;
  agents: AgentReport[];
}

/** How an agent starts the stdio server. */
export interface ServerCommand {
  command: string;
  args: string[];
}

export const SERVER_NAME = 'markup';

export const SITE = 'https://markup.here';

/** The one-line installers served by the website (markup-website/public/install.sh and install.ps1). */
export const INSTALL_COMMANDS = {
  unix: `curl -fsSL ${SITE}/install.sh | sh`,
  windows: `irm ${SITE}/install.ps1 | iex`,
} as const;

/** Where the install scripts put the binary, written out for a placeholder home folder. */
export const INSTALLED_PATHS = {
  mac: '/Users/you/.markup/bin/markup',
  linux: '/home/you/.markup/bin/markup',
  windows: 'C:\\Users\\you\\.markup\\bin\\markup.exe',
} as const;

/** The JSON value each JSON-configured agent stores under its servers key. */
const plainEntry = ({ command, args }: ServerCommand) => ({ command, args });

export const jsonEntry = {
  cursor: plainEntry,
  'claude-desktop': plainEntry,
  windsurf: plainEntry,
  gemini: plainEntry,
  vscode: ({ command, args }: ServerCommand) => ({ type: 'stdio', command, args }),
  opencode: ({ command, args }: ServerCommand) => ({ type: 'local', command: [command, ...args], enabled: true }),
};

/** Where each JSON-configured agent keeps its servers. */
export const jsonKey = { cursor: 'mcpServers', vscode: 'servers', opencode: 'mcp', 'claude-desktop': 'mcpServers', windsurf: 'mcpServers', gemini: 'mcpServers' } as const;

/** Agents configured through a JSON file. */
export type JsonAgent = keyof typeof jsonKey;

/** Double-quotes args that need it. Backslashes stay as typed so Windows paths read naturally. */
const shellQuote = (s: string) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/(["$`])/g, '\\$1')}"`);

export const claudeAddArgs = ({ command, args }: ServerCommand) => ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', command, ...args];

export const claudeAddLine = (entry: ServerCommand) => ['claude', ...claudeAddArgs(entry)].map(shellQuote).join(' ');

/** TOML basic strings accept JSON's escapes. */
const tomlString = (s: string) => JSON.stringify(s);

export const codexTable = ({ command, args }: ServerCommand) => `[mcp_servers.${SERVER_NAME}]\ncommand = ${tomlString(command)}\nargs = [${args.map(tomlString).join(', ')}]\n`;

export interface Snippet {
  /** Where the snippet goes, for people. */
  where: string;
  language: 'shell' | 'json' | 'toml';
  code: string;
}

const json = (key: string, value: unknown) => JSON.stringify({ [key]: { [SERVER_NAME]: value } }, null, 2);

export function snippets(entry: ServerCommand): Record<Agent, Snippet> {
  return {
    'claude-code': { where: 'Run in a terminal', language: 'shell', code: claudeAddLine(entry) },
    cursor: { where: '~/.cursor/mcp.json', language: 'json', code: json(jsonKey.cursor, jsonEntry.cursor(entry)) },
    vscode: { where: 'user mcp.json, opened with "MCP: Open User Configuration"', language: 'json', code: json(jsonKey.vscode, jsonEntry.vscode(entry)) },
    codex: { where: '~/.codex/config.toml', language: 'toml', code: codexTable(entry) },
    opencode: { where: '~/.config/opencode/opencode.json', language: 'json', code: json(jsonKey.opencode, jsonEntry.opencode(entry)) },
    'claude-desktop': { where: 'claude_desktop_config.json, opened from Settings > Developer > Edit Config', language: 'json', code: json(jsonKey['claude-desktop'], jsonEntry['claude-desktop'](entry)) },
    windsurf: { where: '~/.codeium/windsurf/mcp_config.json', language: 'json', code: json(jsonKey.windsurf, jsonEntry.windsurf(entry)) },
    gemini: { where: '~/.gemini/settings.json', language: 'json', code: json(jsonKey.gemini, jsonEntry.gemini(entry)) },
  };
}
