import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import {
  BRIDGE_PORT,
  EXPORT_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
  NO_EDITOR_MESSAGE,
  REQUEST_TIMEOUT_MS,
  type BridgeErrorCode,
  type BridgeMessage,
  type FileInfo,
  type RequestMsg,
  type ResponseMsg,
} from '@markup/protocol';

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export type HubRequest = Omit<RequestMsg, 'type' | 'id'>;

export interface Hub {
  readonly role: 'host' | 'relay';
  request(msg: HubRequest): Promise<unknown>;
  close(): Promise<void>;
}

export interface HubOptions {
  timeoutMs?: number;
  /** Timeout for export and export_combined_pdf, which render and encode whole files. */
  exportTimeoutMs?: number;
  handshakeMs?: number;
  /** How long a call waits for an editor to (re)connect before NO_EDITOR. Default 3 s. */
  editorWaitMs?: number;
}

const EDITOR_WAIT_MS = 3000;

interface Pending {
  editor: WebSocket;
  timer: NodeJS.Timeout;
  settle: (res: ResponseMsg) => void;
}

const EXPORT_METHODS = new Set<string>(['export', 'export_combined_pdf']);

/** How long a call may take: exports get their own, longer timeout. */
function timeoutFor(method: string, opts: HubOptions): number {
  return EXPORT_METHODS.has(method) ? (opts.exportTimeoutMs ?? EXPORT_TIMEOUT_MS) : (opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
}

const send = (ws: WebSocket, msg: BridgeMessage) => ws.send(JSON.stringify(msg));
const fail = (id: string, code: BridgeErrorCode, message: string): ResponseMsg => ({ type: 'response', id, ok: false, error: { code, message } });

/**
 * Browsers can open ws://127.0.0.1 from any page, so the hub only accepts connections that
 * carry no Origin (local processes such as other `markup mcp` relays) or come from the Markup
 * editor itself: the Tauri webview or a local dev server. Extra origins: MARKUP_ALLOWED_ORIGINS.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost' || origin === 'https://tauri.localhost') return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  const extra = (process.env.MARKUP_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return extra.includes(origin);
}

/** Hosts the localhost hub: editors register their open files, agents send tool requests. */
export function startHub(port = BRIDGE_PORT, opts: HubOptions = {}): Promise<Hub> {
  const editors = new Map<WebSocket, FileInfo[]>();
  const pending = new Map<string, Pending>();
  const editorWaiters = new Set<() => void>();
  const editorWaitMs = opts.editorWaitMs ?? EDITOR_WAIT_MS;

  /** Resolves once an editor is registered, or after editorWaitMs. */
  const whenEditor = () =>
    new Promise<void>((resolve) => {
      if (editors.size > 0 || editorWaitMs <= 0) return resolve();
      const done = () => {
        clearTimeout(timer);
        editorWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, editorWaitMs);
      editorWaiters.add(done);
    });

  const pickEditor = (fileId: string | undefined): WebSocket | BridgeError => {
    if (editors.size === 0) return new BridgeError('NO_EDITOR', NO_EDITOR_MESSAGE);
    for (const [ws, files] of editors) {
      if (fileId ? files.some((f) => f.fileId === fileId) : files.some((f) => f.active)) return ws;
    }
    // Archiving a file closes its tab, so an archived file lands here too.
    if (fileId) return new BridgeError('FILE_NOT_OPEN', `File ${fileId} is not open in Markup. Open it, or call list_resources/open_file. If it is archived, call unarchive_resources first.`);
    return editors.keys().next().value!;
  };

  const dispatch = async (msg: HubRequest, settle: (res: ResponseMsg) => void) => {
    const id = randomUUID();
    await whenEditor();
    const editor = pickEditor(msg.fileId);
    if (editor instanceof BridgeError) return settle(fail(id, editor.code, editor.message));
    const timeoutMs = timeoutFor(msg.method, opts);
    const timer = setTimeout(() => {
      pending.delete(id);
      settle(fail(id, 'TIMEOUT', `Markup did not answer ${msg.method} within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    pending.set(id, { editor, timer, settle });
    send(editor, { type: 'request', id, ...msg });
  };

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: MAX_PAYLOAD_BYTES, verifyClient: (info: { origin?: string }) => isAllowedOrigin(info.origin) });
    wss.once('error', reject);
    wss.once('listening', () => {
      wss.off('error', reject);
      resolve({
        role: 'host',
        request: (msg) => new Promise((res, rej) => dispatch(msg, (r) => (r.ok ? res(r.result) : rej(new BridgeError(r.error.code, r.error.message))))),
        close: () =>
          new Promise((res) => {
            for (const p of pending.values()) clearTimeout(p.timer);
            for (const client of wss.clients) client.terminate();
            wss.close(() => res());
          }),
      });
    });

    wss.on('connection', (ws) => {
      send(ws, { type: 'hello', role: 'hub', clientId: 'hub', app: 'markup' });
      ws.on('message', (raw) => {
        let msg: BridgeMessage;
        try {
          msg = JSON.parse(String(raw)) as BridgeMessage;
        } catch {
          return;
        }
        if (msg.type === 'hello' && msg.role === 'editor') {
          editors.set(ws, msg.files ?? []);
          for (const wake of [...editorWaiters]) wake();
        }
        else if (msg.type === 'files' && editors.has(ws)) editors.set(ws, msg.files);
        else if (msg.type === 'request') {
          // A relayed request from another `markup mcp` process: answer it under its own id.
          const replyId = msg.id;
          dispatch({ fileId: msg.fileId, method: msg.method, params: msg.params, agent: msg.agent }, (r) => send(ws, { ...r, id: replyId }));
        } else if (msg.type === 'response') {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          p.settle(msg);
        }
      });
      ws.on('close', () => {
        editors.delete(ws);
        for (const [id, p] of pending) {
          if (p.editor !== ws) continue;
          pending.delete(id);
          clearTimeout(p.timer);
          p.settle(fail(id, 'EDITOR_DISCONNECTED', 'Markup closed or reloaded while handling the request. Retry once it is open.'));
        }
      });
    });
  });
}

/** Connects to a hub hosted by another `markup mcp` process; rejects if the port owner is not Markup. */
export function connectRelay(port = BRIDGE_PORT, opts: HubOptions = {}): Promise<Hub> {
  const foreign = new Error(`Port ${port} is in use by another program. Free it, then restart your agent.`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: MAX_PAYLOAD_BYTES });
    const pending = new Map<string, { timer: NodeJS.Timeout; settle: (r: ResponseMsg) => void }>();
    const handshake = setTimeout(() => {
      ws.terminate();
      reject(foreign);
    }, opts.handshakeMs ?? 2000);
    ws.on('error', () => {
      // Before the handshake this means the port owner is not a Markup hub; after it, 'close' follows.
      clearTimeout(handshake);
      reject(foreign);
    });
    ws.on('message', (raw) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(String(raw)) as BridgeMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello' && msg.role === 'hub' && msg.app === 'markup') {
        clearTimeout(handshake);
        send(ws, { type: 'hello', role: 'agent', clientId: randomUUID(), app: 'markup' });
        resolve({
          role: 'relay',
          request: (req) =>
            new Promise((res, rej) => {
              if (ws.readyState !== WebSocket.OPEN) return rej(new BridgeError('HUB_GONE', 'The Markup hub went away.'));
              const id = randomUUID();
              const timeoutMs = timeoutFor(req.method, opts);
              const timer = setTimeout(() => {
                pending.delete(id);
                rej(new BridgeError('TIMEOUT', `Markup did not answer ${req.method} within ${Math.round(timeoutMs / 1000)}s.`));
              }, timeoutMs);
              pending.set(id, { timer, settle: (r) => (r.ok ? res(r.result) : rej(new BridgeError(r.error.code, r.error.message))) });
              send(ws, { type: 'request', id, ...req });
            }),
          close: async () => {
            for (const p of pending.values()) clearTimeout(p.timer);
            ws.close();
          },
        });
      } else if (msg.type === 'response') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.settle(msg);
      }
    });
    ws.on('close', () => {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.settle(fail(id, 'HUB_GONE', 'The Markup hub went away. Retry; the next call reconnects.'));
      }
      pending.clear();
    });
  });
}

/** Hosts the hub if the port is free, otherwise relays through the process that hosts it. */
export async function connectOrHost(port = BRIDGE_PORT, opts: HubOptions = {}): Promise<Hub> {
  try {
    return await startHub(port, opts);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    return connectRelay(port, opts);
  }
}

/** A hub that re-establishes itself (host or relay) when the current one is gone. */
export function resilientHub(port = BRIDGE_PORT, opts: HubOptions = {}, initial?: Hub): Hub {
  let current: Promise<Hub> | null = initial ? Promise.resolve(initial) : null;
  const get = () => (current ??= connectOrHost(port, opts).catch((e) => ((current = null), Promise.reject(e))));
  return {
    role: 'host',
    async request(msg) {
      const hub = await get();
      try {
        return await hub.request(msg);
      } catch (e) {
        // Retry only when this relay lost its link to the hosting process. A forwarded
        // EDITOR_DISCONNECTED may already have been applied, so it is never resent.
        if (e instanceof BridgeError && e.code === 'HUB_GONE') {
          current = null;
          await hub.close();
          return (await get()).request(msg);
        }
        throw e;
      }
    },
    async close() {
      if (current) await (await current).close();
    },
  };
}

