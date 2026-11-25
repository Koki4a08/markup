import { useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MarkupDoc } from '@markup/doc';
import type { Workspace } from '../workspace/Workspace';
import { sharedAccount, sharedCloudClient, subscribeAccount } from './account';
import type { CloudConfig } from './config';

/**
 * Cloud backup and sync, per file and opt-in ("Keep in cloud"). Files stay local-first: the local
 * copy is always the one being edited, and the cloud copy is a Yjs state that every device merges
 * with its own. Yjs merges without conflicts, so two devices editing the same file both keep their
 * changes; at worst one upload is overwritten and the next one (after merging) puts it back.
 *
 * Push: after edits settle, download the cloud copy if it changed since we last saw it, merge it,
 * upload the merged state (through the cloud-files function, which checks the quota and writes to Cloudflare R2).
 * Pull: when a cloud file opens, merge the cloud copy if it changed.
 * New devices: files in the cloud that this device does not have yet are added to Files.
 */

/** Transaction origin of merges from the cloud: not an actor, so it counts as nobody's edit. */
export const CLOUD_ORIGIN = 'cloud';

export type CloudFileStatus = 'syncing' | 'synced' | 'offline' | 'full' | 'too-large';

export interface RemoteFile {
  fileId: string;
  name: string;
  updatedAt: string;
}

export class CloudError extends Error {
  constructor(
    readonly code: 'quota_exceeded' | 'too_large' | 'not_in_cloud' | 'auth' | 'network' | 'server',
    message: string,
  ) {
    super(message);
  }
}

/** Everything the engine needs from the server, narrowed so tests can fake it. */
export interface CloudApi {
  list(): Promise<RemoteFile[]>;
  add(fileId: string, name: string): Promise<void>;
  remove(fileId: string): Promise<void>;
  rename(fileId: string, name: string): Promise<void>;
  /** The cloud copy's version (row updated_at), or null when the file is not in the cloud. */
  version(fileId: string): Promise<string | null>;
  download(fileId: string): Promise<Uint8Array | null>;
  /** Saves the state; resolves to the new version. */
  upload(fileId: string, state: Uint8Array): Promise<string>;
  usage(): Promise<{ used: number; quota: number }>;
}

/** Local storage access for files that are not open. */
export interface LocalFiles {
  read(fileId: string): Promise<Uint8Array | null>;
  merge(fileId: string, state: Uint8Array): Promise<void>;
}

type Backing = Pick<Storage, 'getItem' | 'setItem'>;

/** Small JSON maps in localStorage: versions seen and files with unsaved changes, per user. */
function persistedMap<T>(backing: Backing | null, key: string) {
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
    set(k: string, v: T) {
      value[k] = v;
      save();
    },
    delete(k: string) {
      if (!(k in value)) return;
      delete value[k];
      save();
    },
    keys: () => Object.keys(value),
  };
}

export interface CloudSyncOptions {
  api: CloudApi;
  workspace: Workspace;
  local: LocalFiles;
  userId: string;
  storage?: Backing | null;
  /** Quiet time after the last edit before uploading. */
  debounceMs?: number;
}

