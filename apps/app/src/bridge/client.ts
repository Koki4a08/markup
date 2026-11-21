import { MarkupError, type Actor, type MarkupDoc } from '@markup/doc';
// Through its own entry: runDocTool pulls in the protocol's zod schemas, which only the lazily loaded bridge needs.
import { runDocTool } from '@markup/doc/tools';
import {
  BRIDGE_PORT,
  DOM_TOOLS,
  EXPORT_TOOLS,
  FONT_TOOLS,
  RESOURCE_TOOLS,
  parseMarkupLink,
  type BridgeErrorCode,
  type BridgeMessage,
  type DocToolName,
  type DomToolName,
  type ExportToolName,
  type FileInfo,
  type FontToolName,
  type RequestMsg,
  type ResourceToolName,
  type ResponseMsg,
} from '@markup/protocol';
import { archivedFileError, type Workspace } from '../workspace/Workspace';
import { runExportTool } from './exportTools';
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
  /** How long after an agent's last write its working indicator clears on its own. */
  workingIdleMs?: number;
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
const isExportTool = (method: string): method is ExportToolName => (EXPORT_TOOLS as readonly string[]).includes(method);
const isDomTool = (method: string): method is DomToolName => (DOM_TOOLS as readonly string[]).includes(method);

/** An agent that has not written for this long is treated as done, even if it never called finish_working_on_nodes. */
const WORKING_IDLE_MS = 45_000;

const WRITE_TOOLS = new Set(['create_artboard', 'write_html', 'update_styles', 'set_text_content', 'duplicate_nodes', 'move_nodes', 'delete_nodes', 'rename_nodes']);

type Params = Record<string, unknown>;

/**
 * Replaces markup:// links the user copied (Copy link) with the ids they name, and reports the file the first
 * node link points at, so a request without a fileId runs against that file.
 */
