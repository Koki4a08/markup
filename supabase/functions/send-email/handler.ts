/**
 * Supabase Auth "Send Email Hook". When the hook is on, Supabase stops sending auth emails itself
 * and calls this function instead; it renders Markup's templates and sends them through the Mail API.
 *
 * Contract (https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook):
 * - Request is signed with Standard Webhooks; the secret is SEND_EMAIL_HOOK_SECRET.
 * - Reply 200 with {} on success, or a status with {"error": {"http_code", "message"}}.
 * - Supabase waits about 5 seconds, so every send shares one time budget below that.
 */
import { MailerError, consoleLogger, mailerConfigFromEnv, sendMail, type MailLogger, type MailerConfig, type SendOptions } from '../_shared/mailer.ts';
import { UnsupportedEmailError, buildAuthEmails, type BuiltEmail, type HookPayload } from '../_shared/email/templates.ts';
import { WebhookVerificationError, verifyWebhook } from '../_shared/webhook.ts';

export interface HookDeps {
  env: (name: string) => string | undefined;
  fetch?: typeof fetch;
  logger?: MailLogger;
  now?: () => number;
  /** Overrides for tests (sleep, random, timeouts). */
  sendOptions?: Partial<SendOptions>;
}

/** Below Supabase's ~5 s hook timeout, leaving room for the response. */
export const HOOK_BUDGET_MS = 4500;
const ATTEMPT_TIMEOUT_MS = 3500;
const MAX_BODY_BYTES = 256 * 1024;

const TRY_AGAIN = 'We could not send the email right now. Try again in a minute.';

export async function handleSendEmailHook(req: Request, deps: HookDeps): Promise<Response> {
  const log = deps.logger ?? consoleLogger;
  const now = deps.now ?? Date.now;
  const started = now();

  if (req.method !== 'POST') return failure(405, 'Method not allowed.');

  const secret = deps.env('SEND_EMAIL_HOOK_SECRET')?.trim();
  const supabaseUrl = deps.env('SUPABASE_URL')?.trim();
  let config: MailerConfig;
  try {
    config = mailerConfigFromEnv(deps.env);
  } catch (err) {
    log({ level: 'error', event: 'auth_email.config', detail: err instanceof Error ? err.message : 'invalid config' });
    return failure(500, TRY_AGAIN);
  }
  if (!secret || !supabaseUrl) {
    const missing = [!secret && 'SEND_EMAIL_HOOK_SECRET', !supabaseUrl && 'SUPABASE_URL'].filter(Boolean).join(', ');
    log({ level: 'error', event: 'auth_email.config', detail: `missing ${missing}` });
    return failure(500, TRY_AGAIN);
  }

  const body = await req.text();
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return failure(413, 'Payload too large.');

  try {
    await verifyWebhook(secret, body, req.headers, Math.floor(now() / 1000));
  } catch (err) {
    const reason = err instanceof WebhookVerificationError ? err.message : 'verification failed';
    log({ level: 'warn', event: 'auth_email.unauthorized', reason });
    return failure(401, 'Invalid signature.');
  }

  let payload: HookPayload;
  try {
    payload = parsePayload(body);
  } catch {
    log({ level: 'warn', event: 'auth_email.bad_payload' });
    return failure(400, 'Invalid payload.');
  }

  const type = payload.email_data.email_action_type;
  let emails: BuiltEmail[];
  try {
    emails = buildAuthEmails(payload, { supabaseUrl, siteUrl: deps.env('SITE_URL') });
  } catch (err) {
    const detail = err instanceof UnsupportedEmailError ? err.message : 'template failed';
    log({ level: 'error', event: 'auth_email.unsupported', type, detail });
    return failure(400, 'This kind of email is not supported.');
  }

  // Optional: where replies go. The sender mailbox itself is owned by the API key.
  const replyTo = deps.env('MAIL_REPLY_TO')?.trim() || undefined;

  for (const { template, message } of emails) {
    const remaining = HOOK_BUDGET_MS - (now() - started);
    try {
      await sendMail(config, replyTo ? { ...message, reply_to: replyTo } : message, {
        fetch: deps.fetch,
        logger: log,
        now,
        tag: template,
        timeoutMs: ATTEMPT_TIMEOUT_MS,
        deadlineMs: remaining,
        maxAttempts: 3,
        baseDelayMs: 250,
        maxDelayMs: 1000,
        ...deps.sendOptions,
      });
    } catch (err) {
      if (err instanceof MailerError) return failure(statusFor(err), publicMessage(err));
      log({ level: 'error', event: 'auth_email.crash', type, detail: err instanceof Error ? err.name : 'unknown' });
      return failure(500, TRY_AGAIN);
    }
  }

  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function parsePayload(body: string): HookPayload {
  const value = JSON.parse(body) as unknown;
  if (!value || typeof value !== 'object') throw new Error('not an object');
  const { user, email_data } = value as Record<string, unknown>;
  if (!user || typeof user !== 'object') throw new Error('missing user');
  if (!email_data || typeof email_data !== 'object') throw new Error('missing email_data');
  if (typeof (email_data as Record<string, unknown>).email_action_type !== 'string') throw new Error('missing type');
  return value as HookPayload;
}

function statusFor(err: MailerError): number {
  switch (err.code) {
    case 'rate_limited':
      return 429;
    case 'unavailable':
      return 503;
    case 'timeout':
      return 504;
    case 'invalid_input':
    case 'rejected':
      return 400;
    default:
      return 502;
  }
}

/** What the person signing in may see. Never upstream text, never configuration details. */
function publicMessage(err: MailerError): string {
  if (err.code === 'rate_limited') return 'Too many emails right now. Wait a minute and try again.';
  if (err.code === 'invalid_input' || err.code === 'rejected') return 'We could not send an email to this address.';
  return TRY_AGAIN;
}

function failure(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { http_code: status, message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
