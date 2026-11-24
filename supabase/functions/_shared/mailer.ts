/**
 * Client for the private Mail API (POST https://…/api/v1/send). Server-only: the API key comes from
 * the Edge Function environment and never reaches a browser, the desktop binary or the extension.
 *
 * - Valid request: HTTP 202 with a Message-ID.
 * - Retries only 429, 502 and 503, with capped exponential backoff and full jitter, inside a time
 *   budget. Everything else (400, 401, 5xx, timeouts, network errors) fails at once: a timed-out
 *   request may still have been accepted, and retrying it would send the email twice.
 * - Logs are structured JSON without message bodies, subjects or secrets; recipients are masked.
 * - TLS is the platform default. Nothing here weakens certificate checks.
 *
 * Plain TypeScript with web APIs only (fetch, AbortController), so it runs in Deno and in Vitest.
 */

export type InlineImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface InlineImage {
  /** Referenced from HTML as src="cid:<cid>". Letters, numbers, dot, underscore, dash. */
  cid: string;
  /** Base64 image bytes, no data: prefix. */
  content: string;
  content_type: InlineImageType;
}

export interface MailMessage {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  from_name?: string;
  inline_images?: InlineImage[];
}

export interface MailerConfig {
  url: string;
  apiKey: string;
}

export type MailerErrorCode =
  | 'config' // missing or unsafe server configuration
  | 'invalid_input' // the message failed local validation; nothing was sent
  | 'rejected' // the API refused the message (400 and other non-retryable 4xx)
  | 'unauthorized' // 401 / 403: wrong or revoked API key
  | 'rate_limited' // 429 after all retries
  | 'unavailable' // 502 / 503 after all retries
  | 'upstream' // any other non-2xx
  | 'timeout'
  | 'network';

/** A failure that is safe to show: `message` never contains the key, the body or upstream text. */
export class MailerError extends Error {
  readonly code: MailerErrorCode;
  readonly status: number | undefined;
  /** Upstream error text or validation detail, for server logs only. */
  readonly detail: string | undefined;

