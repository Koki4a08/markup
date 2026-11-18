import type { ToolName } from './tools';

/** Localhost port of the hub that connects `markup mcp` processes to editor windows. */
export const BRIDGE_PORT = 29980;
export const REQUEST_TIMEOUT_MS = 30_000;
/** export and export_combined_pdf render and encode large images; they get longer than other calls. */
export const EXPORT_TIMEOUT_MS = 300_000;
/** Largest bridge message; export results carry whole files as base64 (ws defaults to 100 MB). */
export const MAX_PAYLOAD_BYTES = 1024 ** 3;

export interface FileInfo {
  fileId: string;
  name: string;
  active: boolean;
}

export type BridgeErrorCode =
  | 'NO_EDITOR'
  | 'FILE_NOT_OPEN'
  | 'EDITOR_DISCONNECTED'
  | 'TIMEOUT'
  | 'INVALID_PARAMS'
  | 'NODE_NOT_FOUND'
  | 'PAGE_NOT_FOUND'
  | 'INVALID_PARENT'
  | 'CYCLE'
  | 'IS_ROOT'
  | 'INVALID_ORDER'
  | 'TOKEN_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED'
  | 'INTERNAL'
  /** Internal to `markup mcp`: this relay lost its connection to the hosting process. */
  | 'HUB_GONE';

export interface RequestMsg {
  type: 'request';
  id: string;
  fileId?: string;
  method: ToolName;
  params: unknown;
  agent: { clientId: string; name: string };
}

export type ResponseMsg =
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: { code: BridgeErrorCode; message: string } };

export type BridgeMessage =
  | { type: 'hello'; role: 'editor' | 'agent' | 'hub'; clientId: string; app: 'markup'; files?: FileInfo[] }
  | { type: 'files'; files: FileInfo[] }
  | RequestMsg
  | ResponseMsg;

export const NO_EDITOR_MESSAGE = "Markup isn't running with a file open. Open Markup, open a file, then retry.";