export function resolveLinks(method: string, params: Params): { params: Params; fileId?: string } {
  let fileId: string | undefined;
  const node = (v: unknown): unknown => {
    const link = typeof v === 'string' ? parseMarkupLink(v) : null;
    if (!link?.nodeId) return v;
    fileId ??= link.fileId;
    return link.nodeId;
  };
  const file = (v: unknown): unknown => (typeof v === 'string' ? (parseMarkupLink(v)?.fileId ?? v) : v);
  const nodes = (v: unknown) => (Array.isArray(v) ? v.map(node) : v);
  const each = (v: unknown, fix: (item: Params) => Params) => (Array.isArray(v) ? v.map((item) => (item && typeof item === 'object' ? fix(item as Params) : item)) : v);
  const fields = (item: Params, keys: string[]) => {
    const out = { ...item };
    for (const k of keys) if (k in out) out[k] = node(out[k]);
    return out;
  };

  const out: Params = fields(params, ['nodeId', 'targetNodeId', 'parentId']);
  if ('nodeIds' in out) out.nodeIds = nodes(out.nodeIds);
  if (Array.isArray(out.resourceIds)) out.resourceIds = out.resourceIds.map(file);
  if (method === 'export' && out.nodes && typeof out.nodes === 'object' && !Array.isArray(out.nodes)) {
    out.nodes = Object.fromEntries(Object.entries(out.nodes as Params).map(([k, v]) => [node(k) as string, v]));
  }
  if (method === 'move_nodes') out.moves = each(out.moves, (m) => fields(m, ['nodeId', 'before', 'after', 'parentId']));
  if (method === 'duplicate_nodes') out.nodes = each(out.nodes, (n) => fields(n, ['id', 'parentId']));
  if (method === 'update_styles') out.updates = each(out.updates, (u) => ({ ...u, nodeIds: nodes(u.nodeIds) }));
  if (method === 'set_text_content' || method === 'rename_nodes') out.updates = each(out.updates, (u) => fields(u, ['nodeId']));
  // open_file reads page links itself; routed tools take the plain file id.
  if (typeof out.fileId === 'string' && method !== 'open_file') out.fileId = file(out.fileId);
  return { params: out, fileId };
}

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
  let reported = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;

  // Reports only real changes, so a hub that is not running does not re-render the app every retry.
  const setStatus = (s: BridgeStatus) => {
    if (reported && s === status) return;
    reported = true;
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
    if (target && workspace.isArchived(target)) throw archivedFileError(target);
    const doc = target ? workspace.doc(target) : undefined;
    if (target && doc) return { fileId: target, doc };
    if (fileId) throw new BridgeFailure('FILE_NOT_OPEN', `File ${fileId} is not open in Markup. Call open_file with its ID first; list_resources lists files.`);
    throw new BridgeFailure('FILE_NOT_OPEN', 'No file is open in Markup. Call list_resources, then open_file.');
  };

  /** Docs of every open tab. */
  const openDocs = () => workspace.tabs().flatMap((t) => workspace.doc(t.fileId) ?? []);

  /** Drops an agent's working indicators in every open file (or only these artboards). */
  const release = (actor: Actor, artboardIds?: string[]) => {
    for (const doc of openDocs()) {
      const mine = Object.entries(doc.working()).filter(([id, a]) => a.id === actor.id && (!artboardIds || artboardIds.includes(id)));
      if (mine.length) doc.setWorking(actor, mine.map(([id]) => id), false);
    }
  };

  // Agents that stop writing without calling finish_working_on_nodes (or whose session ends) lose the indicator.
  const idle = new Map<string, ReturnType<typeof setTimeout>>();
  const keepWorking = (actor: Actor) => {
    clearTimeout(idle.get(actor.id));
    idle.set(
      actor.id,
      setTimeout(() => {
        idle.delete(actor.id);
        release(actor);
      }, opts.workingIdleMs ?? WORKING_IDLE_MS),
    );
  };
  const releaseAll = () => {
    for (const t of idle.values()) clearTimeout(t);
    idle.clear();
    for (const doc of openDocs()) doc.clearWorking();
  };

  const handle = async (msg: RequestMsg): Promise<ResponseMsg> => {
    try {
      const actor = actorFor(msg.agent);
      const resolved = resolveLinks(msg.method, (msg.params ?? {}) as Params);
      const params = resolved.params;
      const routedFileId = msg.fileId ? (parseMarkupLink(msg.fileId)?.fileId ?? msg.fileId) : ((params.fileId as string | undefined) ?? resolved.fileId);
      let result: unknown;
      // Any call (screenshots and reads too) shows an agent that is still at work.
      if (idle.has(actor.id) && msg.method !== 'finish_working_on_nodes') keepWorking(actor);
      if (msg.method === 'finish_working_on_nodes') {
        // Not routed to one tab: the agent may have worked in a file that is no longer in the foreground.
        const nodeIds = params.nodeIds as string[] | undefined;
        release(actor, nodeIds);
        if (!nodeIds) {
          clearTimeout(idle.get(actor.id));
          idle.delete(actor.id);
        }
        result = { released: nodeIds ?? 'all' };
      } else if (isResourceTool(msg.method)) {
        result = await runResourceTool(workspace, msg.method, params, { actor });
      } else if (isFontTool(msg.method)) {
        result = await runFontTool(params);
      } else {
        const { fileId, doc } = route(routedFileId);
        if (isDomTool(msg.method)) {
          const tool = opts.domTools?.(fileId)?.[msg.method];
          if (!tool) throw new MarkupError('INVALID_ARGUMENT', `${msg.method} needs the file on screen. Call open_file with ${fileId} to bring its tab to the foreground, then retry.`);
          result = await tool(params);
        } else if (isExportTool(msg.method)) {
          // Renders off-screen, so background tabs and pages the user is not viewing export too.
          result = await runExportTool(doc, msg.method, params, { activePageId: workspace.activePageId(fileId) });
        } else {
          result = runDocTool(doc, actor, msg.method as DocToolName, params, { activePageId: workspace.activePageId(fileId), currentUserId: opts.currentUserId ?? 'local-user' });
          if (WRITE_TOOLS.has(msg.method)) {
            const artboards = touchedArtboards(doc, msg.method, params, result);
            if (artboards.length) {
              doc.setWorking(actor, artboards, true);
              keepWorking(actor);
            }
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
    // Automatic retries stay 'offline' until one connects; only the first attempt reports 'connecting'.
    if (status !== 'offline') setStatus('connecting');
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
      // Without the hub no agent can reach this editor, so nobody is editing anymore.
      releaseAll();
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
      releaseAll();
      if (retry) clearTimeout(retry);
      ws?.close();
      ws = null;
    },
  };
}
