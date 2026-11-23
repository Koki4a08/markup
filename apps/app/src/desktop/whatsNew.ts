import { useSyncExternalStore } from 'react';
import { inTauri } from '../export/clipboard';

/**
 * "What's new" after an update: the first time Markup opens on a newer version, a card names the
 * version, lists its top changes from the website's changelog, and links to the full entry at
 * markup.here/changelog/#v<version>. The card stays (across restarts) until the user closes it or
 * opens the changelog. A fresh install shows nothing.
 *
 * The changelog lives in markup-website/src/content/changelog.ts and is served as /changelog.json.
 */

export const SITE_URL = 'https://markup.here';
export const CHANGELOG_JSON = `${SITE_URL}/changelog.json`;

/** The changelog page, scrolled to one version's entry. */
export const changelogUrl = (version: string) => `${SITE_URL}/changelog/#v${version}`;

const LAST_VERSION_KEY = 'markup:last-version';
const PENDING_KEY = 'markup:whats-new';
/** Written by every version that ran before this card existed (0.3.0 and older), so they count as upgrades. */
const EARLIER_RUN_KEYS = ['markup:tabs', 'markup:last'];

export type ChangeKind = 'new' | 'improved' | 'fixed';
export interface Change {
  kind: ChangeKind;
  text: string;
}

export type WhatsNewState =
  | { status: 'hidden' }
  | { status: 'shown'; version: string; changes: Change[] | null };

/** Compares dotted numeric versions ("0.10.0" > "0.9.2"). Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the card shows for this run only.
  }
}

/**
 * Records that `current` is running and returns the version whose "What's new" card is still owed,
 * or null. Upgrades leave a card pending until it is dismissed; a fresh install or a downgrade does not.
 */
export function takePendingVersion(current: string): string | null {
  const last = read(LAST_VERSION_KEY);
  const ranBefore = last !== null || EARLIER_RUN_KEYS.some((k) => read(k) !== null);
  const upgraded = last !== null ? compareVersions(current, last) > 0 : ranBefore;
  write(LAST_VERSION_KEY, current);
  if (upgraded) write(PENDING_KEY, current);
  return read(PENDING_KEY) === current ? current : null;
}

/** The release's changes from the site's changelog, or null when it is unreachable or has no entry yet. */
export async function fetchChanges(version: string, fetcher: typeof fetch = fetch): Promise<Change[] | null> {
  try {
    const res = await fetcher(CHANGELOG_JSON, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { releases?: { version?: string; changes?: Change[] }[] };
    const release = data.releases?.find((r) => r.version === version);
    const changes = release?.changes?.filter((c) => typeof c?.text === 'string' && c.text.length > 0);
    return changes?.length ? changes : null;
  } catch {
    return null;
  }
}

let state: WhatsNewState = { status: 'hidden' };
let started = false;
const listeners = new Set<() => void>();
const set = (next: WhatsNewState) => {
  state = next;
  listeners.forEach((l) => l());
};

/** Shows the card for `version` and fills in its changes once the changelog answers. */
export async function showWhatsNew(version: string, fetcher?: typeof fetch): Promise<void> {
  set({ status: 'shown', version, changes: null });
  const changes = await fetchChanges(version, fetcher);
  if (state.status === 'shown' && state.version === version && changes) set({ status: 'shown', version, changes });
}

/** Closes the card for good (until the next update). */
export function dismissWhatsNew(): void {
  write(PENDING_KEY, null);
  set({ status: 'hidden' });
}

/** Opens the version's changelog entry in the browser and closes the card. */
export function openChangelog(version: string): void {
  window.open(changelogUrl(version), '_blank');
  dismissWhatsNew();
}

/** Desktop only: once per app run, checks whether this is the first launch of a newer version. */
export function startWhatsNew(): void {
  if (started || !inTauri() || import.meta.env.DEV) return;
  started = true;
  void (async () => {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      const version = takePendingVersion(await getVersion());
      if (version) await showWhatsNew(version);
    } catch {
      // No version from the shell: say nothing.
    }
  })();
}

/** For tests: back to a fresh app run. */
export function resetWhatsNew(): void {
  started = false;
  set({ status: 'hidden' });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useWhatsNew(): WhatsNewState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
