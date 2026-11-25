// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { createAccount, toAccountUser, type AccountClient, type AccountState } from '../src/cloud/account';
import { readCloudConfig, type CloudConfig } from '../src/cloud/config';
import { createPendingSignIn, exchangeCode, parseCallbackUrl, s256, SIGN_IN_TIMEOUT_MS, signInPageUrl, SignInError } from '../src/cloud/handoff';
import { createVault, VAULT_PREFIX, type KeyStore } from '../src/cloud/vault';

const CONFIG: CloudConfig = { url: 'https://abcdefgh.supabase.co', publishableKey: 'sb_publishable_test', siteUrl: 'https://markup.here' };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function memoryKeys(initial: string | null = null) {
  let value = initial;
  const keys = {
    get: vi.fn(async () => value),
    set: vi.fn(async (k: string) => {
      value = k;
    }),
  } satisfies KeyStore;
  return { keys, current: () => value };
}

describe('PKCE helpers', () => {
  it('computes the S256 challenge from RFC 7636, appendix B', async () => {
    expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('makes a fresh random verifier, challenge and state for every sign-in', async () => {
    const a = await createPendingSignIn(1000);
    const b = await createPendingSignIn(1000);
    for (const v of [a.verifier, a.state, a.challenge]) expect(v).toMatch(TOKEN);
    expect(a.challenge).toBe(await s256(a.verifier));
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
    expect(a.expiresAt).toBe(1000 + SIGN_IN_TIMEOUT_MS);
  });

  it('points the browser at the site with the challenge and state only', async () => {
    const p = await createPendingSignIn(0);
    const url = new URL(signInPageUrl('https://markup.here', p));
    expect(url.origin + url.pathname).toBe('https://markup.here/login/');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client: 'desktop', challenge: p.challenge, state: p.state });
    expect(url.href).not.toContain(p.verifier);
    expect(new URL(signInPageUrl('https://markup.here', p, 'signup')).pathname).toBe('/signup/');
  });
});

describe('parseCallbackUrl', () => {
  const code = 'c'.repeat(43);
  const state = 's'.repeat(43);
  it('reads markup://auth/callback', () => {
    expect(parseCallbackUrl(`markup://auth/callback?code=${code}&state=${state}`)).toEqual({ code, state });
    expect(parseCallbackUrl(`markup://auth/callback/?code=${code}&state=${state}`)).toEqual({ code, state });
  });
  it('ignores everything else', () => {
    for (const url of [
      `https://auth/callback?code=${code}&state=${state}`,
      `markup://file/abc/node/x?code=${code}&state=${state}`,
      `markup://auth/other?code=${code}&state=${state}`,
      `markup://auth/callback?code=${code}`,
      `markup://auth/callback?code=short&state=${state}`,
      `markup://auth/callback?code=${'c'.repeat(42)}/&state=${state}`,
      'not a url',
    ]) {
      expect(parseCallbackUrl(url)).toBeNull();
    }
  });
});

describe('exchangeCode', () => {
  it('posts code + verifier to the desktop-auth function and returns the token hash', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ token_hash: 'f'.repeat(56), type: 'magiclink' }), { status: 200 }));
    expect(await exchangeCode(CONFIG, 'c'.repeat(43), 'v'.repeat(43), fetch as unknown as typeof globalThis.fetch)).toBe('f'.repeat(56));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://abcdefgh.supabase.co/functions/v1/desktop-auth');
    expect(JSON.parse(String(init.body))).toEqual({ action: 'exchange', code: 'c'.repeat(43), verifier: 'v'.repeat(43) });
    expect(new Headers(init.headers).get('authorization')).toBeNull();
  });
  it('turns failures into readable errors', async () => {
    const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await expect(exchangeCode(CONFIG, 'c', 'v', reply(400, { message: 'This sign-in link has expired.' }))).rejects.toThrow('This sign-in link has expired.');
    await expect(exchangeCode(CONFIG, 'c', 'v', reply(502, { message: 'upstream detail' }))).rejects.toThrow('Sign-in failed on the server');
    await expect(exchangeCode(CONFIG, 'c', 'v', reply(200, { token_hash: 'x', type: 'signup' }))).rejects.toBeInstanceOf(SignInError);
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(exchangeCode(CONFIG, 'c', 'v', offline)).rejects.toThrow('Can’t reach');
  });
});

