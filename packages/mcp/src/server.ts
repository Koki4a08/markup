import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RESOURCE_TOOLS, parseMarkupLink, tools, type ToolName } from '@markup/protocol';
import type { ZodRawShape } from 'zod';
import { writeExports, type ExportedFile } from './exportsink';
import { guide } from './guide';
import { BridgeError, type Hub } from './hub';

export const SERVER_INSTRUCTIONS =
  'Markup is a design canvas whose layers are real HTML/CSS. Load the guide first: get_guide({ topic: "markup-mcp-instructions" }). Call get_basic_info when starting on a file, write HTML incrementally, review with get_screenshot, and always call finish_working_on_nodes when done.';

function toResult(method: ToolName, result: unknown): CallToolResult {
  if (method === 'get_screenshot' && result && typeof result === 'object' && 'data' in result) {
    const { data, mimeType } = result as { data: string; mimeType?: string };
    return { content: [{ type: 'image', data, mimeType: mimeType ?? 'image/png' }] };
  }
  // The editor renders exports; this process writes them, so agents get paths on their own machine.
  if ((method === 'export' || method === 'export_combined_pdf') && result && typeof result === 'object' && 'files' in result) {
    const { files, skipped } = result as { files: ExportedFile[]; skipped?: { nodeId: string; reason: string }[] };
    const exports = writeExports({ files });
    return { content: [{ type: 'text', text: JSON.stringify(Array.isArray(skipped) && skipped.length ? { exports, skipped } : { exports }) }] };
  }
  if (method === 'get_fill_image' && result && typeof result === 'object') {
    const { data, originalUrl, message } = result as { data?: string; originalUrl?: string; message?: string };
    if (data) return { content: [{ type: 'image', data, mimeType: 'image/jpeg' }, { type: 'text', text: JSON.stringify({ originalUrl }) }] };
    if (message) return { content: [{ type: 'text', text: message }] };
  }
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
}

/** The file a markup:// link in nodeId, targetNodeId or nodeIds[0] names, so the hub picks that file's editor. */
function linkedFileId(args: Record<string, unknown>): string | undefined {
  const first = Array.isArray(args.nodeIds) ? args.nodeIds[0] : undefined;
  for (const value of [args.nodeId, args.targetNodeId, first]) {
    const link = typeof value === 'string' ? parseMarkupLink(value) : null;
    if (link) return link.fileId;
  }
  return undefined;
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
        // Resource tools act on the workspace; open_file's fileId names the file to open, not a route.
        const routed = !(RESOURCE_TOOLS as readonly string[]).includes(name);
        const fileId = !routed ? undefined : typeof args.fileId === 'string' ? (parseMarkupLink(args.fileId)?.fileId ?? args.fileId) : linkedFileId(args);
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