export interface CloudSync {
  isInCloud(fileId: string): boolean;
  status(fileId: string): CloudFileStatus | null;
  usage(): { used: number; quota: number } | null;
  /** Lists the cloud, adds files this device lacks, merges open files that changed. */
  refresh(): Promise<void>;
  enable(fileId: string): Promise<void>;
  disable(fileId: string): Promise<void>;
  /** Uploads every file with pending changes now (the window is going away). */
  flush(): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createCloudSync(opts: CloudSyncOptions): CloudSync {
  const { api, workspace, local, userId } = opts;
  const backing = opts.storage === undefined ? safeStorage() : opts.storage;
  const seen = persistedMap<string>(backing, `markup:cloud-seen:${userId}`);
  const dirty = persistedMap<true>(backing, `markup:cloud-dirty:${userId}`);
  /** The name last agreed with the cloud, so a rename on either side wins over the other's stale name. */
  const names = persistedMap<string>(backing, `markup:cloud-names:${userId}`);
  const remote = new Map<string, RemoteFile>();
  const statuses = new Map<string, CloudFileStatus>();
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queues = new Map<string, Promise<void>>();
  const watched = new Map<MarkupDoc, () => void>();
  let usage: { used: number; quota: number } | null = null;
  let disposed = false;

  const emit = () => listeners.forEach((l) => l());
  const setStatus = (fileId: string, status: CloudFileStatus) => {
    statuses.set(fileId, status);
    emit();
  };
  const refreshUsage = async () => {
    try {
      usage = await api.usage();
      emit();
    } catch {
      // Shown again after the next successful call.
    }
  };

  /** Runs one sync step per file at a time; a request while one runs waits for it. */
  const serial = (fileId: string, step: () => Promise<void>) => {
    const next = (queues.get(fileId) ?? Promise.resolve()).then(step, step);
    queues.set(fileId, next);
    return next.finally(() => {
      if (queues.get(fileId) === next) queues.delete(fileId);
    });
  };

  /** Merges the cloud copy into an open doc (or the stored file) when it changed since last seen. */
  async function pullInto(fileId: string, version: string, doc: MarkupDoc | undefined) {
    if (seen.get(fileId) === version) return;
    const state = await api.download(fileId);
    if (state) {
      if (doc) Y.applyUpdate(doc.ydoc, state, CLOUD_ORIGIN);
      else await local.merge(fileId, state);
    }
    seen.set(fileId, version);
  }

  function failed(fileId: string, err: unknown) {
    const code = err instanceof CloudError ? err.code : 'network';
    if (code === 'not_in_cloud') {
      remote.delete(fileId);
      statuses.delete(fileId);
      dirty.delete(fileId);
      emit();
      return;
    }
    setStatus(fileId, code === 'quota_exceeded' ? 'full' : code === 'too_large' ? 'too-large' : 'offline');
  }

  /** Pull if needed, then upload when there are local changes the cloud does not have. */
  const sync = (fileId: string) =>
    serial(fileId, async () => {
      if (disposed || !remote.has(fileId)) return;
      setStatus(fileId, 'syncing');
      try {
        const version = await api.version(fileId);
        if (version === null) throw new CloudError('not_in_cloud', 'Not in the cloud any more.');
        const doc = workspace.doc(fileId);
        await pullInto(fileId, version, doc);
        if (dirty.get(fileId)) {
          const state = doc ? Y.encodeStateAsUpdate(doc.ydoc) : await local.read(fileId);
          if (state) {
            // Cleared before the upload: an edit made meanwhile marks it again and uploads after.
            dirty.delete(fileId);
            try {
              seen.set(fileId, await api.upload(fileId, state));
            } catch (err) {
              dirty.set(fileId, true);
              throw err;
            }
            // Renamed here since the last sync: the cloud (and the website) follow.
            const name = workspace.library.get(fileId)?.name;
            const known = remote.get(fileId);
            if (name && known && name !== names.get(fileId)) {
              await api.rename(fileId, name).catch(() => undefined);
              remote.set(fileId, { ...known, name });
              names.set(fileId, name);
            }
            void refreshUsage();
          }
        }
        setStatus(fileId, 'synced');
      } catch (err) {
        failed(fileId, err);
      }
    });

  const schedule = (fileId: string) => {
    clearTimeout(timers.get(fileId));
    timers.set(
      fileId,
      setTimeout(() => {
        timers.delete(fileId);
        void sync(fileId);
      }, opts.debounceMs ?? 4000),
    );
  };

  // Every open file: local edits of cloud files mark them and schedule an upload; a cloud file
  // that opens is checked for changes made on other devices.
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
        if (origin === CLOUD_ORIGIN || !remote.has(doc.fileId)) return;
        dirty.set(doc.fileId, true);
        schedule(doc.fileId);
      };
      doc.ydoc.on('update', onUpdate);
      watched.set(doc, () => doc.ydoc.off('update', onUpdate));
      if (remote.has(doc.fileId)) void sync(doc.fileId);
    }
  };
  const offWorkspace = workspace.on('change', watchDocs);
  // Files already open when sync starts (restored tabs) are watched from the start too.
  watchDocs();

  return {
    isInCloud: (fileId) => remote.has(fileId),
    status: (fileId) => statuses.get(fileId) ?? (remote.has(fileId) ? 'synced' : null),
    usage: () => usage,

    async refresh() {
      const files = await api.list();
      if (disposed) return;
      remote.clear();
      for (const f of files) remote.set(f.fileId, f);
      for (const f of files) {
        const item = workspace.library.get(f.fileId);
        if (item) {
          // Renamed in the cloud (on the website or another device) since the last sync: follow it.
          if (f.name !== names.get(f.fileId) && f.name !== item.name && names.get(f.fileId) !== undefined) {
            try {
              workspace.rename(f.fileId, f.name);
            } catch {
              // An archived or odd item: keep the local name.
            }
          }
          names.set(f.fileId, f.name);
          continue;
        }
        // In the cloud, not on this device yet: bring it in, at the top level of Files.
        try {
          const state = await api.download(f.fileId);
          if (!state) continue;
          await local.merge(f.fileId, state);
          seen.set(f.fileId, f.updatedAt);
          if (!workspace.library.get(f.fileId)) workspace.library.addFile({ id: f.fileId, name: f.name });
          names.set(f.fileId, f.name);
        } catch {
          setStatus(f.fileId, 'offline');
        }
      }
      // Files with changes from an earlier run that never reached the cloud, and open cloud files.
      for (const fileId of dirty.keys()) if (remote.has(fileId)) void sync(fileId);
      watchDocs();
      void refreshUsage();
      emit();
    },

    async enable(fileId) {
      const item = workspace.library.get(fileId);
      if (!item || item.type !== 'file') throw new Error('Only files can be kept in the cloud.');
      await api.add(fileId, item.name);
      remote.set(fileId, { fileId, name: item.name, updatedAt: '' });
      names.set(fileId, item.name);
      seen.delete(fileId);
      dirty.set(fileId, true);
      emit();
      await sync(fileId);
    },

    async disable(fileId) {
      clearTimeout(timers.get(fileId));
      await serial(fileId, async () => {
        await api.remove(fileId);
        remote.delete(fileId);
        statuses.delete(fileId);
        seen.delete(fileId);
        dirty.delete(fileId);
        names.delete(fileId);
      });
      void refreshUsage();
      emit();
    },

    async flush() {
      const pending = [...timers.keys()];
      for (const id of pending) clearTimeout(timers.get(id));
      timers.clear();
      await Promise.all(pending.map((id) => sync(id)));
    },

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

/**
 * The CloudApi: rows under RLS in Supabase; contents in Cloudflare R2 through the cloud-files
 * function (save, a 60-second download link, remove), which holds the R2 keys.
 */
export function supabaseCloudApi(supabase: SupabaseClient, config: CloudConfig): CloudApi {
  /** Calls cloud-files for one file with the user's JWT. */
  async function callFiles(method: 'GET' | 'POST' | 'DELETE', fileId: string, body?: Uint8Array): Promise<Response> {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new CloudError('auth', 'Signed out.');
    try {
      return await fetch(`${config.url}/functions/v1/cloud-files?file=${encodeURIComponent(fileId)}`, {
        method,
        headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/octet-stream' } : {}) },
        // A copy backed by a plain ArrayBuffer, which fetch accepts as a body.
        body: body ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new CloudError('network', 'Offline.');
    }
  }

  async function errorFrom(res: Response): Promise<CloudError> {
    const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
    const code = body?.error;
    if (code === 'quota_exceeded' || code === 'too_large' || code === 'not_in_cloud') return new CloudError(code, String(body?.message ?? code));
    if (res.status === 401) return new CloudError('auth', 'Signed out.');
    return new CloudError('server', String(body?.message ?? `Cloud request failed (${res.status}).`));
  }

  return {
    async list() {
      const { data, error } = await supabase.from('cloud_files').select('file_id, name, updated_at').is('deleted_at', null);
      if (error) throw new CloudError('network', error.message);
      return (data ?? []).map((r) => ({ fileId: r.file_id as string, name: r.name as string, updatedAt: r.updated_at as string }));
    },
    async add(fileId, name) {
      const clean = name.slice(0, 200) || 'Untitled';
      const { error } = await supabase.from('cloud_files').insert({ file_id: fileId, name: clean });
      if (!error) return;
      // Kept in the cloud before and turned off without removing the row: bring it back.
      if (error.code === '23505') {
        const { error: again } = await supabase.from('cloud_files').update({ deleted_at: null, name: clean }).eq('file_id', fileId);
        if (!again) return;
      }
      throw new CloudError('network', error.message);
    },
    async remove(fileId) {
      const res = await callFiles('DELETE', fileId);
      if (!res.ok) throw await errorFrom(res);
    },
    async rename(fileId, name) {
      await supabase.from('cloud_files').update({ name: name.slice(0, 200) || 'Untitled' }).eq('file_id', fileId);
    },
    async version(fileId) {
      const { data, error } = await supabase.from('cloud_files').select('updated_at').eq('file_id', fileId).is('deleted_at', null).maybeSingle();
      if (error) throw new CloudError('network', error.message);
      return (data?.updated_at as string | undefined) ?? null;
    },
    async download(fileId) {
      const res = await callFiles('GET', fileId);
      // Nothing saved yet (the first upload never finished).
      if (res.status === 404) return null;
      if (!res.ok) throw await errorFrom(res);
      const { url } = (await res.json()) as { url?: unknown };
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new CloudError('server', 'Bad download link.');
      let file: Response;
      try {
        file = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      } catch {
        throw new CloudError('network', 'Offline.');
      }
      if (!file.ok) throw new CloudError('server', `Download failed (${file.status}).`);
      return new Uint8Array(await file.arrayBuffer());
    },
    async upload(fileId, state) {
      const res = await callFiles('POST', fileId, state);
      const body = (await res.clone().json().catch(() => null)) as { updated_at?: unknown } | null;
      if (res.ok && typeof body?.updated_at === 'string') return body.updated_at;
      throw await errorFrom(res);
    },
    async usage() {
      const { data, error } = await supabase.rpc('my_storage');
      if (error) throw new CloudError('network', error.message);
      const row = (Array.isArray(data) ? data[0] : data) as { bytes_used?: number; quota_bytes?: number } | undefined;
      return { used: Number(row?.bytes_used ?? 0), quota: Number(row?.quota_bytes ?? 0) };
    },
  };
}

// ── The running engine, following the account ──

let shared: CloudSync | null = null;
const sharedListeners = new Set<() => void>();
const emitShared = () => sharedListeners.forEach((l) => l());

export function sharedCloudSync(): CloudSync | null {
  return shared;
}

/** Bumped on every change, so useSyncExternalStore sees a new snapshot. */
let version = 0;

/** The running engine; re-renders on any cloud change (statuses, usage, starting or stopping). */
export function useCloudSync(): CloudSync | null {
  useSyncExternalStore(
    (l) => {
      sharedListeners.add(l);
      return () => sharedListeners.delete(l);
    },
    () => version,
  );
  return shared;
}

/**
 * Starts sync while signed in and stops it on sign-out. Local files are never touched by signing
 * out: the cloud copies stay in the cloud, the local ones on this device.
 */
export function startCloudSync(workspace: Workspace, local: LocalFiles): () => void {
  let unrelay: (() => void) | undefined;
  let current: string | null = null;
  const bump = () => {
    version++;
    emitShared();
  };
  const follow = () => {
    const state = sharedAccount()?.getState();
    const cloud = sharedCloudClient();
    const userId = state?.status === 'signedIn' && cloud ? state.user.id : null;
    if (userId === current) return;
    unrelay?.();
    shared?.dispose();
    shared = null;
    current = userId;
    if (userId && cloud) {
      const engine = createCloudSync({ api: supabaseCloudApi(cloud.supabase, cloud.config), workspace, local, userId });
      shared = engine;
      unrelay = engine.subscribe(bump);
      void engine.refresh().catch(() => undefined);
    }
    bump();
  };
  follow();
  const offAccount = subscribeAccount(follow);
  const onHide = () => void shared?.flush();
  // Back to the window: pick up what changed elsewhere (the website, another device), at most twice a minute.
  let lastRefresh = 0;
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') return onHide();
    if (Date.now() - lastRefresh < 30_000) return;
    lastRefresh = Date.now();
    void shared?.refresh().catch(() => undefined);
  };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    offAccount();
    unrelay?.();
    shared?.dispose();
    shared = null;
    current = null;
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
    bump();
  };
}
