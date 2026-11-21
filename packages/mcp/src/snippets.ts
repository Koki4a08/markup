/** Agent config snippets for `markup mcp`. No Node imports: the editor's web build renders these too. */

export const AGENTS = ['claude-code', 'cursor', 'vscode', 'codex', 'opencode'] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<Agent, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  vscode: 'VS Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** How an agent starts the stdio server. */
export interface ServerCommand {
  command: string;
  args: string[];
}

export const SERVER_NAME = 'markup';

/** The JSON value each JSON-configured agent stores under its servers key. */
export const jsonEntry = {
  cursor: ({ command, args }: ServerCommand) => ({ command, args }),
  vscode: ({ command, args }: ServerCommand) => ({ type: 'stdio', command, args }),
  opencode: ({ command, args }: ServerCommand) => ({ type: 'local', command: [command, ...args], enabled: true }),
};

/** Where each JSON-configured agent keeps its servers. */
export const jsonKey = { cursor: 'mcpServers', vscode: 'servers', opencode: 'mcp' } as const;

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
  };
}
