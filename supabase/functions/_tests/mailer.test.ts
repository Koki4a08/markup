import { describe, expect, it, vi } from 'vitest';
import {
  MailerError,
  mailerConfigFromEnv,
  maskEmail,
  sendMail,
  type MailLogEntry,
  type MailMessage,
  type SendOptions,
} from '../_shared/mailer.ts';

const KEY = 'ik_test_secret_key_value_123';
const config = { url: 'https://mail.example.test/api/v1/send', apiKey: KEY };
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const message: MailMessage = {
  to: 'jane@example.com',
  subject: 'Confirm your email to finish signing up for Markup',
  text: 'Secret body text with a link https://example.com/verify?token=abc',
  html: '<p>Secret body html <img src="cid:logo" alt="Logo"></p>',
  from_name: 'Markup',
  inline_images: [{ cid: 'logo', content: PNG_1X1, content_type: 'image/png' }],
};

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function setup(responses: Array<Response | Error>, extra: Partial<SendOptions> = {}) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const logs: MailLogEntry[] = [];
  const sleep = vi.fn(async () => {});
  const opts: SendOptions = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    logger: (entry) => logs.push(entry),
    sleep,
    random: () => 0.5,
    ...extra,
  };
  return { fetch, logs, sleep, opts };
}

describe('sendMail', () => {
  it('POSTs JSON with the bearer key and returns the Message-ID on 202', async () => {
    const { fetch, opts, logs } = setup([json(202, { status: 'queued', message_id: '<abc@mail.example.test>' })]);
    const result = await sendMail(config, message, opts);

    expect(result).toEqual({ messageId: '<abc@mail.example.test>', status: 202, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(config.url);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' });
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      to: ['jane@example.com'],
      subject: message.subject,
      text: message.text,
      html: message.html,
      from_name: 'Markup',
      inline_images: [{ cid: 'logo', content: PNG_1X1, content_type: 'image/png' }],
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'info', event: 'mail.sent', to: ['j***@example.com'], status: 202 });
  });

  it('reads the Message-ID from the response header when the body has none', async () => {
    const { opts } = setup([new Response('', { status: 202, headers: { 'Message-ID': '<hdr@x>' } })]);
    expect((await sendMail(config, message, opts)).messageId).toBe('<hdr@x>');
  });

  it.each([
    ['bad recipient', { to: 'not-an-email' }],
    ['header injection in subject', { subject: 'Hello\r\nBcc: evil@example.com' }],
    ['empty subject', { subject: '  ' }],
    ['empty text', { text: '' }],
    ['empty html', { html: '<div> </div>' }],
    ['bad reply_to', { reply_to: 'nope' }],
    ['line break in from_name', { from_name: 'Markup\nX' }],
    ['inline image without html', { html: undefined }],
    ['unsafe cid', { inline_images: [{ cid: 'a b', content: PNG_1X1, content_type: 'image/png' as const }] }],
    ['svg image', { inline_images: [{ cid: 'a', content: PNG_1X1, content_type: 'image/svg+xml' as never }] }],
    ['not base64', { inline_images: [{ cid: 'a', content: 'data:image/png;base64,xx', content_type: 'image/png' as const }] }],
    ['image over 1 MiB', { inline_images: [{ cid: 'a', content: 'A'.repeat(1_400_000), content_type: 'image/png' as const }] }],
  ])('rejects %s before any request', async (_name, patch) => {
    const { fetch, opts } = setup([json(202, {})]);
    const err = await sendMail(config, { ...message, ...patch } as MailMessage, opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailerError);
    expect((err as MailerError).code).toBe('invalid_input');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not retry 400 and keeps the upstream error for logs only', async () => {
    const { fetch, opts, logs } = setup([json(400, { error: 'to contains an invalid email' })]);
    const err = (await sendMail(config, message, opts).catch((e: unknown) => e)) as MailerError;
    expect(err.code).toBe('rejected');
    expect(err.status).toBe(400);
    expect(err.detail).toBe('to contains an invalid email');
    expect(err.message).not.toContain('invalid email');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logs.at(-1)).toMatchObject({ event: 'mail.failed', upstream_error: 'to contains an invalid email' });
  });

  it('does not retry 401', async () => {
    const { fetch, opts } = setup([json(401, { error: 'invalid api key' }), json(202, {})]);
    const err = (await sendMail(config, message, opts).catch((e: unknown) => e)) as MailerError;
    expect(err.code).toBe('unauthorized');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry 500', async () => {
    const { fetch, opts } = setup([json(500, { error: 'boom' }), json(202, {})]);
    const err = (await sendMail(config, message, opts).catch((e: unknown) => e)) as MailerError;
    expect(err.code).toBe('upstream');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries 503 and 502 with jittered exponential backoff, then succeeds', async () => {
    const { fetch, opts, sleep, logs } = setup([json(503, { error: 'busy' }), json(502, {}), json(202, { message_id: 'm1' })]);
    const result = await sendMail(config, message, { ...opts, baseDelayMs: 400, maxDelayMs: 4000 });
    expect(result.attempts).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    // random() = 0.5 → half of 400 * 2^(n-1)
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([200, 400]);
    expect(logs.filter((l) => l.event === 'mail.retry')).toHaveLength(2);
  });

  it('honours Retry-After on 429, capped by maxDelayMs', async () => {
    const { opts, sleep } = setup([json(429, { error: 'slow down' }, { 'Retry-After': '30' }), json(202, {})]);
    await sendMail(config, message, { ...opts, maxDelayMs: 1500 });
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it('gives up after maxAttempts with a rate_limited error', async () => {
    const { fetch, opts } = setup([json(429, {}), json(429, {}), json(429, {})]);
    const err = (await sendMail(config, message, { ...opts, maxAttempts: 3 }).catch((e: unknown) => e)) as MailerError;
    expect(err.code).toBe('rate_limited');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('stops retrying when the next wait would pass the deadline', async () => {
    const { fetch, opts } = setup([json(503, {}), json(202, {})], { now: () => 0 });
    const err = (await sendMail(config, message, { ...opts, deadlineMs: 300, baseDelayMs: 400, random: () => 1 }).catch(
      (e: unknown) => e,
    )) as MailerError;
    expect(err.code).toBe('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts a slow request and does not retry it (it may have been accepted)', async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const err = (await sendMail(config, message, {
      fetch: fetch as unknown as typeof globalThis.fetch,
      logger: () => {},
      timeoutMs: 20,
    }).catch((e: unknown) => e)) as MailerError;
    expect(err.code).toBe('timeout');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps a network failure to a safe error', async () => {
    const { opts } = setup([new TypeError('fetch failed: getaddrinfo ENOTFOUND')]);
    const err = (await sendMail(config, message, opts).catch((e: unknown) => e)) as MailerError;
    expect(err.code).toBe('network');
    expect(err.message).toBe('Could not reach the email service.');
  });

  it('never logs the key, the subject or the body', async () => {
    const { opts, logs } = setup([json(503, {}), json(400, { error: 'subject is invalid' })]);
    await sendMail(config, message, opts).catch(() => {});
    const out = JSON.stringify(logs);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain('Secret body');
    expect(out).not.toContain(message.subject);
    expect(out).not.toContain('jane@example.com');
  });
});

describe('mailerConfigFromEnv', () => {
  it('reads the URL and key', () => {
    const env = { MAILER_URL: 'https://mail.example.test/api/v1/send', MAILER_API_KEY: KEY } as Record<string, string>;
    expect(mailerConfigFromEnv((k) => env[k])).toEqual({ url: env.MAILER_URL, apiKey: KEY });
  });

  it('names missing variables without values', () => {
    const err = (() => {
      try {
        mailerConfigFromEnv(() => undefined);
      } catch (e) {
        return e as MailerError;
      }
    })();
    expect(err?.code).toBe('config');
    expect(err?.message).toContain('MAILER_URL, MAILER_API_KEY');
  });

  it('refuses plain http and never echoes the key', () => {
    const env = { MAILER_URL: 'http://10.0.0.5/api/v1/send', MAILER_API_KEY: KEY } as Record<string, string>;
    expect(() => mailerConfigFromEnv((k) => env[k])).toThrow(/must use https/);
    try {
      mailerConfigFromEnv((k) => env[k]);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEY);
    }
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j***@example.com');
    expect(maskEmail('broken')).toBe('***');
  });
});
