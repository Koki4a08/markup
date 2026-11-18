// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MarkupDoc } from '@markup/doc';
import { startHub, type Hub } from '@markup/mcp';
import { connectBridge, type BridgeConnection } from '../src/bridge/client';

const agent = { clientId: 'c1', name: 'Claude Code' };
let port = 39700 + Math.floor(Math.random() * 200);
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const waitFor = async (check: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function setup() {
  const p = port++;
  const hub: Hub = await startHub(p);
  cleanups.push(() => hub.close());
  const doc = new MarkupDoc({ name: 'Landing' });
  const page = doc.pages()[0]!;
  const bridge: BridgeConnection = connectBridge({
    doc,
    url: `ws://127.0.0.1:${p}`,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    activePageId: () => page.id,
    getSelection: () => [],
    retryMs: 50,
  });
  cleanups.push(() => bridge.close());
  await waitFor(() => bridge.status() === 'connected');
  await new Promise((r) => setTimeout(r, 20));
  return { hub, doc, bridge, port: p };
}

describe('bridge client', () => {
  it('runs write_html as agent actor', async () => {
    const { hub, doc } = await setup();
    const { nodeId } = (await hub.request({ method: 'create_artboard', params: { name: 'Hero', styles: { width: '1440px', height: '900px' } }, agent })) as { nodeId: string };
    await hub.request({ method: 'write_html', params: { targetNodeId: nodeId, mode: 'insert-children', html: '<p>Hi</p>' }, agent });
    const entries = doc.log().filter((e) => e.actor.kind === 'agent');
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ actor: { id: 'agent:c1', name: 'Claude Code' }, summary: 'Inserted 1 node' });
    expect(doc.working()[nodeId]).toMatchObject({ id: 'agent:c1' });
  });

  it('doc errors come back with their code', async () => {
    const { hub } = await setup();
    await expect(hub.request({ method: 'get_node_info', params: { nodeId: 'nope' }, agent })).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('reconnects after hub restart', async () => {
    const { hub, bridge, port: p } = await setup();
    await hub.close();
    await waitFor(() => bridge.status() === 'offline');
    const again = await startHub(p);
    cleanups.push(() => again.close());
    await waitFor(() => bridge.status() === 'connected');
    await new Promise((r) => setTimeout(r, 20));
    await expect(again.request({ method: 'get_basic_info', params: {}, agent })).resolves.toMatchObject({ fileName: 'Landing' });
  });
});
