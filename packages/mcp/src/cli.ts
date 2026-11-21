import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BRIDGE_PORT } from '@markup/protocol';
import { connectOrHost, resilientHub, type Hub } from './hub';
import { defaultServerCommand, install, INSTALL_TARGETS, systemEnv, type InstallTarget } from './install';
import { createServer } from './server';

const USAGE = `Usage:
  markup mcp                                Run the Markup MCP server over stdio (for Claude Code, Codex, Cursor, VS Code, ...)
  markup install <agent> [--command <path>] Add markup to an agent's MCP config
                                            agents: ${INSTALL_TARGETS.join(', ')}`;

const fail = (scope: string, message: string): never => {
  process.stderr.write(`markup ${scope}: ${message}\n`);
  process.exit(1);
};

async function runMcp() {
  const port = Number(process.env.MARKUP_BRIDGE_PORT ?? BRIDGE_PORT);
  let first: Hub;
  try {
    // Fail fast on a foreign port owner, and keep this hub open so the editor registers before the first call.
    first = await connectOrHost(port);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return fail('mcp', e.code === 'EACCES' ? `Port ${port} is reserved by the system (EACCES). Free it, then restart your agent.` : e.message);
  }
  const server = createServer(resilientHub(port, {}, first));
  await server.connect(new StdioServerTransport());
}

function runInstall(rest: string[]) {
  const [target, ...flags] = rest;
  if (!(INSTALL_TARGETS as readonly string[]).includes(target ?? '')) return fail('install', `expected one of ${INSTALL_TARGETS.join(', ')}${target ? `, got "${target}"` : ''}.\n${USAGE}`);
  let commandPath: string | undefined;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--command' && flags[i + 1]) commandPath = flags[++i];
    else return fail('install', `unknown option "${flags[i]}".\n${USAGE}`);
  }
  const entry = commandPath ? { command: commandPath, args: ['mcp'] } : defaultServerCommand(process.execPath, fileURLToPath(import.meta.url));
  const result = install(target as InstallTarget, entry, systemEnv(os.homedir()));
  if (!result.ok) return fail('install', result.message);
  if (result.message) process.stdout.write(`${result.message}\n`);
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  if (command === 'mcp') return runMcp();
  if (command === 'install') return runInstall(rest);
  process.stderr.write(`${USAGE}\n`);
  process.exit(command ? 1 : 0);
}

main(process.argv.slice(2)).catch((err: Error) => fail(process.argv[2] ?? 'mcp', err.message));
