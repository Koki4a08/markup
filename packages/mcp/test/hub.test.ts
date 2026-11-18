import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { BridgeMessage, FileInfo } from '@markup/protocol';
import { connectOrHost, resilientHub, startHub, type Hub } from '../src/hub';

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

async function hub(port: number, timeoutMs?: number, editorWaitMs = 0): Promise<Hub> {
  const h = await startHub(port, { timeoutMs, editorWaitMs });
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

  it('rejects browser origins that are not the Markup editor', async () => {
    const port = freePort();
    await hub(port);
    const evil = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://evil.example' });
    const outcome = await new Promise<string>((r) => {
      evil.once('open', () => r('open'));
      evil.once('error', () => r('rejected'));
    });
    expect(outcome).toBe('rejected');
  });

  it('accepts the desktop and dev editor origins', async () => {
    const port = freePort();
    await hub(port);
    for (const origin of ['http://tauri.localhost', 'tauri://localhost', 'http://localhost:5173']) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
      const outcome = await new Promise<string>((r) => {
        ws.once('open', () => r('open'));
        ws.once('error', () => r('rejected'));
      });
      ws.close();
      expect(outcome, origin).toBe('open');
    }
  });

  it('a call made just before the editor connects waits for it', async () => {
    const port = freePort();
    const h = await hub(port, undefined, 2000);
    const pending = h.request({ method: 'get_basic_info', params: {}, agent });
    setTimeout(() => void fakeEditor(port, [{ fileId: 'f1', name: 'A', active: true }]), 150);
    await expect(pending).resolves.toMatchObject({ echo: 'get_basic_info' });
  });

  it('resilientHub keeps the hub it was given', async () => {
    const port = freePort();
    const first = await connectOrHost(port);
    const resilient = resilientHub(port, {}, first);
    cleanups.push(() => resilient.close());
    await fakeEditor(port, [{ fileId: 'f1', name: 'A', active: true }]);
    await expect(resilient.request({ method: 'get_jsx', params: {}, agent })).resolves.toMatchObject({ echo: 'get_jsx' });
  });

  it('relay does not resend a call when the editor closes mid-call', async () => {
    const port = freePort();
    const host = await startHub(port, { editorWaitMs: 0 });
    cleanups.push(() => host.close());
    const relay = resilientHub(port, { editorWaitMs: 0 });
    cleanups.push(() => relay.close());
    const editor = await fakeEditor(port, [{ fileId: 'f1', name: 'A', active: true }], { respond: false });
    const pending = relay.request({ method: 'write_html', params: {}, agent });
    await new Promise((r) => setTimeout(r, 50));
    editor.ws.close();
    await expect(pending).rejects.toMatchObject({ code: 'EDITOR_DISCONNECTED' });
    expect(editor.received.filter((m) => m.type === 'request')).toHaveLength(1);
  });
});
