import { useSyncExternalStore } from 'react';
import { historyScope, type Actor, type MarkupDoc } from '@markup/doc';
import type * as Y from 'yjs';
import { inTauri } from '../export/clipboard';
import type { Workspace } from '../workspace/Workspace';
import { sharedAccount, subscribeAccount } from './account';

/**
 * Personal usage stats: daily counts kept on this device, and saved to the user's own account
 * (table usage_daily, owner-only) while they are signed in and allow it. For the user only:
 * never file contents, names, page addresses or prompts; nothing limits or meters anything.
 *
 * Each upload sends the whole day's totals for this device, so a retry or a second upload of the
 * same day replaces the row instead of adding to it.
 */

export interface UsageMetrics {
  /** Minutes with the window focused and some input in that minute. */
  active_minutes?: number;
  /** Document changes, one per operation (the same unit as undo). */
  edits?: { you?: number; agents?: number };
  /** Agent tool calls, by agent name. */
  agent_calls?: Record<string, number>;
  /** Agent tool calls, by tool. */
  tool_calls?: Record<string, number>;
  files_created?: number;
  /** Distinct files changed that day. */
  files_edited?: number;
  /** Saved exports, by format. */
  exports?: Record<string, number>;
}

export interface UsageRow {
  day: string;
  device_id: string;
  client: 'desktop' | 'web';
  metrics: UsageMetrics;
}

interface Day {
  metrics: UsageMetrics;
  /** Ids of the files changed that day: only counted, never uploaded. */
  files: string[];
  /** Bumped on every change; `synced` is the rev last saved to the account. */
  rev: number;
  synced: number;
}

