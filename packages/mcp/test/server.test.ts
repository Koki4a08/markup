import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { PHASE1_TOOLS } from '@markup/protocol';
import { BridgeError, type Hub } from '../src/hub';
import { createServer } from '../src/server';

function fakeHub(answer: (method: string, params: unknown) => unknown): Hub & { calls: { method: string; agent: { name: string } }[] } {
  const calls: { method: string; agent: { name: string } }[] = [];
  return {
    role: 'host',
    calls,
    async request(msg) {
      calls.push({ method: msg.method, agent: msg.agent });
      return answer(msg.method, msg.params);
    },
    async close() {},
  };
}

async function connect(hub: Hub) {
  const server = createServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(b);
  return client;
}

describe('mcp server', () => {
  it('lists all phase-1 tools', async () => {
    const client = await connect(fakeHub(() => ({})));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...PHASE1_TOOLS].sort());
  });

  it('forwards calls with the client name as agent', async () => {
    const hub = fakeHub(() => ({ nodeCount: 3 }));
    const client = await connect(hub);
    const res = await client.callTool({ name: 'get_basic_info', arguments: {} });
    expect(res.content).toEqual([{ type: 'text', text: JSON.stringify({ nodeCount: 3 }) }]);
    expect(hub.calls[0]).toMatchObject({ method: 'get_basic_info', agent: { name: 'claude-code' } });
  });

  it('string results are returned as plain text', async () => {
    const client = await connect(fakeHub(() => '<div />'));
    const res = await client.callTool({ name: 'get_jsx', arguments: { nodeId: 'n' } });
    expect(res.content).toEqual([{ type: 'text', text: '<div />' }]);
  });

  it('screenshot is returned as an image', async () => {
    const client = await connect(fakeHub(() => ({ data: 'iVBORw0KGgo=', mimeType: 'image/png', width: 10, height: 10 })));
    const res = await client.callTool({ name: 'get_screenshot', arguments: { nodeId: 'n' } });
    expect(res.content).toEqual([{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
  });

  it('tool error surfaces as isError', async () => {
    const client = await connect(
      fakeHub(() => {
        throw new BridgeError('NO_EDITOR', 'Open Markup.');
      }),
    );
    const res = await client.callTool({ name: 'get_basic_info', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: 'text', text: 'NO_EDITOR: Open Markup.' }]);
  });

  it('get_guide answers locally', async () => {
    const hub = fakeHub(() => ({}));
    const client = await connect(hub);
    const res = await client.callTool({ name: 'get_guide', arguments: { topic: 'markup-mcp-instructions' } });
    expect((res.content as { text: string }[])[0]!.text).toContain('get_basic_info');
    expect(hub.calls).toHaveLength(0);
  });
});
