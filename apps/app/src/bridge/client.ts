import { MarkupError, runDocTool, type Actor, type MarkupDoc } from '@markup/doc';
import {
  BRIDGE_PORT,
  DOM_TOOLS,
  FONT_TOOLS,
  RESOURCE_TOOLS,
  type BridgeErrorCode,
  type BridgeMessage,
  type DocToolName,
  type DomToolName,
  type FileInfo,
  type FontToolName,
  type RequestMsg,
  type ResourceToolName,
  type ResponseMsg,
} from '@markup/protocol';
import type { Workspace } from '../workspace/Workspace';
import { runFontTool } from './fontTools';
import { runResourceTool } from './resourceTools';

export type DomTools = Record<DomToolName, (params: unknown) => unknown | Promise<unknown>>;
export type BridgeStatus = 'connecting' | 'connected' | 'offline';

export interface BridgeOptions {
  workspace: Workspace;
  /** DOM tools of the editor showing fileId, while it is on screen. */
  domTools?(fileId: string): Partial<DomTools> | undefined;
  url?: string;
  /** Injected for Node tests; the browser global otherwise. */
  WebSocketImpl?: typeof WebSocket;
  retryMs?: number;
  /** Id of the editor's human actor; "current-user" in comment filters resolves to it. */
  currentUserId?: string;
  onStatus?(status: BridgeStatus): void;
}

export interface BridgeConnection {
  status(): BridgeStatus;
  /** Answers one request; exposed for tests. */
  handle(msg: RequestMsg): Promise<ResponseMsg>;
  close(): void;
}

class BridgeFailure extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const isResourceTool = (method: string): method is ResourceToolName => (RESOURCE_TOOLS as readonly string[]).includes(method);
const isFontTool = (method: string): method is FontToolName => (FONT_TOOLS as readonly string[]).includes(method);
const isDomTool = (method: string): method is DomToolName => (DOM_TOOLS as readonly string[]).includes(method);

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
  const { workspace } = opts;
  const clientId = `editor-${Math.random().toString(36).slice(2, 10)}`;
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

  /** The tab a request targets: its fileId, else the one in the foreground. */
  const route = (fileId: string | undefined): { fileId: string; doc: MarkupDoc } => {
    const target = fileId ?? workspace.activeFileId();
    const doc = target ? workspace.doc(target) : undefined;
    if (target && doc) return { fileId: target, doc };
    if (fileId) throw new BridgeFailure('FILE_NOT_OPEN', `File ${fileId} is not open in Markup. Call open_file with its ID first; list_resources lists files.`);
    throw new BridgeFailure('FILE_NOT_OPEN', 'No file is open in Markup. Call list_resources, then open_file.');
  };

  const handle = async (msg: RequestMsg): Promise<ResponseMsg> => {
    try {
      const actor = actorFor(msg.agent);
      const params = (msg.params ?? {}) as Record<string, unknown>;
      let result: unknown;
      if (isResourceTool(msg.method)) {
        result = await runResourceTool(workspace, msg.method, params, { actor });
      } else if (isFontTool(msg.method)) {
        result = await runFontTool(params);
      } else {
        const { fileId, doc } = route(msg.fileId);
        if (isDomTool(msg.method)) {
          const tool = opts.domTools?.(fileId)?.[msg.method];
          if (!tool) throw new MarkupError('INVALID_ARGUMENT', `${msg.method} needs the file on screen. Call open_file with ${fileId} to bring its tab to the foreground, then retry.`);
          result = await tool(params);
        } else {
          result = runDocTool(doc, actor, msg.method as DocToolName, params, { activePageId: workspace.activePageId(fileId), currentUserId: opts.currentUserId ?? 'local-user' });
          if (WRITE_TOOLS.has(msg.method)) {
            const artboards = touchedArtboards(doc, msg.method, params, result);
            if (artboards.length) doc.setWorking(actor, artboards, true);
          }
        }
      }
      return { type: 'response', id: msg.id, ok: true, result };
    } catch (err) {
      const code = (err instanceof MarkupError || err instanceof BridgeFailure ? err.code : 'INTERNAL') as BridgeErrorCode;
      return { type: 'response', id: msg.id, ok: false, error: { code, message: (err as Error).message } };
    }
  };

  const connect = () => {
    if (closed) return;
    setStatus('connecting');
    const socket = new WS(url);
    ws = socket;
    socket.onopen = () => {
      lastFiles = JSON.stringify(workspace.tabs());
      const hello: BridgeMessage = { type: 'hello', role: 'editor', clientId, app: 'markup', files: workspace.tabs() };
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

  /** The hub routes by these, so it hears about every tab change. */
  let lastFiles = '';
  const sendFiles = () => {
    const files: FileInfo[] = workspace.tabs();
    const json = JSON.stringify(files);
    if (json === lastFiles || !ws || ws.readyState !== ws.OPEN) return;
    lastFiles = json;
    ws.send(JSON.stringify({ type: 'files', files } satisfies BridgeMessage));
  };
  const offChange = workspace.on('change', sendFiles);

  connect();

  return {
    status: () => status,
    handle,
    close() {
      closed = true;
      offChange();
      if (retry) clearTimeout(retry);
      ws?.close();
      ws = null;
    },
  };
}
