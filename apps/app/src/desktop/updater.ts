import { useSyncExternalStore } from 'react';
import { inTauri } from '../export/clipboard';

/**
 * Desktop auto-update: polls the release feed every 30 seconds and offers a newer version in a card
 * (see UpdateNotice). Closing the card or choosing Later snoozes that version for 30 minutes; after
 * that the card comes back, and it keeps coming back until the user updates. A version newer than the
 * snoozed one shows right away. The snooze is kept in localStorage so a restart does not reset it.
 */

export const CHECK_INTERVAL_MS = 30_000;
export const SNOOZE_MS = 30 * 60_000;
const SNOOZE_KEY = 'markup:update-snooze';

/** What the updater needs from a found release. Tauri's `Update` satisfies it. */
export interface FoundUpdate {
  version: string;
  currentVersion: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export type UpdateState =
  | { status: 'idle' }
  | { status: 'available'; version: string; currentVersion: string }
  | { status: 'downloading'; version: string; downloaded: number; total: number | null }
  | { status: 'installing'; version: string }
  | { status: 'error'; version: string; message: string };

export interface Snooze {
  version: string;
  until: number;
}

/** True when the card for `version` should be on screen at `now`, given the stored snooze. */
export function isVisible(version: string, snooze: Snooze | null, now: number): boolean {
  return !snooze || snooze.version !== version || now >= snooze.until;
}

function readSnooze(): Snooze | null {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Snooze>;
    return typeof v.version === 'string' && typeof v.until === 'number' ? { version: v.version, until: v.until } : null;
  } catch {
    return null;
  }
}

function writeSnooze(snooze: Snooze): void {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(snooze));
  } catch {
    // Storage unavailable: the snooze lasts for this session only.
  }
}

export interface UpdaterOptions {
  /** Resolves to a newer release, or null when the app is up to date. */
  check(): Promise<FoundUpdate | null>;
  /** Starts the freshly installed version. */
  relaunch(): Promise<void>;
  now?: () => number;
  intervalMs?: number;
}

export interface Updater {
  getState(): UpdateState;
  /** The card is shown: there is something to say and it is not snoozed. */
  isShown(): boolean;
  subscribe(listener: () => void): () => void;
  checkNow(): Promise<void>;
  install(): Promise<void>;
  snooze(): void;
  dispose(): void;
}

export function createUpdater(options: UpdaterOptions): Updater {
  const now = options.now ?? Date.now;
  const listeners = new Set<() => void>();
  let state: UpdateState = { status: 'idle' };
  let found: FoundUpdate | null = null;
  let snooze = readSnooze();
  let checking = false;
  let disposed = false;

  const set = (next: UpdateState) => {
    state = next;
    emit();
  };
  const emit = () => listeners.forEach((l) => l());
  const busy = () => state.status === 'downloading' || state.status === 'installing';

  const checkNow = async () => {
    if (checking || busy() || disposed) return;
    checking = true;
    try {
      const update = await options.check();
      if (disposed || busy()) return;
      if (!update) {
        found = null;
        if (state.status === 'available') set({ status: 'idle' });
        return;
      }
      found = update;
      // A failed download stays on screen until the user retries or closes it.
      if (state.status === 'error' && state.version === update.version) return;
      set({ status: 'available', version: update.version, currentVersion: update.currentVersion });
    } catch {
      // Offline, rate-limited or no feed yet: stay quiet and try again on the next tick.
    } finally {
      checking = false;
    }
  };

  const install = async () => {
    const update = found;
    if (!update || busy()) return;
    let downloaded = 0;
    let total: number | null = null;
    set({ status: 'downloading', version: update.version, downloaded, total });
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? null;
        else if (e.event === 'Progress') downloaded += e.data.chunkLength;
        else {
          set({ status: 'installing', version: update.version });
          return;
        }
        set({ status: 'downloading', version: update.version, downloaded, total });
      });
      set({ status: 'installing', version: update.version });
      await options.relaunch();
    } catch (err) {
      set({ status: 'error', version: update.version, message: err instanceof Error ? err.message : String(err) });
    }
  };

  const timer = setInterval(() => {
    // Each tick also re-reads the clock, so a card whose snooze ran out comes back.
    void checkNow();
    emit();
  }, options.intervalMs ?? CHECK_INTERVAL_MS);
  const onFocus = () => void checkNow();
  if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);
  void checkNow();

  return {
    getState: () => state,
    isShown: () => {
      if (state.status === 'idle') return false;
      if (state.status === 'available' || state.status === 'error') return isVisible(state.version, snooze, now());
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    checkNow,
    install,
    snooze() {
      if (state.status !== 'available' && state.status !== 'error') return;
      snooze = { version: state.version, until: now() + SNOOZE_MS };
      writeSnooze(snooze);
      // A failed download goes back to an offer, so the card returns with Update, not Try again.
      if (state.status === 'error' && found) set({ status: 'available', version: found.version, currentVersion: found.currentVersion });
      else emit();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
      listeners.clear();
    },
  };
}

let shared: Updater | null = null;
let unrelay: (() => void) | undefined;
const sharedListeners = new Set<() => void>();
const emitShared = () => sharedListeners.forEach((l) => l());

/** Makes `updater` the one the card shows. Also used by tests and previews. */
export function setSharedUpdater(updater: Updater | null): void {
  unrelay?.();
  shared?.dispose();
  shared = updater;
  unrelay = updater?.subscribe(emitShared);
  emitShared();
}

/** Starts the desktop update checks once per app run. A no-op in the browser and in dev builds. */
export function startUpdateChecks(): void {
  if (shared || !inTauri() || import.meta.env.DEV) return;
  setSharedUpdater(
    createUpdater({
      check: async () => (await import('@tauri-apps/plugin-updater')).check(),
      relaunch: async () => (await import('@tauri-apps/plugin-process')).relaunch(),
    }),
  );
}

const subscribeShared = (listener: () => void) => {
  sharedListeners.add(listener);
  return () => sharedListeners.delete(listener);
};

/** The running updater, re-rendering on every state change. Null outside the desktop app. */
export function useUpdater(): { updater: Updater; state: UpdateState; shown: boolean } | null {
  // Snapshot is a string so React sees a change whenever state or visibility moves.
  useSyncExternalStore(
    subscribeShared,
    () => (shared ? `${JSON.stringify(shared.getState())}|${shared.isShown()}` : ''),
    () => '',
  );
  if (!shared) return null;
  return { updater: shared, state: shared.getState(), shown: shared.isShown() };
}