type Backing = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const STORE_KEY = 'markup:usage';
const DEVICE_KEY = 'markup:device-id';
const SYNC_KEY = 'markup:usage-sync';
/** Days kept on this device. */
export const KEEP_DAYS = 90;
/** Distinct agent or tool names per day; the rest count as "other". Keeps a row far below its 16 KB cap. */
const MAX_KEYS = 40;
const MAX_FILES = 500;
export const SYNC_INTERVAL_MS = 5 * 60_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day, YYYY-MM-DD. */
export function dayKey(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Adds one to `key` in a by-name count, keeping names short and the number of names bounded. */
function bump(map: Record<string, number> | undefined, key: string): Record<string, number> {
  const counts = map ?? {};
  const name = key.replace(/[^\w .@:/-]/g, '').trim().slice(0, 40) || 'unknown';
  const slot = name in counts || Object.keys(counts).length < MAX_KEYS ? name : 'other';
  counts[slot] = (counts[slot] ?? 0) + 1;
  return counts;
}

function readJson(backing: Backing | null, key: string): unknown {
  try {
    const raw = backing?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

export interface UsageStore {
  /** Changes today's counts. */
  record(change: (metrics: UsageMetrics, day: Day) => void): void;
  /** Days with changes not yet saved to the account. */
  pending(): { day: string; rev: number; metrics: UsageMetrics }[];
  markSynced(day: string, rev: number): void;
  /** Today's counts (for display and tests). */
  today(): UsageMetrics;
  /** Forgets every count on this device. */
  clear(): void;
  /** Writes to storage now instead of after the short delay. */
  save(): void;
}

export function createUsageStore(opts: { storage?: Backing | null; now?: () => number; saveDelayMs?: number } = {}): UsageStore {
  const backing = opts.storage === undefined ? safeLocalStorage() : opts.storage;
  const now = opts.now ?? Date.now;
  const days: Record<string, Day> = {};
  const saved = readJson(backing, STORE_KEY) as { days?: Record<string, Day> } | null;
  for (const [key, day] of Object.entries(saved?.days ?? {})) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key) && day && typeof day === 'object' && typeof day.rev === 'number') {
      days[key] = { metrics: day.metrics ?? {}, files: Array.isArray(day.files) ? day.files : [], rev: day.rev, synced: typeof day.synced === 'number' ? day.synced : 0 };
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;

  const prune = () => {
    const oldest = dayKey(now() - KEEP_DAYS * 86_400_000);
    for (const key of Object.keys(days)) if (key < oldest) delete days[key];
  };
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    prune();
    try {
      backing?.setItem(STORE_KEY, JSON.stringify({ v: 1, days }));
    } catch {
      // Storage full or blocked: the counts live until the app closes.
    }
  };

  return {
    record(change) {
      const key = dayKey(now());
      const day = (days[key] ??= { metrics: {}, files: [], rev: 0, synced: 0 });
      change(day.metrics, day);
      day.rev++;
      timer ??= setTimeout(save, opts.saveDelayMs ?? 2000);
    },
    pending: () =>
      Object.entries(days)
        .filter(([, d]) => d.rev > d.synced)
        .map(([day, d]) => ({ day, rev: d.rev, metrics: structuredClone(d.metrics) })),
    markSynced(key, rev) {
      const day = days[key];
      if (!day) return;
      day.synced = Math.max(day.synced, rev);
      timer ??= setTimeout(save, opts.saveDelayMs ?? 2000);
    },
    today: () => structuredClone(days[dayKey(now())]?.metrics ?? {}),
    clear() {
      for (const key of Object.keys(days)) delete days[key];
      save();
    },
    save,
  };
}

/** What gets counted, as plain functions over a store. */
export const count = {
  edit(store: UsageStore, fileId: string, kind: Actor['kind']) {
    store.record((m, day) => {
      const edits = (m.edits ??= {});
      if (kind === 'agent') edits.agents = (edits.agents ?? 0) + 1;
      else edits.you = (edits.you ?? 0) + 1;
      if (!day.files.includes(fileId) && day.files.length < MAX_FILES) day.files.push(fileId);
      m.files_edited = day.files.length;
    });
  },
  toolCall(store: UsageStore, agent: string, tool: string) {
    store.record((m) => {
      m.agent_calls = bump(m.agent_calls, agent);
      m.tool_calls = bump(m.tool_calls, tool);
    });
  },
  fileCreated(store: UsageStore) {
    store.record((m) => void (m.files_created = (m.files_created ?? 0) + 1));
  },
  exported(store: UsageStore, format: string) {
    store.record((m) => void (m.exports = bump(m.exports, format.toLowerCase())));
  },
  activeMinute(store: UsageStore) {
    store.record((m) => void (m.active_minutes = (m.active_minutes ?? 0) + 1));
  },
};

/**
 * Calls `onEdit` for every change an actor (you or an agent) makes to an open file's content:
 * layers, pages, tokens, comments. Selection, agent "working" marks and log bookkeeping do not count,
 * and neither do changes arriving from storage or sync (they carry no actor).
 */
export function watchEdits(workspace: Workspace, onEdit: (fileId: string, kind: Actor['kind']) => void): () => void {
  const watched = new Map<MarkupDoc, () => void>();
  const sync = () => {
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
      // Plain set of the shared types: their event types differ, membership is all that matters here.
      const scope = new Set<unknown>(historyScope(doc));
      const onTransaction = (tr: Y.Transaction) => {
        const origin = tr.origin as Partial<Actor> | null;
        if (!origin || typeof origin !== 'object' || (origin.kind !== 'human' && origin.kind !== 'agent')) return;
        if (![...tr.changedParentTypes.keys()].some((type) => scope.has(type))) return;
        onEdit(doc.fileId, origin.kind);
      };
      doc.ydoc.on('afterTransaction', onTransaction);
      watched.set(doc, () => doc.ydoc.off('afterTransaction', onTransaction));
    }
  };
  sync();
  const off = workspace.on('change', sync);
  return () => {
    off();
    for (const stop of watched.values()) stop();
    watched.clear();
  };
}

/** Calls `onMinute` once a minute while the window is visible and focused and there was input in that minute. */
export function watchActivity(win: Window, onMinute: () => void, opts: { now?: () => number; intervalMs?: number } = {}): () => void {
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? 60_000;
  let lastInput = Number.NEGATIVE_INFINITY;
  const mark = () => {
    lastInput = now();
  };
  const events = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
  for (const type of events) win.addEventListener(type, mark, { passive: true, capture: true });
  const timer = setInterval(() => {
    const doc = win.document;
    if (doc.visibilityState === 'visible' && doc.hasFocus() && now() - lastInput < interval) onMinute();
  }, interval);
  return () => {
    clearInterval(timer);
    for (const type of events) win.removeEventListener(type, mark, { capture: true });
  };
}

