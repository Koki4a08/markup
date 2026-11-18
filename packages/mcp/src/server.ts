import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { tools, type ToolName } from '@markup/protocol';
import type { ZodRawShape } from 'zod';
import { guide } from './guide';
import { BridgeError, type Hub } from './hub';

export const SERVER_INSTRUCTIONS =
  'Markup is a design canvas whose layers are real HTML/CSS. Load the guide first: get_guide({ topic: "markup-mcp-instructions" }). Call get_basic_info when starting on a file, write HTML incrementally, review with get_screenshot, and always call finish_working_on_nodes when done.';

function toResult(method: ToolName, result: unknown): CallToolResult {
  if (method === 'get_screenshot' && result && typeof result === 'object' && 'data' in result) {
    const { data, mimeType } = result as { data: string; mimeType?: string };
    return { content: [{ type: 'image', data, mimeType: mimeType ?? 'image/png' }] };
  }
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
}

/** MCP server exposing Markup's tools; every call except get_guide is forwarded to the editor through the hub. */
export function createServer(hub: Hub, clientId: string = randomUUID()): McpServer {
  const server = new McpServer({ name: 'markup', version: '0.0.0' }, { instructions: SERVER_INSTRUCTIONS });
  const agentName = () => server.server.getClientVersion()?.name ?? 'Agent';
  // One generic handler for every tool; the per-tool zod shape still validates arguments.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { description: string; inputSchema: ZodRawShape },
    cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ) => void;

  for (const [name, def] of Object.entries(tools) as [ToolName, (typeof tools)[ToolName]][]) {
    register(name, { description: def.description, inputSchema: def.input.shape }, async (args: Record<string, unknown>) => {
      if (name === 'get_guide') return { content: [{ type: 'text', text: guide(String(args.topic)) }] };
      try {
        const fileId = typeof args.fileId === 'string' ? args.fileId : undefined;
        const result = await hub.request({ fileId, method: name, params: args, agent: { clientId, name: agentName() } });
        return toResult(name, result);
      } catch (err) {
        const text = err instanceof BridgeError ? `${err.code}: ${err.message}` : `INTERNAL: ${(err as Error).message}`;
        return { isError: true, content: [{ type: 'text', text }] };
      }
    });
  }
  return server;
}
