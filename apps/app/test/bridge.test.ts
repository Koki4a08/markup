// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startHub, type Hub } from '@markup/mcp';
import { connectBridge, type BridgeConnection } from '../src/bridge/client';
import { memoryWorkspace } from './memoryWorkspace';

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
  const ws = memoryWorkspace();
  const landing = ws.addFile('Landing');
  const doc = await ws.workspace.open(landing);
  const bridge: BridgeConnection = connectBridge({
    workspace: ws.workspace,
    url: `ws://127.0.0.1:${p}`,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    retryMs: 50,
  });
  cleanups.push(() => bridge.close());
  await waitFor(() => bridge.status() === 'connected');
  await new Promise((r) => setTimeout(r, 20));
  return { hub, doc, bridge, port: p, ...ws };
}

describe('bridge client', () => {
  it('archived files stop taking agent edits and cannot be opened', async () => {
    const { hub, bridge, workspace, library, addFile, doc } = await setup();
    const landing = doc.fileId;
    const pricing = addFile('Pricing');
    await hub.request({ method: 'open_file', params: { fileId: pricing }, agent });
    // Archived from the dashboard: its tab closes and routed calls are refused.
    library.archive([landing]);
    expect(workspace.tabs().map((t) => t.fileId)).toEqual([pricing]);
    const archived = { code: 'FILE_NOT_OPEN', message: expect.stringMatching(/archived.*unarchive_resources/) };
    await expect(hub.request({ fileId: landing, method: 'create_artboard', params: { fileId: landing, name: 'A', styles: { width: '10px', height: '10px' } }, agent })).rejects.toMatchObject(archived);
    await expect(hub.request({ method: 'open_file', params: { fileId: landing }, agent })).rejects.toMatchObject(archived);
    // The editor itself names the reason, even when the hub's tab list is stale.
    const direct = await bridge.handle({ type: 'request', id: 'r1', fileId: landing, method: 'get_basic_info', params: {}, agent });
    expect(direct).toMatchObject({ ok: false, error: { code: 'FILE_NOT_OPEN', message: expect.stringContaining('is archived') } });
    // Archived by an agent.
    await hub.request({ method: 'archive_resources', params: { resourceIds: [pricing] }, agent });
    expect(workspace.tabs()).toEqual([]);
    await expect(hub.request({ fileId: pricing, method: 'get_basic_info', params: { fileId: pricing }, agent })).rejects.toMatchObject(archived);
    // Unarchived files open again.
    await hub.request({ method: 'unarchive_resources', params: { resourceIds: [landing] }, agent });
    await expect(hub.request({ method: 'open_file', params: { fileId: landing }, agent })).resolves.toMatchObject({ fileName: 'Landing' });
  });

  it('runs write_html as agent actor', async () => {
    const { hub, doc } = await setup();
    const { nodeId } = (await hub.request({ method: 'create_artboard', params: { name: 'Hero', styles: { width: '1440px', height: '900px' } }, agent })) as { nodeId: string };
    await hub.request({ method: 'write_html', params: { targetNodeId: nodeId, mode: 'insert-children', html: '<p>Hi</p>' }, agent });
    const entries = doc.log().filter((e) => e.actor.kind === 'agent');
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ actor: { id: 'agent:c1', name: 'Claude Code' }, summary: 'Inserted 1 node' });
    expect(doc.working()[nodeId]).toMatchObject({ id: 'agent:c1' });
  });

  it('resolves markup:// node links to the node and routes by the link file', async () => {
    const { hub, bridge, addFile, doc, workspace } = await setup();
    const pricing = addFile('Pricing');
    await hub.request({ method: 'open_file', params: { fileId: pricing }, agent });
    const page = doc.pages()[0]!;
    if (page.type !== 'page') throw new Error('unreachable');
    const [card] = doc.insertNodes({ id: 'u', kind: 'human', name: 'U' }, page.rootId, [{ type: 'frame', name: 'Card', styles: { width: '10px', height: '10px' } }]);
    const link = `markup://file/${doc.fileId}/node/${card}`;
    // Pricing is in front; the link still reaches Landing.
    const info = await bridge.handle({ type: 'request', id: 'r1', method: 'get_node_info', params: { nodeId: link }, agent });
    expect(info).toMatchObject({ ok: true, result: { id: card, name: 'Card' } });
    // Through the hub, with the fileId the MCP server derives.
    await expect(hub.request({ fileId: doc.fileId, method: 'get_node_info', params: { nodeId: link }, agent })).resolves.toMatchObject({ id: card });
    const styled = await bridge.handle({ type: 'request', id: 'r2', method: 'update_styles', params: { updates: [{ nodeIds: [link], styles: { opacity: 0.5 } }] }, agent });
    expect(styled).toMatchObject({ ok: true });
    expect(doc.requireNode(card!).styles.opacity).toBe(0.5);
    const moved = await bridge.handle({ type: 'request', id: 'r3', method: 'move_nodes', params: { moves: [{ nodeId: link, parentId: `markup://file/${doc.fileId}/node/${page.rootId}` }] }, agent });
    expect(moved).toMatchObject({ ok: true });
    expect(workspace.doc(pricing)).toBeDefined();
  });

  it('a node link to a file that is not open gives FILE_NOT_OPEN', async () => {
    const { bridge, addFile } = await setup();
    const closed = addFile('Closed');
    const res = await bridge.handle({ type: 'request', id: 'r1', method: 'get_node_info', params: { nodeId: `markup://file/${closed}/node/n1` }, agent });
    expect(res).toMatchObject({ ok: false, error: { code: 'FILE_NOT_OPEN', message: expect.stringContaining('open_file') } });
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

  it('routes by fileId across tabs', async () => {
    const { hub, workspace, addFile, doc } = await setup();
    const other = addFile('Pricing');
    await hub.request({ method: 'open_file', params: { fileId: other }, agent });
    await new Promise((r) => setTimeout(r, 30));
    await expect(hub.request({ fileId: doc.fileId, method: 'get_basic_info', params: { fileId: doc.fileId }, agent })).resolves.toMatchObject({ fileName: 'Landing' });
    await expect(hub.request({ fileId: other, method: 'get_basic_info', params: { fileId: other }, agent })).resolves.toMatchObject({ fileName: 'Pricing' });
    // No fileId: the foreground tab, which open_file brought forward.
    await expect(hub.request({ method: 'get_basic_info', params: {}, agent })).resolves.toMatchObject({ fileName: 'Pricing' });
    await hub.request({ fileId: doc.fileId, method: 'create_artboard', params: { fileId: doc.fileId, name: 'A', styles: { width: '10px', height: '10px' } }, agent });
    expect(doc.nodeCount()).toBeGreaterThan(workspace.doc(other)!.nodeCount());
  });

  it('closed file gives FILE_NOT_OPEN mentioning open_file', async () => {
    const { hub, workspace, doc } = await setup();
    workspace.close(doc.fileId);
    await new Promise((r) => setTimeout(r, 30));
    await expect(hub.request({ fileId: doc.fileId, method: 'get_basic_info', params: {}, agent })).rejects.toMatchObject({ code: 'FILE_NOT_OPEN', message: expect.stringContaining('open_file') });
    // Also when the hub still believes the file is open (its files list lags): the editor answers.
    await expect(hub.request({ method: 'get_basic_info', params: {}, agent })).rejects.toMatchObject({ code: 'FILE_NOT_OPEN', message: expect.stringContaining('open_file') });
  });

  it('editor answers FILE_NOT_OPEN itself for a file it no longer has', async () => {
    const { workspace, doc, bridge } = await setup();
    workspace.close(doc.fileId);
    const res = await bridge.handle({ type: 'request', id: 'r1', fileId: doc.fileId, method: 'get_basic_info', params: {}, agent });
    expect(res).toMatchObject({ ok: false, error: { code: 'FILE_NOT_OPEN', message: expect.stringContaining('open_file') } });
  });

  it('files message follows tab changes', async () => {
    const p = port++;
    const seen: unknown[] = [];
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ host: '127.0.0.1', port: p });
    cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
    wss.on('connection', (sock) => sock.on('message', (raw) => seen.push(JSON.parse(String(raw)))));
    const { workspace, addFile } = memoryWorkspace();
    const a = addFile('A');
    const b = addFile('B');
    await workspace.open(a);
    const bridge = connectBridge({ workspace, url: `ws://127.0.0.1:${p}`, WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket, retryMs: 50 });
    cleanups.push(() => bridge.close());
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ type: 'hello', role: 'editor', files: [{ fileId: a, name: 'A', active: true }] });
    await workspace.open(b);
    await waitFor(() => seen.length === 2);
    expect(seen[1]).toEqual({ type: 'files', files: [{ fileId: a, name: 'A', active: false }, { fileId: b, name: 'B', active: true }] });
    workspace.rename(b, 'B2');
    await waitFor(() => seen.length === 3);
    workspace.close(a);
    await waitFor(() => seen.length === 4);
    expect(seen[3]).toEqual({ type: 'files', files: [{ fileId: b, name: 'B2', active: true }] });
  });
});