describe('readCloudConfig', () => {
  const base = { VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' };
  beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  it('is off without settings', () => {
    expect(readCloudConfig({})).toBeNull();
    expect(readCloudConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co' })).toBeNull();
  });
  it('reads the public settings, with markup.here as the default site', () => {
    expect(readCloudConfig(base)).toEqual({ url: 'https://abc.supabase.co', publishableKey: 'sb_publishable_x', siteUrl: 'https://markup.here' });
  });
  it('refuses a secret key so it can never ship', () => {
    expect(readCloudConfig({ ...base, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_x' })).toBeNull();
    const serviceRole = `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify({ role: 'service_role' })).replace(/=+$/, '')}.sig`;
    expect(readCloudConfig({ ...base, VITE_SUPABASE_PUBLISHABLE_KEY: serviceRole })).toBeNull();
  });
  it('wants https, except localhost in dev', () => {
    expect(readCloudConfig({ ...base, VITE_SUPABASE_URL: 'http://abc.supabase.co' })).toBeNull();
    expect(readCloudConfig({ ...base, VITE_SITE_URL: 'http://localhost:5174' })).toBeNull();
    expect(readCloudConfig({ ...base, VITE_SITE_URL: 'http://localhost:5174', DEV: true })?.siteUrl).toBe('http://localhost:5174');
  });
});

describe('vault', () => {
  it('stores the session encrypted and reads it back', async () => {
    const storage = memoryStorage();
    const { keys, current } = memoryKeys();
    const vault = createVault(keys, storage);
    const session = JSON.stringify({ access_token: 'secret-access', refresh_token: 'secret-refresh' });
    await vault.setItem('markup.session', session);
    const stored = storage.map.get(`${VAULT_PREFIX}markup.session`)!;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain('secret-refresh');
    expect(current()).toMatch(TOKEN);
    // A fresh run (new vault, same keychain and storage) can read it.
    expect(await createVault(keys, storage).getItem('markup.session')).toBe(session);
  });

  it('never touches the keychain when nothing is stored', async () => {
    const { keys } = memoryKeys();
    expect(await createVault(keys, memoryStorage()).getItem('markup.session')).toBeNull();
    expect(keys.get).not.toHaveBeenCalled();
    expect(keys.set).not.toHaveBeenCalled();
  });

  it('drops a tampered value, or one moved to another name', async () => {
    const storage = memoryStorage();
    const { keys } = memoryKeys();
    const vault = createVault(keys, storage);
    await vault.setItem('a', 'value');
    const slot = `${VAULT_PREFIX}a`;
    const [format, iv, data] = storage.map.get(slot)!.split('.');
    storage.map.set(`${VAULT_PREFIX}b`, storage.map.get(slot)!);
    expect(await vault.getItem('b')).toBeNull();
    expect(storage.map.has(`${VAULT_PREFIX}b`)).toBe(false);
    storage.map.set(slot, `${format}.${iv}.${data!.slice(0, -2)}AA`);
    expect(await vault.getItem('a')).toBeNull();
    expect(storage.map.has(slot)).toBe(false);
  });

  it('cannot read values written under another key', async () => {
    const storage = memoryStorage();
    await createVault(memoryKeys().keys, storage).setItem('a', 'value');
    expect(await createVault(memoryKeys('k'.repeat(43)).keys, storage).getItem('a')).toBeNull();
  });

  it('creates one key even when writes race', async () => {
    const storage = memoryStorage();
    const { keys } = memoryKeys();
    const vault = createVault(keys, storage);
    await Promise.all([vault.setItem('a', '1'), vault.setItem('b', '2'), vault.setItem('c', '3')]);
    expect(keys.set).toHaveBeenCalledTimes(1);
    expect(await vault.getItem('a')).toBe('1');
    expect(await vault.getItem('c')).toBe('3');
  });

  it('keeps the session in memory only when the credential store fails', async () => {
    const storage = memoryStorage();
    const warn = vi.fn();
    const keys: KeyStore = { get: async () => null, set: async () => Promise.reject(new Error('no secret service')) };
    const vault = createVault(keys, storage, warn);
    await vault.setItem('a', 'value');
    expect(storage.map.size).toBe(0);
    expect(await vault.getItem('a')).toBe('value');
    expect(warn).toHaveBeenCalledTimes(1);
    await vault.removeItem('a');
    expect(await vault.getItem('a')).toBeNull();
  });

  it('keeps the ciphertext when the keychain is only locked', async () => {
    const storage = memoryStorage();
    const { keys } = memoryKeys();
    await createVault(keys, storage).setItem('a', 'value');
    const locked: KeyStore = { get: async () => Promise.reject(new Error('locked')), set: keys.set };
    expect(await createVault(locked, storage, () => undefined).getItem('a')).toBeNull();
    expect(storage.map.has(`${VAULT_PREFIX}a`)).toBe(true);
  });
});

const USER = { id: 'u1', email: 'jane@example.com', user_metadata: { first_name: 'Jane', last_name: 'Doe', avatar_url: 'https://avatars.example/j.png' } } as unknown as User;

function fakeClient(opts: { user?: User | null } = {}) {
  let listener: ((u: User | null) => void) | null = null;
  const client = {
    currentUser: vi.fn(async () => opts.user ?? null),
    onChange: vi.fn((l: (u: User | null) => void) => {
      listener = l;
      return () => (listener = null);
    }),
    verify: vi.fn(async (_hash: string) => USER),
    signOut: vi.fn(async () => undefined),
    profile: vi.fn(async (_id: string) => ({ name: 'Jane from profile', avatar: null })),
    upsertUsage: vi.fn(async (_rows: unknown[]) => undefined),
    deleteUsage: vi.fn(async (_id: string) => undefined),
  } satisfies AccountClient;
  return { client, emit: (u: User | null) => listener?.(u) };
}

function setupAccount(opts: { user?: User | null; exchange?: (code: string, verifier: string) => Promise<string> } = {}) {
  const { client, emit } = fakeClient(opts);
  const opened: string[] = [];
  let clock = 1_000;
  const exchange = vi.fn(opts.exchange ?? (async () => 'f'.repeat(56)));
  const warn = vi.fn();
  const account = createAccount({ client, config: CONFIG, openUrl: (u) => opened.push(u), exchange, now: () => clock, warn });
  const states: AccountState[] = [];
  account.subscribe(() => states.push(account.getState()));
  return { account, client, emit, opened, exchange, warn, states, tick: (ms: number) => (clock += ms) };
}

const callbackFor = (url: string, code = 'c'.repeat(43), state?: string) =>
  `markup://auth/callback?code=${code}&state=${state ?? new URL(url).searchParams.get('state')}`;

describe('account store', () => {
  it('starts signed out, or signed in with the profile name', async () => {
    const out = setupAccount();
    await out.account.init();
    expect(out.account.getState()).toEqual({ status: 'signedOut' });

    const signedIn = setupAccount({ user: USER });
    await signedIn.account.init();
    const state = signedIn.account.getState();
    expect(state.status === 'signedIn' && state.user).toMatchObject({ id: 'u1', email: 'jane@example.com', name: 'Jane from profile', avatar: null });
  });

  it('shows the sign-in name and avatar until the profile loads', () => {
    expect(toAccountUser(USER)).toMatchObject({ name: 'Jane Doe', avatar: 'https://avatars.example/j.png' });
  });

  it('signs in through the browser: the challenge in the URL matches the verifier sent to the server', async () => {
    const s = setupAccount();
    await s.account.init();
    await s.account.signIn();
    expect(s.account.getState().status).toBe('waiting');
    expect(s.opened).toHaveLength(1);
    await s.account.handleUrls([callbackFor(s.opened[0]!)]);
    const [code, verifier] = s.exchange.mock.calls[0]!;
    expect(code).toBe('c'.repeat(43));
    expect(await s256(verifier)).toBe(new URL(s.opened[0]!).searchParams.get('challenge'));
    expect(s.client.verify).toHaveBeenCalledWith('f'.repeat(56));
    expect(s.account.getState().status).toBe('signedIn');
  });

  it('ignores links it did not ask for, without ending the real sign-in', async () => {
    const s = setupAccount();
    await s.account.init();
    await s.account.handleUrls([`markup://auth/callback?code=${'c'.repeat(43)}&state=${'s'.repeat(43)}`]);
    expect(s.exchange).not.toHaveBeenCalled();
    await s.account.signIn();
    await s.account.handleUrls([callbackFor(s.opened[0]!, 'c'.repeat(43), 'x'.repeat(43)), 'markup://file/abc']);
    expect(s.exchange).not.toHaveBeenCalled();
    expect(s.account.getState().status).toBe('waiting');
    expect(s.warn).toHaveBeenCalled();
  });

  it('uses a sign-in only once', async () => {
    const s = setupAccount();
    await s.account.init();
    await s.account.signIn();
    const link = callbackFor(s.opened[0]!);
    await s.account.handleUrls([link]);
    await s.account.handleUrls([link]);
    expect(s.exchange).toHaveBeenCalledTimes(1);
  });

  it('gives up after the timeout', async () => {
    vi.useFakeTimers();
    try {
      const s = setupAccount();
      await s.account.init();
      await s.account.signIn();
      const link = callbackFor(s.opened[0]!);
      vi.advanceTimersByTime(SIGN_IN_TIMEOUT_MS + 1);
      expect(s.account.getState()).toEqual({ status: 'signedOut', error: 'Sign-in timed out. Try again.' });
      await s.account.handleUrls([link]);
      expect(s.exchange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a callback that arrives after the deadline', async () => {
    const s = setupAccount();
    await s.account.init();
    await s.account.signIn();
    s.tick(SIGN_IN_TIMEOUT_MS + 1);
    await s.account.handleUrls([callbackFor(s.opened[0]!)]);
    expect(s.exchange).not.toHaveBeenCalled();
    expect(s.account.getState()).toEqual({ status: 'signedOut', error: 'Sign-in timed out. Try again.' });
  });

  it('shows the server’s message when the exchange fails', async () => {
    const s = setupAccount({ exchange: async () => Promise.reject(new SignInError('This sign-in link has expired.')) });
    await s.account.init();
    await s.account.signIn();
    await s.account.handleUrls([callbackFor(s.opened[0]!)]);
    expect(s.account.getState()).toEqual({ status: 'signedOut', error: 'This sign-in link has expired.' });
    expect(s.client.verify).not.toHaveBeenCalled();
  });

  it('cancels a waiting sign-in', async () => {
    const s = setupAccount();
    await s.account.init();
    await s.account.signIn();
    s.account.cancel();
    expect(s.account.getState()).toEqual({ status: 'signedOut' });
    await s.account.handleUrls([callbackFor(s.opened[0]!)]);
    expect(s.exchange).not.toHaveBeenCalled();
  });

  it('signs out, and stays signed in with an error when that fails', async () => {
    const s = setupAccount({ user: USER });
    await s.account.init();
    s.client.signOut.mockRejectedValueOnce(new Error('offline'));
    await s.account.signOut();
    const failed = s.account.getState();
    expect(failed.status === 'signedIn' && failed.error).toContain('Couldn’t sign out');
    await s.account.signOut();
    expect(s.account.getState()).toEqual({ status: 'signedOut' });
  });

  it('follows the session: a revoked refresh signs the app out', async () => {
    const s = setupAccount({ user: USER });
    await s.account.init();
    s.emit(null);
    expect(s.account.getState()).toEqual({ status: 'signedOut' });
  });
});

describe('toAccountUser', () => {
  it('keeps only https avatars', () => {
    const user = { ...USER, user_metadata: { avatar_url: 'javascript:alert(1)' } } as unknown as User;
    expect(toAccountUser(user).avatar).toBeNull();
    expect(toAccountUser(user, { name: null, avatar: 'http://x/y.png' }).avatar).toBeNull();
  });
});
