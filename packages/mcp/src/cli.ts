import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BRIDGE_PORT } from '@markup/protocol';
import { connectOrHost, resilientHub, type Hub } from './hub';
import { createServer } from './server';

const USAGE = `Usage: markup mcp    Run the Markup MCP server over stdio (for Claude Code, Codex, Cursor, VS Code, ...)`;

const fail = (message: string): never => {
  process.stderr.write(`markup mcp: ${message}\n`);
  process.exit(1);
};

async function main(argv: string[]) {
  const [command] = argv;
  if (command !== 'mcp') {
    process.stderr.write(`${USAGE}\n`);
    process.exit(command ? 1 : 0);
  }
  const port = Number(process.env.MARKUP_BRIDGE_PORT ?? BRIDGE_PORT);
  let first: Hub;
  try {
    // Fail fast on a foreign port owner, and keep this hub open so the editor registers before the first call.
    first = await connectOrHost(port);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return fail(e.code === 'EACCES' ? `Port ${port} is reserved by the system (EACCES). Free it, then restart your agent.` : e.message);
  }
  const server = createServer(resilientHub(port, {}, first));
  await server.connect(new StdioServerTransport());
}

main(process.argv.slice(2)).catch((err: Error) => fail(err.message));
