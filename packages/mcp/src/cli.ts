import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BRIDGE_PORT } from '@markup/protocol';
import { connectOrHost, resilientHub } from './hub';
import { createServer } from './server';

const USAGE = `Usage: markup mcp    Run the Markup MCP server over stdio (for Claude Code, Codex, Cursor, VS Code, ...)`;

async function main(argv: string[]) {
  const [command] = argv;
  if (command !== 'mcp') {
    process.stderr.write(`${USAGE}\n`);
    process.exit(command ? 1 : 0);
  }
  const port = Number(process.env.MARKUP_BRIDGE_PORT ?? BRIDGE_PORT);
  try {
    // Fail fast on a foreign port owner, then keep a self-healing hub for the session.
    const first = await connectOrHost(port);
    await first.close();
  } catch (err) {
    process.stderr.write(`markup mcp: ${(err as Error).message}\n`);
    process.exit(1);
  }
  const server = createServer(resilientHub(port));
  await server.connect(new StdioServerTransport());
}

void main(process.argv.slice(2));
