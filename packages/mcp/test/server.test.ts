import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '@markup/protocol';
import { BridgeError, type Hub } from '../src/hub';
import { createServer } from '../src/server';

function fakeHub(answer: (method: string, params: unknown) => unknown): Hub & { calls: { method: string; fileId?: string; agent: { name: string } }[] } {
  const calls: { method: string; fileId?: string; agent: { name: string } }[] = [];
  return {
    role: 'host',
    calls,
    async request(msg) {
      calls.push({ method: msg.method, fileId: msg.fileId, agent: msg.agent });
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
  it('lists all tools', async () => {
    const client = await connect(fakeHub(() => ({})));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('forwards calls with the client name as agent', async () => {
    const hub = fakeHub(() => ({ nodeCount: 3 }));
    const client = await connect(hub);
    const res = await client.callTool({ name: 'get_basic_info', arguments: {} });
    expect(res.content).toEqual([{ type: 'text', text: JSON.stringify({ nodeCount: 3 }) }]);
    expect(hub.calls[0]).toMatchObject({ method: 'get_basic_info', agent: { name: 'claude-code' } });
  });

  it('open_file is not routed by its fileId argument, doc tools are', async () => {
    const hub = fakeHub(() => ({}));
    const client = await connect(hub);
    await client.callTool({ name: 'open_file', arguments: { fileId: 'f2' } });
    await client.callTool({ name: 'get_basic_info', arguments: { fileId: 'f2' } });
    expect(hub.calls.map((c) => c.fileId)).toEqual([undefined, 'f2']);
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

  it('export results are written to disk and answered with paths', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'markup-export-'));
    process.env.MARKUP_EXPORT_DIR = dir;
    try {
      const data = Buffer.from('png-bytes').toString('base64');
      const client = await connect(fakeHub(() => ({ files: [{ nodeId: 'n', name: 'Hero', format: 'png', scale: '2x', mimeType: 'image/png', data }] })));
      for (const name of ['export', 'export_combined_pdf']) {
        const args = name === 'export' ? { nodes: { n: [] } } : { nodeIds: ['n'] };
        const res = await client.callTool({ name, arguments: args });
        const parsed = JSON.parse((res.content as { text: string }[])[0]!.text) as { exports: { nodeId: string; path: string }[] };
        expect(parsed.exports[0]!.nodeId).toBe('n');
        expect(readFileSync(parsed.exports[0]!.path, 'utf8')).toBe('png-bytes');
      }
    } finally {
      delete process.env.MARKUP_EXPORT_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('export replies carry skipped nodes and clamped scales', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'markup-export-'));
    process.env.MARKUP_EXPORT_DIR = dir;
    try {
      const data = Buffer.from('png-bytes').toString('base64');
      const skipped = [{ nodeId: 'h', reason: 'The node is hidden.' }];
      const client = await connect(fakeHub(() => ({ files: [{ nodeId: 'n', name: 'Hero', format: 'png', scale: '200x', clampedScale: 81.92, mimeType: 'image/png', data }], skipped })));
      const res = await client.callTool({ name: 'export', arguments: { nodes: 'nodes-with-exports-only' } });
      const parsed = JSON.parse((res.content as { text: string }[])[0]!.text) as { exports: { clampedScale?: number }[]; skipped?: unknown };
      expect(parsed.exports[0]!.clampedScale).toBe(81.92);
      expect(parsed.skipped).toEqual(skipped);
    } finally {
      delete process.env.MARKUP_EXPORT_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fill images are returned as an image block with the original url', async () => {
    const client = await connect(fakeHub(() => ({ data: '/9j/4AAQ', mimeType: 'image/jpeg', originalUrl: 'https://x/y.png' })));
    const res = await client.callTool({ name: 'get_fill_image', arguments: { nodeId: 'n' } });
    expect(res.content).toEqual([
      { type: 'image', data: '/9j/4AAQ', mimeType: 'image/jpeg' },
      { type: 'text', text: JSON.stringify({ originalUrl: 'https://x/y.png' }) },
    ]);
    const none = await connect(fakeHub(() => ({ message: 'No image fill.' })));
    expect((await none.callTool({ name: 'get_fill_image', arguments: { nodeId: 'n' } })).content).toEqual([{ type: 'text', text: 'No image fill.' }]);
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
