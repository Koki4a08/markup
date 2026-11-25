import { useSyncExternalStore } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { inTauri } from '../export/clipboard';
import { readCloudConfig, type CloudConfig } from './config';
import { createPendingSignIn, exchangeCode, parseCallbackUrl, signInPageUrl, SignInError, type PendingSignIn } from './handoff';
import type { UsageRow } from './usage';
import { createVault, type KeyStore } from './vault';

/**
 * The account the desktop app is signed in to. Optional by design: nothing in the editor waits on
 * it or changes without it. Sign-in happens on the website (see handoff.ts); this store keeps the
 * state the account button shows and owns the session's lifecycle.
 */

export interface AccountUser {
  id: string;
  email: string;
  name: string | null;
  avatar: string | null;
}

export type AccountState =
  /** No account features in this build (no settings, or not the desktop app). */
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'signedOut'; error?: string }
  /** The browser is open on the sign-in page; waiting for markup://auth/callback. */
  | { status: 'waiting'; url: string }
  | { status: 'finishing' }
  | { status: 'signedIn'; user: AccountUser; signingOut?: boolean; error?: string };

/** What the store needs from Supabase, narrowed so tests can fake it. */
export interface AccountClient {
  currentUser(): Promise<User | null>;
  onChange(listener: (user: User | null) => void): () => void;
  /** Turns the one-time token from the handoff into this app's own session. */
  verify(tokenHash: string): Promise<User>;
  /** Ends this app's session only (the browser stays signed in). */
  signOut(): Promise<void>;
  profile(userId: string): Promise<{ name: string | null; avatar: string | null } | null>;
  /** Saves whole-day usage rows (replacing that day and device's row). */
  upsertUsage(rows: UsageRow[]): Promise<void>;
  deleteUsage(userId: string): Promise<void>;
}

