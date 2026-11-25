/**
 * Public settings for Markup accounts, baked in at build time. All three are public by design:
 * they ship inside the app, and row level security protects the data. A build without them (a
 * fork, a self-built copy) simply has no account features; everything else works the same.
 *
 * Never put a secret key here: `readCloudConfig` refuses one so it can never ship by mistake.
 */

export interface CloudConfig {
  /** Supabase project URL, https://<ref>.supabase.co */
  url: string;
  /** Publishable key (sb_publishable_…) or the legacy anon JWT. */
  publishableKey: string;
  /** The website that hosts sign-in. */
  siteUrl: string;
}

export const DEFAULT_SITE_URL = 'https://markup.here';

type Env = Record<string, string | boolean | undefined>;

function httpsUrl(value: string, allowLocalHttp: boolean): string | null {
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readCloudConfig(env: Env): CloudConfig | null {
  const dev = env.DEV === true;
  const rawUrl = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL.trim() : '';
  const key = typeof env.VITE_SUPABASE_PUBLISHABLE_KEY === 'string' ? env.VITE_SUPABASE_PUBLISHABLE_KEY.trim() : '';
  if (!rawUrl || !key) return null;
  if (key.startsWith('sb_secret_') || /service_role/.test(decodeJwtRole(key) ?? '')) {
    console.error('Accounts are off: VITE_SUPABASE_PUBLISHABLE_KEY holds a secret key. Use the publishable key.');
    return null;
  }
  const url = httpsUrl(rawUrl, dev);
  const siteUrl = httpsUrl(typeof env.VITE_SITE_URL === 'string' && env.VITE_SITE_URL.trim() ? env.VITE_SITE_URL.trim() : DEFAULT_SITE_URL, dev);
  if (!url || !siteUrl) {
    console.error('Accounts are off: VITE_SUPABASE_URL and VITE_SITE_URL must be https URLs.');
    return null;
  }
  return { url, publishableKey: key, siteUrl };
}

/** The `role` claim of a legacy JWT key, to catch a service_role key pasted by mistake. */
function decodeJwtRole(key: string): string | null {
  if (!key.startsWith('eyJ')) return null;
  try {
    const payload = key.split('.')[1] ?? '';
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { role?: unknown };
    return typeof json.role === 'string' ? json.role : null;
  } catch {
    return null;
  }
}
