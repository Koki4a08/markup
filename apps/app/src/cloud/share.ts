import { useSyncExternalStore } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MarkupDoc } from '@markup/doc';
import type { Workspace } from '../workspace/Workspace';
import { sharedAccount, sharedCloudClient, subscribeAccount } from './account';
import type { CloudConfig } from './config';
import { CLOUD_ORIGIN } from './sync';

/**
 * View-only share links. A link is a random token; only its SHA-256 is stored (share_links), and
 * the token itself stays on the device that made it, so the link can be copied again there.
 * Anyone with the link sees markup.here/s/#<token>: a picture of every artboard, rendered here and
 * uploaded as the file's "preview" through the share function. While a file has a link on, edits
 * re-render the preview after a quiet moment, so the link stays current.
 */

export type ShareExpiry = 'never' | '7d' | '30d';

export interface ShareLinkRow {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ShareLink extends ShareLinkRow {
  /** The full link, when it was made on this device; null when it was made elsewhere. */
  url: string | null;
}

export class ShareError extends Error {
  constructor(
    readonly code: 'quota_exceeded' | 'too_large' | 'not_in_cloud' | 'auth' | 'network' | 'server',
    message: string,
  ) {
    super(message);
  }
}

/** Everything the engine needs from the server, narrowed so tests can fake it. */
export interface ShareApi {
  /** The cloud row id (cloud_files.id) of a file kept in the cloud, or null. */
  fileRow(fileId: string): Promise<string | null>;
  /** Every link of a cloud file, on or off. */
  links(rowId: string): Promise<ShareLinkRow[]>;
  /** Local ids of files with at least one link that is on and not expired. */
  sharedFiles(): Promise<string[]>;
  /** When the file's shared view was last uploaded, or null. */
  previewAt(rowId: string): Promise<string | null>;
  create(rowId: string, tokenHash: string, expiresAt: string | null): Promise<ShareLinkRow>;
  revoke(linkId: string): Promise<void>;
  /** Resolves to the preview's new updated_at. */
  uploadPreview(fileId: string, bytes: Uint8Array): Promise<string>;
  removePreview(fileId: string): Promise<void>;
}

export interface FileShare {
  /** True until the first load of this file's links finished. */
  loading: boolean;
  /** Links that are on and not expired, newest first. */
  links: ShareLink[];
  preview: 'idle' | 'pending' | 'updating' | 'failed';
  previewAt: string | null;
  /** The last thing that went wrong, for the share menu. */
  error: string | null;
}

const EMPTY: FileShare = { loading: true, links: [], preview: 'idle', previewAt: null, error: null };

export interface ShareSyncOptions {
  api: ShareApi;
  workspace: Workspace;
  userId: string;
  siteUrl: string;
  /** Renders a file's shared view (renderSharePreview); injected so tests need no DOM renderer. */
  render(doc: MarkupDoc): Promise<Uint8Array>;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Quiet time after the last edit before the shared view is rendered again. */
  debounceMs?: number;
  now?: () => number;
}

export interface ShareSync {
  get(fileId: string): FileShare;
  load(fileId: string): Promise<void>;
  /** Makes a view-only link and renders the shared view; resolves to the link. */
  create(fileId: string, expiry: ShareExpiry): Promise<string>;
  revoke(fileId: string, linkId: string): Promise<void>;
  /** Renders and uploads the shared view now (the file must be open). */
  publish(fileId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

const DAY = 86_400_000;

export function expiryDate(expiry: ShareExpiry, now: number): string | null {
  if (expiry === 'never') return null;
  return new Date(now + (expiry === '7d' ? 7 : 30) * DAY).toISOString();
}

export function shareUrl(siteUrl: string, token: string): string {
  return `${siteUrl.replace(/\/+$/, '')}/s/#${token}`;
}

/** 32 random bytes, base64url without padding (43 characters). */
export function newShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Backing = Pick<Storage, 'getItem' | 'setItem'>;

function persisted<T>(backing: Backing | null, key: string) {
  let value: Record<string, T> = {};
  try {
    const raw = backing?.getItem(key);
    if (raw) value = JSON.parse(raw) as Record<string, T>;
  } catch {
    value = {};
  }
  const save = () => {
    try {
      backing?.setItem(key, JSON.stringify(value));
    } catch {
      // Storage blocked: remembered for this run only.
    }
  };
  return {
    get: (k: string) => value[k],
    has: (k: string) => k in value,
    set(k: string, v: T) {
      value[k] = v;
      save();
    },
    delete(k: string) {
      if (!(k in value)) return;
      delete value[k];
      save();
    },
  };
}

const message = (err: unknown) => (err instanceof Error && err.message ? err.message : 'Something went wrong. Try again.');

export function createShareSync(opts: ShareSyncOptions): ShareSync {
  const { api, workspace, userId } = opts;
  const now = opts.now ?? Date.now;
  const backing = opts.storage === undefined ? safeStorage() : opts.storage;
  /** Link id → token, for links made on this device. */
  const tokens = persisted<string>(backing, `markup:share-tokens:${userId}`);
  /** Shared files edited since their view was last uploaded (survives a restart). */
  const dirty = persisted<true>(backing, `markup:share-dirty:${userId}`);
  const files = new Map<string, FileShare>();
  const shared = new Set<string>();
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queues = new Map<string, Promise<void>>();
  const watched = new Map<MarkupDoc, () => void>();
  let disposed = false;

  const emit = () => listeners.forEach((l) => l());
  const get = (fileId: string) => files.get(fileId) ?? EMPTY;
  const patch = (fileId: string, change: Partial<FileShare>) => {
    files.set(fileId, { ...get(fileId), ...change });
    emit();
  };
  const isOn = (l: ShareLinkRow) => !l.revokedAt && (!l.expiresAt || Date.parse(l.expiresAt) > now());
  const view = (l: ShareLinkRow): ShareLink => {
    const token = tokens.get(l.id);
    return { ...l, url: token ? shareUrl(opts.siteUrl, token) : null };
  };

  /** One render or upload per file at a time. */
  const serial = (fileId: string, step: () => Promise<void>) => {
    const next = (queues.get(fileId) ?? Promise.resolve()).then(step, step);
    queues.set(fileId, next);
    return next.finally(() => {
      if (queues.get(fileId) === next) queues.delete(fileId);
    });
  };

  const publish = (fileId: string) =>
    serial(fileId, async () => {
      if (disposed) return;
      const doc = workspace.doc(fileId);
      // Not open: rendered the next time it opens.
      if (!doc) return;
      clearTimeout(timers.get(fileId));
      timers.delete(fileId);
      patch(fileId, { preview: 'updating' });
      // Cleared first: an edit made while rendering marks it again.
      dirty.delete(fileId);
      try {
        const bytes = await opts.render(doc);
        const at = await api.uploadPreview(fileId, bytes);
        patch(fileId, { preview: 'idle', previewAt: at, error: null });
      } catch (err) {
        dirty.set(fileId, true);
        patch(fileId, { preview: 'failed', error: message(err) });
        throw err;
      }
    });

  const schedule = (fileId: string) => {
    clearTimeout(timers.get(fileId));
    if (get(fileId).preview !== 'updating') patch(fileId, { preview: 'pending' });
    timers.set(
      fileId,
      setTimeout(() => {
        timers.delete(fileId);
        void publish(fileId).catch(() => undefined);
      }, opts.debounceMs ?? 15_000),
    );
  };

  // Open files with a link on: edits (not merges from the cloud) re-render the shared view.
  const watchDocs = () => {
    const open = new Set<MarkupDoc>();
    for (const tab of workspace.tabs()) {
      const doc = workspace.doc(tab.fileId);
      if (doc) open.add(doc);
    }
    for (const [doc, off] of watched) {
      if (open.has(doc)) continue;
      off();
      watched.delete(doc);
    }
    for (const doc of open) {
      if (watched.has(doc)) continue;
      const onUpdate = (_update: Uint8Array, origin: unknown) => {
        if (origin === CLOUD_ORIGIN || !shared.has(doc.fileId)) return;
        dirty.set(doc.fileId, true);
        schedule(doc.fileId);
      };
      doc.ydoc.on('update', onUpdate);
      watched.set(doc, () => doc.ydoc.off('update', onUpdate));
      if (shared.has(doc.fileId) && dirty.has(doc.fileId)) schedule(doc.fileId);
    }
  };
  const offWorkspace = workspace.on('change', watchDocs);
  watchDocs();

  void api.sharedFiles().then(
    (ids) => {
      if (disposed) return;
      for (const id of ids) shared.add(id);
      watchDocs();
      for (const id of ids) if (dirty.has(id) && workspace.doc(id)) schedule(id);
    },
    () => undefined,
  );

  return {
    get,

    async load(fileId) {
      try {
        const rowId = await api.fileRow(fileId);
        if (!rowId) {
          shared.delete(fileId);
          patch(fileId, { loading: false, links: [], previewAt: null, error: null });
          return;
        }
        const [rows, previewAt] = await Promise.all([api.links(rowId), api.previewAt(rowId)]);
        const on = rows.filter(isOn).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (on.length) shared.add(fileId);
        else shared.delete(fileId);
        patch(fileId, { loading: false, links: on.map(view), previewAt, error: null });
      } catch (err) {
        patch(fileId, { loading: false, error: message(err) });
      }
    },

    async create(fileId, expiry) {
      const rowId = await api.fileRow(fileId);
      if (!rowId) throw new ShareError('not_in_cloud', 'Keep this file in the cloud to share it.');
      const token = newShareToken();
      const row = await api.create(rowId, await sha256Hex(token), expiryDate(expiry, now()));
      tokens.set(row.id, token);
      shared.add(fileId);
      patch(fileId, { loading: false, links: [view(row), ...get(fileId).links], error: null });
      // The link opens once its view is uploaded; render it now, from the current file. A failure
      // shows in the menu with a retry; the link itself exists either way.
      await publish(fileId).catch(() => undefined);
      return shareUrl(opts.siteUrl, token);
    },

    async revoke(fileId, linkId) {
      await api.revoke(linkId);
      tokens.delete(linkId);
      const links = get(fileId).links.filter((l) => l.id !== linkId);
      patch(fileId, { links });
      if (links.length) return;
      // No link left: stop updating, and free the storage the view took.
      shared.delete(fileId);
      clearTimeout(timers.get(fileId));
      timers.delete(fileId);
      dirty.delete(fileId);
      try {
        await api.removePreview(fileId);
        patch(fileId, { preview: 'idle', previewAt: null });
      } catch {
        // Removed with the file, or on the next unshare.
      }
    },

    publish,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      disposed = true;
      offWorkspace();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const off of watched.values()) off();
      watched.clear();
      listeners.clear();
    },
  };
}

function safeStorage(): Backing | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The ShareApi: rows under RLS in Supabase; the shared view through the share function. */
export function supabaseShareApi(supabase: SupabaseClient, config: CloudConfig): ShareApi {
  async function callShare(method: 'POST' | 'DELETE', fileId: string, body?: Uint8Array): Promise<Response> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new ShareError('auth', 'Sign in again to share.');
    try {
      return await fetch(`${config.url}/functions/v1/share?file=${encodeURIComponent(fileId)}`, {
        method,
        headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
        body: body ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ShareError('network', 'You are offline. The link updates when you are back online.');
    }
  }

  async function errorFrom(res: Response): Promise<ShareError> {
    const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    const code = body?.error;
    const text = typeof body?.message === 'string' ? body.message : `Sharing failed (${res.status}).`;
    if (code === 'quota_exceeded' || code === 'too_large' || code === 'not_in_cloud') return new ShareError(code, text);
    if (res.status === 401) return new ShareError('auth', 'Sign in again to share.');
    return new ShareError('server', text);
  }

  const fail = (error: { message: string } | null) => {
    if (error) throw new ShareError('network', error.message || 'Could not reach Markup. Check your connection.');
  };
  const toRow = (r: Record<string, unknown>): ShareLinkRow => ({
    id: String(r.id),
    createdAt: String(r.created_at),
    expiresAt: (r.expires_at as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
  });

  return {
    async fileRow(fileId) {
      const { data, error } = await supabase.from('cloud_files').select('id').eq('file_id', fileId).is('deleted_at', null).maybeSingle();
      fail(error);
      return (data?.id as string | undefined) ?? null;
    },
    async links(rowId) {
      const { data, error } = await supabase.from('share_links').select('id, created_at, expires_at, revoked_at').eq('file_id', rowId).eq('role', 'view');
      fail(error);
      return (data ?? []).map(toRow);
    },
    async sharedFiles() {
      const { data, error } = await supabase.from('share_links').select('expires_at, cloud_files!inner(file_id, deleted_at)').is('revoked_at', null);
      fail(error);
      const at = Date.now();
      const ids = new Set<string>();
      for (const r of (data ?? []) as Record<string, unknown>[]) {
        const file = (Array.isArray(r.cloud_files) ? r.cloud_files[0] : r.cloud_files) as { file_id?: string; deleted_at?: string | null } | undefined;
        if (!file?.file_id || file.deleted_at) continue;
        if (typeof r.expires_at === 'string' && Date.parse(r.expires_at) <= at) continue;
        ids.add(file.file_id);
      }
      return [...ids];
    },
    async previewAt(rowId) {
      const { data, error } = await supabase.from('share_previews').select('updated_at').eq('file_id', rowId).maybeSingle();
      fail(error);
      return (data?.updated_at as string | undefined) ?? null;
    },
    async create(rowId, tokenHash, expiresAt) {
      const { data, error } = await supabase
        .from('share_links')
        .insert({ file_id: rowId, token_hash: tokenHash, role: 'view', expires_at: expiresAt })
        .select('id, created_at, expires_at, revoked_at')
        .single();
      fail(error);
      return toRow(data as Record<string, unknown>);
    },
    async revoke(linkId) {
      const { error } = await supabase.from('share_links').update({ revoked_at: new Date().toISOString() }).eq('id', linkId);
      fail(error);
    },
    async uploadPreview(fileId, bytes) {
      const res = await callShare('POST', fileId, bytes);
      const body = (await res.clone().json().catch(() => null)) as { updated_at?: unknown } | null;
      if (res.ok && typeof body?.updated_at === 'string') return body.updated_at;
      throw await errorFrom(res);
    },
    async removePreview(fileId) {
      const res = await callShare('DELETE', fileId);
      if (!res.ok) throw await errorFrom(res);
    },
  };
}

// ── The running engine, following the account ──

let current: ShareSync | null = null;
let version = 0;
const sharedListeners = new Set<() => void>();
const bump = () => {
  version++;
  sharedListeners.forEach((l) => l());
};

/** The running engine; re-renders on any share change. Null when signed out or in builds without accounts. */
export function useShareSync(): ShareSync | null {
  useSyncExternalStore(
    (l) => {
      sharedListeners.add(l);
      return () => sharedListeners.delete(l);
    },
    () => version,
  );
  return current;
}

/** Runs share links while signed in; stops on sign-out (links keep working, nothing re-renders). */
export function startShareSync(workspace: Workspace): () => void {
  let unrelay: (() => void) | undefined;
  let user: string | null = null;
  const follow = () => {
    const state = sharedAccount()?.getState();
    const cloud = sharedCloudClient();
    const userId = state?.status === 'signedIn' && cloud ? state.user.id : null;
    if (userId === user) return;
    unrelay?.();
    current?.dispose();
    current = null;
    user = userId;
    if (userId && cloud) {
      current = createShareSync({
        api: supabaseShareApi(cloud.supabase, cloud.config),
        workspace,
        userId,
        siteUrl: cloud.config.siteUrl,
        render: async (doc) => {
          const { renderSharePreview } = await import('./sharePreview');
          return renderSharePreview(doc, workspace.library.get(doc.fileId)?.name ?? doc.name);
        },
      });
      unrelay = current.subscribe(bump);
    }
    bump();
  };
  follow();
  const offAccount = subscribeAccount(follow);
  return () => {
    offAccount();
    unrelay?.();
    current?.dispose();
    current = null;
    user = null;
    bump();
  };
}