  constructor(code: MailerErrorCode, message: string, opts: { status?: number; detail?: string } = {}) {
    super(message);
    this.name = 'MailerError';
    this.code = code;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

export interface MailLogEntry {
  level: 'info' | 'warn' | 'error';
  event: string;
  [key: string]: unknown;
}

export type MailLogger = (entry: MailLogEntry) => void;

export const consoleLogger: MailLogger = (entry) => {
  const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.log(line);
};

export interface SendOptions {
  fetch?: typeof fetch;
  logger?: MailLogger;
  /** Short label for logs, e.g. the template name. Never put personal data here. */
  tag?: string;
  /** Abort a single attempt after this long. Default 8000 ms. */
  timeoutMs?: number;
  /** Total time budget across attempts and backoff. Default 20000 ms. */
  deadlineMs?: number;
  /** Attempts including the first. Default 3. */
  maxAttempts?: number;
  /** First backoff step. Default 400 ms. */
  baseDelayMs?: number;
  /** Cap for one backoff wait (also caps Retry-After). Default 4000 ms. */
  maxDelayMs?: number;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export interface SendResult {
  messageId: string | null;
  status: number;
  attempts: number;
}

export const MAX_INLINE_IMAGES = 20;
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;
export const MAX_INLINE_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const RETRYABLE = new Set([429, 502, 503]);
const INLINE_TYPES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const CID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const LINE_BREAK_RE = /[\r\n]/;

/**
 * Reads MAILER_URL and MAILER_API_KEY. Throws a `config` error naming the missing variables (never
 * their values) or refusing a non-HTTPS URL.
 */
export function mailerConfigFromEnv(get: (name: string) => string | undefined): MailerConfig {
  const url = get('MAILER_URL')?.trim();
  const apiKey = get('MAILER_API_KEY')?.trim();
  const missing = [!url && 'MAILER_URL', !apiKey && 'MAILER_API_KEY'].filter(Boolean);
  if (missing.length) throw new MailerError('config', `Email is not configured: missing ${missing.join(', ')}.`);
  let parsed: URL;
  try {
    parsed = new URL(url!);
  } catch {
    throw new MailerError('config', 'Email is not configured: MAILER_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') throw new MailerError('config', 'Email is not configured: MAILER_URL must use https.');
  return { url: parsed.toString(), apiKey: apiKey! };
}

/** Sends one message. Resolves with the Message-ID on success, throws `MailerError` otherwise. */
export async function sendMail(config: MailerConfig, message: MailMessage, opts: SendOptions = {}): Promise<SendResult> {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const log = opts.logger ?? consoleLogger;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 400;
  const maxDelayMs = opts.maxDelayMs ?? 4000;
  const started = now();
  const deadline = started + (opts.deadlineMs ?? 20000);

  const body = normalize(message);
  const meta = {
    tag: opts.tag,
    to: body.to.map(maskEmail),
    recipients: body.to.length + (body.cc?.length ?? 0) + (body.bcc?.length ?? 0),
    images: body.inline_images?.length ?? 0,
  };
  const payload = JSON.stringify(body);

  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - now();
    const attemptTimeout = Math.min(timeoutMs, Math.max(remaining, 0));
    if (attemptTimeout <= 0) {
      const err = new MailerError('timeout', 'The email service did not answer in time.');
      log({ level: 'error', event: 'mail.failed', ...meta, code: err.code, attempts: attempt - 1, ms: now() - started });
      throw err;
    }

    let res: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), attemptTimeout);
    try {
      res = await doFetch(config.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: payload,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (cause) {
      clearTimeout(timer);
      const timedOut = controller.signal.aborted;
      const err = timedOut
        ? new MailerError('timeout', 'The email service did not answer in time.')
        : new MailerError('network', 'Could not reach the email service.', { detail: errorName(cause) });
      log({ level: 'error', event: 'mail.failed', ...meta, code: err.code, attempts: attempt, ms: now() - started });
      throw err;
    }

    let parsed: unknown = null;
    try {
      const raw = await res.text();
      parsed = raw ? safeJson(raw) : null;
    } catch {
      // A body that cannot be read is treated as empty; the status decides.
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const messageId = readMessageId(res, parsed);
      log({ level: 'info', event: 'mail.sent', ...meta, status: res.status, attempts: attempt, ms: now() - started, message_id: messageId });
      return { messageId, status: res.status, attempts: attempt };
    }

    const detail = readUpstreamError(parsed);
    if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after'), now()) : null;
      const delay = retryAfter !== null ? Math.min(maxDelayMs, retryAfter) : Math.round(random() * backoff);
      // Only wait if a useful attempt still fits in the budget afterwards.
      if (now() + delay + 250 < deadline) {
        log({ level: 'warn', event: 'mail.retry', ...meta, status: res.status, attempt, delay_ms: delay });
        await sleep(delay);
        continue;
      }
    }

    const err = errorForStatus(res.status, detail);
    log({
      level: 'error',
      event: 'mail.failed',
      ...meta,
      code: err.code,
      status: res.status,
      attempts: attempt,
      ms: now() - started,
      upstream_error: detail,
    });
    throw err;
  }
}

/** Validates and returns the exact JSON body for the API. Throws `invalid_input` before any request. */
export function normalize(message: MailMessage): Omit<MailMessage, 'to'> & { to: string[] } {
  const invalid = (detail: string) => new MailerError('invalid_input', 'The email could not be built.', { detail });

  const to = (Array.isArray(message.to) ? message.to : [message.to]).map((a) => String(a ?? '').trim());
  if (to.length === 0) throw invalid('to is required');
  const cc = message.cc?.map((a) => a.trim()) ?? [];
  const bcc = message.bcc?.map((a) => a.trim()) ?? [];
  for (const [field, list] of [['to', to], ['cc', cc], ['bcc', bcc]] as const) {
    for (const address of list) if (!isEmail(address)) throw invalid(`${field} contains an invalid email`);
  }
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw invalid(`at most ${MAX_RECIPIENTS} recipients`);

  const subject = String(message.subject ?? '').trim();
  if (!subject || subject.length > 200 || LINE_BREAK_RE.test(subject)) throw invalid('subject is invalid');

  const text = String(message.text ?? '');
  if (!text.trim()) throw invalid('text is required');

  const html = message.html;
  if (html !== undefined && !html.replace(/<[^>]*>/g, '').trim()) throw invalid('html has no readable content');

  const reply_to = message.reply_to?.trim();
  if (reply_to !== undefined && !isEmail(reply_to)) throw invalid('reply_to is invalid');

  const from_name = message.from_name?.trim();
  if (from_name !== undefined && (!from_name || from_name.length > 100 || LINE_BREAK_RE.test(from_name))) {
    throw invalid('from_name is invalid');
  }

  const images = message.inline_images ?? [];
  if (images.length) {
    if (html === undefined) throw invalid('inline_images requires html');
    if (images.length > MAX_INLINE_IMAGES) throw invalid(`at most ${MAX_INLINE_IMAGES} inline images`);
    let total = 0;
    const seen = new Set<string>();
    images.forEach((image, i) => {
      if (!CID_RE.test(image.cid)) throw invalid(`inline_images[${i}].cid is invalid`);
      if (seen.has(image.cid)) throw invalid(`inline_images[${i}].cid is a duplicate`);
      seen.add(image.cid);
      if (!INLINE_TYPES.has(image.content_type)) throw invalid(`inline_images[${i}].content_type is not supported`);
      if (!BASE64_RE.test(image.content) || image.content.length % 4 !== 0) {
        throw invalid(`inline_images[${i}].content must be base64`);
      }
      const bytes = base64Size(image.content);
      if (bytes > MAX_INLINE_IMAGE_BYTES) throw invalid(`inline_images[${i}] is larger than 1 MiB`);
      total += bytes;
    });
    if (total > MAX_INLINE_TOTAL_BYTES) throw invalid('inline images are larger than 5 MiB in total');
  }

  return {
    to,
    subject,
    text,
    ...(html !== undefined && { html }),
    ...(cc.length > 0 && { cc }),
    ...(bcc.length > 0 && { bcc }),
    ...(reply_to !== undefined && { reply_to }),
    ...(from_name !== undefined && { from_name }),
    ...(images.length > 0 && { inline_images: images.map(({ cid, content, content_type }) => ({ cid, content, content_type })) }),
  };
}

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** "jane.doe@example.com" → "j***@example.com", for logs. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${address[0]}***${address.slice(at)}`;
}

function errorForStatus(status: number, detail: string | undefined): MailerError {
  const opts = { status, detail };
  if (status === 401 || status === 403) return new MailerError('unauthorized', 'The email service refused our credentials.', opts);
  if (status === 429) return new MailerError('rate_limited', 'Too many emails right now. Try again in a minute.', opts);
  if (status === 502 || status === 503) return new MailerError('unavailable', 'The email service is unavailable. Try again shortly.', opts);
  if (status >= 400 && status < 500) return new MailerError('rejected', 'The email service rejected the message.', opts);
  return new MailerError('upstream', 'The email service failed to send the message.', opts);
}

function readMessageId(res: Response, body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    for (const key of ['message_id', 'messageId', 'Message-ID', 'id']) {
      const value = b[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return res.headers.get('message-id');
}

/** The API answers non-2xx with {"error": "…"}; tolerate {"error": {"message": "…"}} too. */
function readUpstreamError(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as Record<string, unknown>).error ?? (body as Record<string, unknown>).message;
  const text =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string'
        ? ((error as Record<string, unknown>).message as string)
        : undefined;
  return text?.slice(0, 300);
}

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function base64Size(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

function errorName(cause: unknown): string {
  return cause instanceof Error ? cause.name : 'Error';
}
