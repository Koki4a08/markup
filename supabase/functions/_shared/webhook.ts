/**
 * Standard Webhooks signature check (https://www.standardwebhooks.com), as used by Supabase Auth
 * hooks. The secret from the dashboard looks like "v1,whsec_<base64>".
 *
 * Signed content: `${webhook-id}.${webhook-timestamp}.${raw body}`, HMAC-SHA256 with the decoded
 * secret, base64. `webhook-signature` holds one or more space-separated "v1,<signature>" entries.
 */

const TOLERANCE_SECONDS = 5 * 60;

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

export interface WebhookHeaders {
  get(name: string): string | null;
}

/** Throws `WebhookVerificationError` unless the body was signed with `secret` in the last 5 minutes. */
export async function verifyWebhook(
  secret: string,
  body: string,
  headers: WebhookHeaders,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError('Missing webhook headers');

  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) throw new WebhookVerificationError('Invalid webhook timestamp');
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) throw new WebhookVerificationError('Webhook timestamp is too old or too new');

  const expected = await sign(secret, `${id}.${timestamp}.${body}`);
  for (const entry of signatures.split(' ')) {
    const [version, signature] = entry.split(',', 2);
    if (version === 'v1' && signature && timingSafeEqual(signature, expected)) return;
  }
  throw new WebhookVerificationError('No matching signature');
}

/** Base64 HMAC-SHA256 of `content`. Exported for tests (to sign fixtures). */
export async function sign(secret: string, content: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(content));
  return toBase64(new Uint8Array(mac));
}

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  const trimmed = secret.trim().replace(/^v1,/, '').replace(/^whsec_/, '');
  if (!trimmed) throw new WebhookVerificationError('Webhook secret is empty');
  try {
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new WebhookVerificationError('Webhook secret is not valid base64');
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
