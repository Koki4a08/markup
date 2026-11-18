import { MarkupError, runDocTool, type Actor, type MarkupDoc } from '@markup/doc';
import { BRIDGE_PORT, DOM_TOOLS, type BridgeErrorCode, type BridgeMessage, type DocToolName, type DomToolName, type RequestMsg, type ResponseMsg } from '@markup/protocol';

export type DomTools = Record<DomToolName, (params: unknown) => unknown | Promise<unknown>>;
export type BridgeStatus = 'connecting' | 'connected' | 'offline';

export interface BridgeOptions {
  doc: MarkupDoc;
  getSelection(): string[];
  activePageId(): string;
  domTools?: Partial<DomTools>;
  url?: string;
  /** Injected for Node tests; the browser global otherwise. */
  WebSocketImpl?: typeof WebSocket;
  retryMs?: number;
  onStatus?(status: BridgeStatus): void;
}

export interface BridgeConnection {
  status(): BridgeStatus;
  close(): void;
}

const WRITE_TOOLS = new Set(['create_artboard', 'write_html', 'update_styles', 'set_text_content', 'duplicate_nodes', 'move_nodes', 'delete_nodes', 'rename_nodes']);

/** Artboards an agent call touches, so their working indicator turns on. */
function touchedArtboards(doc: MarkupDoc, method: string, params: Record<string, unknown>, result: unknown): string[] {
  const ids: string[] = [];
  if (method === 'create_artboard') ids.push((result as { nodeId: string }).nodeId);
  if (method === 'write_html') ids.push(...((result as { nodeIds: string[] }).nodeIds ?? []));
  if (method === 'update_styles') ids.push(...(params.updates as { nodeIds: string[] }[]).flatMap((u) => u.nodeIds));
  if (method === 'set_text_content' || method === 'rename_nodes') ids.push(...(params.updates as { nodeId: string }[]).map((u) => u.nodeId));
  if (method === 'duplicate_nodes') ids.push(...(result as { newId: string }[]).map((r) => r.newId));
  if (method === 'move_nodes') ids.push(...(params.moves as { nodeId: string }[]).map((m) => m.nodeId));
  const artboards = new Set<string>();
  for (const id of ids) {
    if (!doc.getNode(id)) continue;
    const artboard = doc.artboardOf(id);
    if (artboard) artboards.add(artboard);
  }
  return [...artboards];
}

/** Connects this editor window to the local `markup mcp` hub and answers agent tool calls. */
export function connectBridge(opts: BridgeOptions): BridgeConnection {
  const WS = opts.WebSocketImpl ?? WebSocket;
  const url = opts.url ?? `ws://127.0.0.1:${BRIDGE_PORT}`;
  const clientId = `editor-${opts.doc.fileId}-${Math.random().toString(36).slice(2, 8)}`;
  const agents = new Map<string, Actor>();
  let ws: WebSocket | null = null;
  let status: BridgeStatus = 'connecting';
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (s: BridgeStatus) => {
    status = s;
    opts.onStatus?.(s);
  };

  const actorFor = (agent: RequestMsg['agent']): Actor => {
    let actor = agents.get(agent.clientId);
    if (!actor || actor.name !== agent.name) {
      actor = { id: `agent:${agent.clientId}`, kind: 'agent', name: agent.name };
      agents.set(agent.clientId, actor);
    }
    return actor;
  };

  const handle = async (msg: RequestMsg): Promise<ResponseMsg> => {
    try {
      const actor = actorFor(msg.agent);
      const params = (msg.params ?? {}) as Record<string, unknown>;
      let result: unknown;
      if ((DOM_TOOLS as readonly string[]).includes(msg.method)) {
        const tool = opts.domTools?.[msg.method as DomToolName];
        if (!tool) throw new MarkupError('INVALID_ARGUMENT', `${msg.method} needs the editor canvas, which is not available here.`);
        result = await tool(params);
      } else {
        result = runDocTool(opts.doc, actor, msg.method as DocToolName, params, { activePageId: opts.activePageId() });
        if (WRITE_TOOLS.has(msg.method)) {
          const artboards = touchedArtboards(opts.doc, msg.method, params, result);
          if (artboards.length) opts.doc.setWorking(actor, artboards, true);
        }
      }
      return { type: 'response', id: msg.id, ok: true, result };
    } catch (err) {
      const code = (err instanceof MarkupError ? err.code : 'INTERNAL') as BridgeErrorCode;
      return { type: 'response', id: msg.id, ok: false, error: { code, message: (err as Error).message } };
    }
  };

  const connect = () => {
    if (closed) return;
    setStatus('connecting');
    const socket = new WS(url);
    ws = socket;
    socket.onopen = () => {
      const hello: BridgeMessage = { type: 'hello', role: 'editor', clientId, app: 'markup', files: [{ fileId: opts.doc.fileId, name: opts.doc.name, active: true }] };
      socket.send(JSON.stringify(hello));
      setStatus('connected');
    };
    socket.onmessage = (event) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(String(event.data)) as BridgeMessage;
      } catch {
        return;
      }
      if (msg.type !== 'request') return;
      void handle(msg).then((res) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(res)));
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      setStatus('offline');
      if (!closed) retry = setTimeout(connect, opts.retryMs ?? 2000);
    };
    socket.onerror = () => {
      // onclose follows and schedules the retry.
    };
  };

  connect();

  return {
    status: () => status,
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
      ws = null;
    },
  };
}