export interface UsageSyncOptions {
  store: UsageStore;
  deviceId: string;
  client: UsageRow['client'];
  upload(rows: UsageRow[]): Promise<void>;
  /** True while there is an account to save to and the user allows it. */
  canUpload(): boolean;
  intervalMs?: number;
}

/** Saves pending days to the account every few minutes, and on demand (sign-in, the window going away). */
export function createUsageSync(opts: UsageSyncOptions): { flush(): Promise<void>; dispose(): void } {
  let running: Promise<void> | null = null;
  const flush = () => {
    if (running || !opts.canUpload()) return running ?? Promise.resolve();
    const pending = opts.store.pending();
    if (!pending.length) return Promise.resolve();
    running = opts
      .upload(pending.map((p) => ({ day: p.day, device_id: opts.deviceId, client: opts.client, metrics: p.metrics })))
      .then(
        () => pending.forEach((p) => opts.store.markSynced(p.day, p.rev)),
        () => undefined, // Offline or signed out meanwhile: the days stay pending for the next try.
      )
      .finally(() => {
        running = null;
      });
    return running;
  };
  const timer = setInterval(() => void flush(), opts.intervalMs ?? SYNC_INTERVAL_MS);
  return {
    flush,
    dispose: () => clearInterval(timer),
  };
}

function safeLocalStorage(): Backing | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A random id for this install, not tied to the hardware; rows of different devices stay apart. */
export function deviceId(backing: Backing | null = safeLocalStorage()): string {
  try {
    const known = backing?.getItem(DEVICE_KEY);
    if (known && /^[A-Za-z0-9_-]{8,64}$/.test(known)) return known;
  } catch {
    // Fall through to a new id.
  }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try {
    backing?.setItem(DEVICE_KEY, id);
  } catch {
    // A new id next run: that only splits this device's rows.
  }
  return id;
}

// ── "Save my usage stats" (on unless the user turns it off) ──

const syncListeners = new Set<() => void>();

export function usageSyncEnabled(): boolean {
  try {
    return localStorage.getItem(SYNC_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setUsageSyncEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SYNC_KEY);
    else localStorage.setItem(SYNC_KEY, 'off');
  } catch {
    // Storage blocked: the choice lasts for this run.
  }
  syncListeners.forEach((l) => l());
  if (on) void shared?.sync.flush();
}

export function useUsageSyncEnabled(): boolean {
  return useSyncExternalStore(
    (l) => {
      syncListeners.add(l);
      return () => syncListeners.delete(l);
    },
    usageSyncEnabled,
  );
}

// ── The running tracker ──

let shared: { store: UsageStore; sync: ReturnType<typeof createUsageSync> } | null = null;

export function recordToolCall(agent: string, tool: string): void {
  if (shared) count.toolCall(shared.store, agent, tool);
}

export function recordExport(format: string): void {
  if (shared) count.exported(shared.store, format);
}

/** Deletes the stats saved to the account and the counts on this device. */
export async function deleteUsageStats(): Promise<void> {
  await sharedAccount()?.deleteUsage();
  shared?.store.clear();
}

/** Starts counting for this window. Saving to the account follows the account and the setting. */
export function startUsage(workspace: Workspace): () => void {
  if (shared) return () => undefined;
  const store = createUsageStore();
  const signedIn = () => sharedAccount()?.getState().status === 'signedIn';
  const sync = createUsageSync({
    store,
    deviceId: deviceId(),
    client: inTauri() ? 'desktop' : 'web',
    canUpload: () => signedIn() && usageSyncEnabled(),
    upload: (rows) => sharedAccount()!.uploadUsage(rows),
  });
  shared = { store, sync };

  const stops = [
    watchEdits(workspace, (fileId, kind) => count.edit(store, fileId, kind)),
    workspace.on('created', () => count.fileCreated(store)),
    watchActivity(window, () => count.activeMinute(store)),
  ];
  // Save right after signing in, and whatever is pending when the window goes away.
  let wasSignedIn = signedIn();
  stops.push(
    subscribeAccount(() => {
      const now = signedIn();
      if (now && !wasSignedIn) void sync.flush();
      wasSignedIn = now;
    }),
  );
  const onHide = () => {
    store.save();
    void sync.flush();
  };
  const onVisibility = () => document.visibilityState === 'hidden' && onHide();
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stops.forEach((stop) => stop());
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
    sync.dispose();
    store.save();
    shared = null;
  };
}
