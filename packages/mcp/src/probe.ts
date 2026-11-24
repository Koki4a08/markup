import WebSocket, { WebSocketServer } from 'ws';
import type { BridgeMessage } from '@markup/protocol';
import { isAllowedOrigin } from './hub';

export type BridgeProbe =
  /** An editor window connected to the probe; it has this many tabs open. */
  | { state: 'editor'; files: number }
  /** Another `markup mcp` process hosts the hub, so an agent is connected right now. */
  | { state: 'agent' }
  /** Nothing answered: Markup is closed, or it has not retried yet. */
  | { state: 'none' }
  | { state: 'blocked'; message: string };

/**
 * Finds out whether Markup is open without an agent: hosts the hub for a moment and waits for an
 * editor window to register (editors retry every 2 s). If the port is taken, checks that a Markup
 * hub owns it.
 */
export function probeBridge(port: number, waitMs = 2600): Promise<BridgeProbe> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port, verifyClient: (info: { origin?: string }) => isAllowedOrigin(info.origin) });
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (result: BridgeProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve(result));
    };
    wss.once('error', (err: NodeJS.ErrnoException) => {
      settled = true;
      if (err.code === 'EADDRINUSE') void askHub(port).then(resolve);
      else resolve({ state: 'blocked', message: err.code === 'EACCES' ? `Port ${port} is reserved by the system.` : err.message });
    });
    wss.once('listening', () => {
      timer = setTimeout(() => finish({ state: 'none' }), waitMs);
    });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'hello', role: 'hub', clientId: 'hub', app: 'markup' } satisfies BridgeMessage));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as BridgeMessage;
          if (msg.type === 'hello' && msg.role === 'editor') finish({ state: 'editor', files: msg.files?.length ?? 0 });
        } catch {
          // not a bridge message
        }
      });
    });
  });
}

function askHub(port: number): Promise<BridgeProbe> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const done = (result: BridgeProbe) => {
      clearTimeout(timer);
      ws.terminate();
      resolve(result);
    };
    const foreign = { state: 'blocked', message: `Port ${port} is used by another program.` } as const;
    const timer = setTimeout(() => done(foreign), 1500);
    ws.on('error', () => done(foreign));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as BridgeMessage;
        done(msg.type === 'hello' && msg.role === 'hub' && msg.app === 'markup' ? { state: 'agent' } : foreign);
      } catch {
        done(foreign);
      }
    });
  });
}
