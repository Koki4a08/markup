import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { BridgeMessage, FileInfo } from '@markup/protocol';
import { connectOrHost, startHub, type Hub } from '../src/hub';

const agent = { clientId: 'agent-1', name: 'Test Agent' };
let nextPort = 39100 + Math.floor(Math.random() * 500);
const freePort = () => nextPort++;

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A fake editor: says hello with its files and answers every request with { echo }. */
async function fakeEditor(port: number, files: FileInfo[], opts: { respond?: boolean } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.once('open', r));
  const received: BridgeMessage[] = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as BridgeMessage;
    received.push(msg);
    if (msg.type === 'request' && opts.respond !== false) {
      ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result: { echo: msg.method, fileId: files[0]?.fileId } }));
    }
  });
  ws.send(JSON.stringify({ type: 'hello', role: 'editor', clientId: `editor-${files[0]?.fileId}`, app: 'markup', files }));
  await new Promise((r) => setTimeout(r, 30));
  cleanups.push(() => ws.close());
  return { ws, received };
}

async function hub(port: number, timeoutMs?: number): Promise<Hub> {
  const h = await startHub(port, { timeoutMs });
  cleanups.push(() => h.close());
  return h;
}

describe('hub', () => {
  it('routes request to editor with active file', async () => {
    const port = freePort();
    const h = await hub(port);
    await fakeEditor(port, [{ fileId: 'f1', name: 'A', active: true }]);
    await expect(h.request({ method: 'get_basic_info', params: {}, agent })).resolves.toEqual({ echo: 'get_basic_info', fileId: 'f1' });
  });

  it('routes by fileId when two editors are connected', async () => {
    const port = freePort();
    const h = await hub(port);
    await fakeEditor(port, [{ fileId: 'f1', name: 'A', active: true }]);
    await fakeEditor(port, [{ fileId: 'f2', name: 'B', active: false }]);
    await expect(h.request({ fileId: 'f2', method: 'get_basic_info', params: {}, agent })).resolves.toMatchObject({ fileId: 'f2' });
  });

  it('unknown fileId gives FILE_NOT_OPEN', async () => {
    const port = freePort();
    const h = await hub(port);
    await fakeEditor(port, [{ fileId: 'f1', name: 'A', active: true }]);
    await expect(h.request({ fileId: 'zz', method: 'get_basic_info', params: {}, agent })).rejects.toMatchObject({ code: 'FILE_NOT_OPEN' });
  });

  it('no editor gives NO_EDITOR', async () => {
    const h = await hub(freePort());
    await expect(h.request({ method: 'get_basic_info', params: {}, agent })).rejects.toMatchObject({ code: 'NO_EDITOR', message: expect.stringContaining('Open Markup') });
  });

  it('editor disconnect mid-request gives EDITOR_DISCONNECTED', async () => {
    const port = freePort();
    const h = await hub(port);
    const editor = await fakeEditor(port, [{ fileId: 'f1', name: 'A', active: true }], { respond: false });
    const pending = h.request({ method: 'get_basic_info', params: {}, agent });
    await new Promise((r) => setTimeout(r, 30));
    editor.ws.close();
    await expect(pending).rejects.toMatchObject({ code: 'EDITOR_DISCONNECTED' });
  });

  it('timeout gives TIMEOUT', async () => {
    const port = freePort();
    const h = await hub(port, 50);
    await fakeEditor(port, [{ fileId: 'f1', name: 'A', active: true }], { respond: false });
    await expect(h.request({ method: 'get_basic_info', params: {}, agent })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('second process relays through first hub', async () => {
    const port = freePort();
    const first = await connectOrHost(port);
    cleanups.push(() => first.close());
    const second = await connectOrHost(port);
    cleanups.push(() => second.close());
    expect(first.role).toBe('host');
    expect(second.role).toBe('relay');
    const editor = await fakeEditor(port, [{ fileId: 'f1', name: 'A', active: true }]);
    await expect(second.request({ method: 'get_jsx', params: { nodeId: 'n' }, agent })).resolves.toEqual({ echo: 'get_jsx', fileId: 'f1' });
    const req = editor.received.find((m) => m.type === 'request');
    expect(req).toMatchObject({ method: 'get_jsx', params: { nodeId: 'n' }, agent });
  });

  it('foreign port owner', async () => {
    const port = freePort();
    const sockets: net.Socket[] = [];
    const server = net.createServer((s) => sockets.push(s));
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => (sockets.forEach((s) => s.destroy()), server.close(r))));
    await expect(connectOrHost(port, { handshakeMs: 200 })).rejects.toThrow(`Port ${port} is in use by another program`);
  });
});