export interface AccountOptions {
  client: AccountClient;
  config: CloudConfig;
  /** Opens a URL in the system browser. */
  openUrl(url: string): void;
  exchange?: (code: string, verifier: string) => Promise<string>;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface Account {
  getState(): AccountState;
  subscribe(listener: () => void): () => void;
  init(): Promise<void>;
  signIn(page?: 'login' | 'signup'): Promise<void>;
  /** Opens the sign-in page again while waiting (the user closed the tab). */
  reopen(): void;
  cancel(): void;
  /** Deep links delivered to the app. Anything that is not our callback is ignored. */
  handleUrls(urls: readonly string[]): Promise<void>;
  signOut(): Promise<void>;
  /** Saves usage rows to the signed-in account; rejects when signed out. */
  uploadUsage(rows: UsageRow[]): Promise<void>;
  /** Deletes every usage row of the signed-in account. */
  deleteUsage(): Promise<void>;
  dispose(): void;
}

const TIMED_OUT = 'Sign-in timed out. Try again.';

/** Name and avatar from the auth user, until the profile row (the source of truth) arrives. */
export function toAccountUser(user: User, profile?: { name: string | null; avatar: string | null } | null): AccountUser {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const full = [text(meta.first_name), text(meta.last_name)].filter(Boolean).join(' ');
  const name = profile?.name ?? (full || text(meta.full_name) || text(meta.name) || text(meta.user_name));
  // The profile row wins once loaded, including a removed avatar.
  const avatar = profile ? profile.avatar : text(meta.avatar_url);
  const email = user.email ?? '';
  return { id: user.id, email, name, avatar: avatar && /^https:\/\//.test(avatar) ? avatar : null };
}

export function createAccount(options: AccountOptions): Account {
  const { client, config } = options;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? console.warn;
  const exchange = options.exchange ?? ((code: string, verifier: string) => exchangeCode(config, code, verifier));
  const listeners = new Set<() => void>();
  let state: AccountState = { status: 'loading' };
  let pending: PendingSignIn | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  const set = (next: AccountState) => {
    if (disposed) return;
    state = next;
    listeners.forEach((l) => l());
  };

  const clearPending = () => {
    pending = null;
    clearTimeout(expiry);
  };

  async function showUser(user: User) {
    set({ status: 'signedIn', user: toAccountUser(user) });
    try {
      const profile = await client.profile(user.id);
      if (profile && state.status === 'signedIn' && state.user.id === user.id) set({ ...state, user: toAccountUser(user, profile) });
    } catch {
      // The name from the sign-in is good enough until next time.
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async init() {
      unsubscribe = client.onChange((user) => {
        // Mid sign-in, the handoff decides what to show.
        if (state.status === 'waiting' || state.status === 'finishing') return;
        if (user) {
          if (state.status !== 'signedIn' || state.user.id !== user.id) void showUser(user);
        } else if (state.status === 'signedIn' || state.status === 'loading') {
          set({ status: 'signedOut' });
        }
      });
      try {
        const user = await client.currentUser();
        if (state.status !== 'loading') return;
        if (user) await showUser(user);
        else set({ status: 'signedOut' });
      } catch {
        if (state.status === 'loading') set({ status: 'signedOut' });
      }
    },

    async signIn(page = 'login') {
      if (state.status === 'signedIn' || state.status === 'finishing') return;
      clearPending();
      pending = await createPendingSignIn(now());
      const url = signInPageUrl(config.siteUrl, pending, page);
      const ttl = Math.max(0, pending.expiresAt - now());
      expiry = setTimeout(() => {
        if (state.status !== 'waiting') return;
        clearPending();
        set({ status: 'signedOut', error: TIMED_OUT });
      }, ttl);
      set({ status: 'waiting', url });
      options.openUrl(url);
    },

    reopen() {
      if (state.status === 'waiting') options.openUrl(state.url);
    },

    cancel() {
      if (state.status !== 'waiting') return;
      clearPending();
      set({ status: 'signedOut' });
    },

    async handleUrls(urls) {
      for (const raw of urls) {
        const callback = parseCallbackUrl(raw);
        if (!callback) continue;
        const flow = pending;
        // Not ours: no sign-in was started here, or the link belongs to another attempt. A stray or
        // planted link must not end the real sign-in, so it is dropped without touching it.
        if (!flow || callback.state !== flow.state) {
          warn('Ignored a sign-in link this app did not ask for.');
          continue;
        }
        clearPending();
        if (now() > flow.expiresAt) {
          set({ status: 'signedOut', error: TIMED_OUT });
          return;
        }
        set({ status: 'finishing' });
        try {
          const tokenHash = await exchange(callback.code, flow.verifier);
          const user = await client.verify(tokenHash);
          await showUser(user);
        } catch (err) {
          set({ status: 'signedOut', error: err instanceof SignInError ? err.message : 'Sign-in failed. Try again.' });
        }
        return;
      }
    },

    async signOut() {
      if (state.status !== 'signedIn' || state.signingOut) return;
      const current = state;
      set({ ...current, signingOut: true, error: undefined });
      try {
        await client.signOut();
        set({ status: 'signedOut' });
      } catch {
        set({ ...current, signingOut: false, error: 'Couldn’t sign out. Check your connection and try again.' });
      }
    },

    async uploadUsage(rows) {
      if (state.status !== 'signedIn') throw new Error('Not signed in.');
      await client.upsertUsage(rows);
    },

    async deleteUsage() {
      if (state.status !== 'signedIn') throw new Error('Not signed in.');
      await client.deleteUsage(state.user.id);
    },

    dispose() {
      disposed = true;
      clearPending();
      unsubscribe?.();
      listeners.clear();
    },
  };
}

/** The Supabase side of AccountClient. */
export function supabaseAccountClient(supabase: SupabaseClient): AccountClient {
  return {
    async currentUser() {
      // Reads the saved session and refreshes it if needed; a revoked one comes back empty.
      const { data } = await supabase.auth.getSession();
      return data.session?.user ?? null;
    },
    onChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => listener(session?.user ?? null));
      return () => data.subscription.unsubscribe();
    },
    async verify(tokenHash) {
      const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
      if (error || !data.user) throw new SignInError(error?.code === 'otp_expired' ? 'That sign-in expired. Try again.' : 'Sign-in failed. Try again.');
      return data.user;
    },
    async signOut() {
      // "local": revoke this app's session on the server and forget it here; other devices stay signed in.
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    },
    async profile(userId) {
      const { data, error } = await supabase.from('profiles').select('display_name, avatar_url').eq('id', userId).maybeSingle();
      if (error || !data) return null;
      return { name: data.display_name ?? null, avatar: data.avatar_url ?? null };
    },
    async upsertUsage(rows) {
      // user_id comes from the column default (auth.uid()); RLS only lets the owner write.
      const { error } = await supabase.from('usage_daily').upsert(rows, { onConflict: 'user_id,day,device_id' });
      if (error) throw error;
    },
    async deleteUsage(userId) {
      const { error } = await supabase.from('usage_daily').delete().eq('user_id', userId);
      if (error) throw error;
    },
  };
}

/** The OS credential store, through the Rust commands in src-tauri/src/vault.rs. */
export function tauriKeyStore(invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>): KeyStore {
  return {
    get: () => invoke<string | null>('vault_key_get'),
    set: (key) => invoke<void>('vault_key_set', { key }),
  };
}

let shared: Account | null = null;
const sharedListeners = new Set<() => void>();
let unrelay: (() => void) | undefined;
const OFF: AccountState = { status: 'off' };

export function setSharedAccount(account: Account | null): void {
  unrelay?.();
  shared?.dispose();
  shared = account;
  unrelay = account?.subscribe(() => sharedListeners.forEach((l) => l()));
  sharedListeners.forEach((l) => l());
}

export function sharedAccount(): Account | null {
  return shared;
}

/** Calls `listener` whenever the shared account or its state changes. */
export function subscribeAccount(listener: () => void): () => void {
  sharedListeners.add(listener);
  return () => sharedListeners.delete(listener);
}

export function useAccount(): AccountState {
  return useSyncExternalStore(subscribeAccount, () => shared?.getState() ?? OFF);
}

let starting: Promise<void> | null = null;
let client: { supabase: SupabaseClient; config: CloudConfig } | null = null;

/** The Supabase client and settings once accounts started (desktop builds with settings), else null. */
export function sharedCloudClient(): { supabase: SupabaseClient; config: CloudConfig } | null {
  return client;
}

/**
 * Starts accounts once per run: desktop app only, and only in builds that carry the public
 * Supabase settings. Loads supabase-js lazily so the editor's startup does not wait on it.
 */
export function startAccount(): Promise<void> {
  starting ??= boot();
  return starting;
}

async function boot(): Promise<void> {
  if (shared || !inTauri()) return;
  const config = readCloudConfig(import.meta.env);
  if (!config) return;
  const [{ createClient }, deepLink, { invoke }] = await Promise.all([
    import('@supabase/supabase-js'),
    import('@tauri-apps/plugin-deep-link'),
    import('@tauri-apps/api/core'),
  ]);
  const supabase = createClient(config.url, config.publishableKey, {
    auth: {
      storage: createVault(tauriKeyStore(invoke), localStorage),
      storageKey: 'markup.session',
      persistSession: true,
      autoRefreshToken: true,
      // Sessions arrive only through the handoff, never from the window's URL.
      detectSessionInUrl: false,
    },
  });
  const account = createAccount({
    client: supabaseAccountClient(supabase),
    config,
    // Rust hands http(s) links opened with window.open to the system browser (lib.rs, on_new_window).
    openUrl: (url) => void window.open(url, '_blank'),
  });
  client = { supabase, config };
  setSharedAccount(account);
  await deepLink.onOpenUrl((urls) => void account.handleUrls(urls));
  // A link that launched the app has no sign-in waiting for it; handleUrls drops it.
  const launched = await deepLink.getCurrent().catch(() => null);
  if (launched) void account.handleUrls(launched);
  await account.init();
}
