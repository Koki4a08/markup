// @vitest-environment node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MarkupDoc } from '@markup/doc';
import { createServer, startHub } from '@markup/mcp';
import { connectBridge } from '../src/bridge/client';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

it('agent draws through markup mcp and the log attributes it', async () => {
  const port = 39950 + Math.floor(Math.random() * 40);
  const hub = await startHub(port);
  cleanups.push(() => hub.close());
  const doc = new MarkupDoc({ name: 'Landing' });
  const page = doc.pages()[0]!;
  const bridge = connectBridge({ doc, url: `ws://127.0.0.1:${port}`, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket, activePageId: () => page.id, getSelection: () => [] });
  cleanups.push(() => bridge.close());
  while (bridge.status() !== 'connected') await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));

  const server = createServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'claude-code', version: '1.0.0' });
  await client.connect(b);
  cleanups.push(() => client.close());

  const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { text: string }[])[0]!.text;
  const created = JSON.parse(text(await client.callTool({ name: 'create_artboard', arguments: { name: 'Hero', styles: { width: '1440px', height: '900px' } } })));
  await client.callTool({ name: 'write_html', arguments: { targetNodeId: created.nodeId, mode: 'insert-children', html: '<div layer-name="Headline" style="padding: 64px"><p>Book a berth</p></div>' } });
  const jsx = text(await client.callTool({ name: 'get_jsx', arguments: { nodeId: created.nodeId, includeNodeIds: false } }));
  expect(jsx).toContain('<p>Book a berth</p>');
  expect(jsx).toContain('padding: "64px"');
  await client.callTool({ name: 'finish_working_on_nodes', arguments: {} });
  expect(doc.working()).toEqual({});
  expect(doc.log().map((e) => e.actor.name)).toEqual(['claude-code', 'claude-code']);
});
