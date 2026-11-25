/**
 * Desktop sign-in through the website, PKCE style.
 *
 * 1. The app makes a random verifier and opens markup.here/login/?client=desktop with
 *    challenge = base64url(SHA-256(verifier)) and a random state.
 * 2. The user signs in there and clicks "Open Markup"; the site opens
 *    markup://auth/callback?code=…&state=….
 * 3. The app checks the state, then sends code + verifier to the desktop-auth Edge Function and
 *    gets a one-time token it turns into its own session (auth.verifyOtp).
 *
 * The verifier never leaves this process until step 3, and goes only to our own function over
 * HTTPS. A program that grabs the markup:// link gets a code that is useless without it.
 */
import type { CloudConfig } from './config';
import { toBase64url } from './vault';

/** How long the app waits for the browser before giving up on a sign-in. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface PendingSignIn {
  verifier: string;
  challenge: string;
  state: string;
  expiresAt: number;
}

export const randomToken = () => toBase64url(crypto.getRandomValues(new Uint8Array(32)));

/** The PKCE S256 transform. */
export async function s256(verifier: string): Promise<string> {
  return toBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export async function createPendingSignIn(now: number): Promise<PendingSignIn> {
  const verifier = randomToken();
  return { verifier, challenge: await s256(verifier), state: randomToken(), expiresAt: now + SIGN_IN_TIMEOUT_MS };
}

/** The website page that signs in (or signs up) for this app. */
export function signInPageUrl(siteUrl: string, pending: Pick<PendingSignIn, 'challenge' | 'state'>, page: 'login' | 'signup' = 'login'): string {
  const params = new URLSearchParams({ client: 'desktop', challenge: pending.challenge, state: pending.state });
  return `${siteUrl}/${page}/?${params.toString()}`;
}

/** Reads markup://auth/callback?code=…&state=…; null for anything else (other markup:// links included). */
export function parseCallbackUrl(raw: string): { code: string; state: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'markup:' || url.hostname !== 'auth' || !/^\/callback\/?$/.test(url.pathname)) return null;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || !TOKEN.test(code) || !TOKEN.test(state)) return null;
  return { code, state };
}

export class SignInError extends Error {}

/** Trades the code and verifier for a one-time token (the hash for auth.verifyOtp). */
export async function exchangeCode(config: CloudConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.url}/functions/v1/desktop-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.publishableKey },
      body: JSON.stringify({ action: 'exchange', code, verifier }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SignInError('Can’t reach Markup’s servers. Check your connection and try again.');
  }
  const data = (await res.json().catch(() => null)) as { token_hash?: unknown; type?: unknown; message?: unknown } | null;
  if (res.ok && typeof data?.token_hash === 'string' && data.type === 'magiclink') return data.token_hash;
  if (res.status >= 400 && res.status < 500 && typeof data?.message === 'string') throw new SignInError(data.message);
  throw new SignInError('Sign-in failed on the server. Try again in a minute.');
}
