import { describe, expect, it, vi } from 'vitest';
import { handleSendEmailHook } from '../send-email/handler.ts';
import { buildAuthEmails, type HookPayload } from '../_shared/email/templates.ts';
import { LOGO_CID } from '../_shared/email/layout.ts';
import { sign, verifyWebhook, WebhookVerificationError } from '../_shared/webhook.ts';
import type { MailLogEntry } from '../_shared/mailer.ts';

const SECRET = `v1,whsec_${btoa('a-very-secret-hook-key-32-bytes!')}`;
const KEY = 'ik_test_secret_key_value_123';
const SUPABASE_URL = 'https://abcdefgh.supabase.co';
const NOW = 1_800_000_000;
const env: Record<string, string> = {
  MAILER_URL: 'https://mail.example.test/api/v1/send',
  MAILER_API_KEY: KEY,
  SEND_EMAIL_HOOK_SECRET: SECRET,
  SUPABASE_URL,
};

function payload(type: string, extra: Partial<HookPayload['email_data']> = {}, user: Partial<HookPayload['user']> = {}): HookPayload {
  return {
    user: { id: 'u1', email: 'jane@example.com', ...user },
    email_data: {
      token: '305805',
      token_hash: 'pkce_7d5b7b1964cf5d388340a7f04f1dbb5e',
      redirect_to: 'https://markup.here/login/?next=%2Fapp',
      email_action_type: type,
      site_url: 'https://markup.here',
      token_new: '',
      token_hash_new: '',
      ...extra,
    },
  };
}

async function signedRequest(body: string, opts: { secret?: string; ts?: number; id?: string } = {}) {
  const id = opts.id ?? 'msg_1';
  const ts = String(opts.ts ?? NOW);
  const signature = await sign(opts.secret ?? SECRET, `${id}.${ts}.${body}`);
  return new Request('https://fn.example.test/send-email', {
    method: 'POST',
    headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${signature}`, 'content-type': 'application/json' },
    body,
  });
}

function deps(responses: Response[]) {
  const fetch = vi.fn(async () => responses.shift() ?? new Response('{}', { status: 202 }));
  const logs: MailLogEntry[] = [];
  return {
    fetch,
    logs,
    deps: {
      env: (k: string) => env[k],
      fetch: fetch as unknown as typeof globalThis.fetch,
      logger: (e: MailLogEntry) => logs.push(e),
      now: () => NOW * 1000,
      sendOptions: { sleep: async () => {}, random: () => 0 },
    },
  };
}

describe('verifyWebhook', () => {
  const headers = (h: Record<string, string>) => new Headers(h);

  it('accepts a valid signature, also among several', async () => {
    const sig = await sign(SECRET, `id.${NOW}.body`);
    await expect(
      verifyWebhook(SECRET, 'body', headers({ 'webhook-id': 'id', 'webhook-timestamp': String(NOW), 'webhook-signature': `v1,bogus v1,${sig}` }), NOW),
    ).resolves.toBeUndefined();
  });

  it('rejects a tampered body, a wrong secret and an old timestamp', async () => {
    const sig = await sign(SECRET, `id.${NOW}.body`);
    const h = headers({ 'webhook-id': 'id', 'webhook-timestamp': String(NOW), 'webhook-signature': `v1,${sig}` });
    await expect(verifyWebhook(SECRET, 'body!', h, NOW)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyWebhook(`v1,whsec_${btoa('other')}`, 'body', h, NOW)).rejects.toBeInstanceOf(WebhookVerificationError);
    await expect(verifyWebhook(SECRET, 'body', h, NOW + 600)).rejects.toThrow(/too old/);
    await expect(verifyWebhook(SECRET, 'body', headers({}), NOW)).rejects.toThrow(/Missing/);
  });
});

describe('buildAuthEmails', () => {
  const ctx = { supabaseUrl: SUPABASE_URL };

  it.each(['signup', 'magiclink', 'recovery', 'invite'])('%s: link to /auth/v1/verify, HTML and text agree', (type) => {
    const [email, ...rest] = buildAuthEmails(payload(type), ctx);
    expect(rest).toHaveLength(0);
    const m = email!.message;
    const url = `${SUPABASE_URL}/auth/v1/verify?token=pkce_7d5b7b1964cf5d388340a7f04f1dbb5e&type=${type}&redirect_to=https%3A%2F%2Fmarkup.here%2Flogin%2F%3Fnext%3D%252Fapp`;
    expect(m.to).toEqual(['jane@example.com']);
    expect(m.subject).toMatch(/Markup/);
    expect(m.subject).not.toBe(m.subject.toUpperCase());
    expect(m.text).toContain(url);
    expect(m.html).toContain(url.replace(/&/g, '&amp;'));
    expect(m.html).toContain(`src="cid:${LOGO_CID}"`);
    expect(m.html).toMatch(/alt="Markup logo"/);
    expect(m.html).toContain('<html lang="en"');
    expect(m.inline_images?.[0]).toMatchObject({ cid: LOGO_CID, content_type: 'image/png' });
    // Copy rules: no em dashes, no remote images.
    expect(m.text + m.html).not.toContain('—');
    expect(m.html).not.toMatch(/<img[^>]+src="https?:/);
  });

  it('escapes user-controlled values in HTML', () => {
    const [email] = buildAuthEmails(payload('signup', {}, { email: '"><script>x</script>@example.com' }), ctx);
    expect(email!.message.html).not.toContain('<script>');
    expect(email!.message.html).toContain('&lt;script&gt;');
  });

  it('secure email change: token_hash_new goes to the current address, token_hash to the new one', () => {
    const emails = buildAuthEmails(
      payload('email_change', { token_hash: 'hash_for_new', token_hash_new: 'hash_for_current' }, { new_email: 'jane@new.example' }),
      ctx,
    );
    expect(emails.map((e) => [e.template, e.message.to])).toEqual([
      ['email_change_current', ['jane@example.com']],
      ['email_change_new', ['jane@new.example']],
    ]);
    expect(emails[0]!.message.text).toContain('token=hash_for_current');
    expect(emails[1]!.message.text).toContain('token=hash_for_new');
  });

  it('email change with secure change off sends one email to the new address', () => {
    const emails = buildAuthEmails(payload('email_change', { token_hash: 'only' }, { new_email: 'jane@new.example' }), ctx);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.message.to).toEqual(['jane@new.example']);
  });

  it('reauthentication shows the code and no link', () => {
    const [email] = buildAuthEmails(payload('reauthentication'), ctx);
    expect(email!.message.text).toContain('305805');
    expect(email!.message.html).toContain('305805');
    expect(email!.message.text).not.toContain('/auth/v1/verify');
  });

  it('email changed notice goes to the old address', () => {
    const [email] = buildAuthEmails(payload('email_changed_notification', { old_email: 'old@example.com' }), ctx);
    expect(email!.message.to).toEqual(['old@example.com']);
    expect(email!.message.text).toContain('old@example.com to jane@example.com');
  });

  it.each([
    'password_changed_notification',
    'phone_changed_notification',
    'identity_linked_notification',
    'identity_unlinked_notification',
    'mfa_factor_enrolled_notification',
    'mfa_factor_unenrolled_notification',
  ])('%s renders a security notice', (type) => {
    const [email] = buildAuthEmails(payload(type, { provider: 'github', factor_type: 'totp' }), ctx);
    expect(email!.message.subject).toMatch(/Markup/);
    expect(email!.message.text).toContain('https://markup.here/login/');
  });

  it('every cid the HTML references is attached, and nothing extra', () => {
    for (const type of ['signup', 'reauthentication', 'password_changed_notification']) {
      const [email] = buildAuthEmails(payload(type), ctx);
      const used = [...email!.message.html!.matchAll(/src="cid:([^"]+)"/g)].map((m) => m[1]).sort();
      expect(email!.message.inline_images!.map((i) => i.cid).sort()).toEqual(used);
    }
  });

  it('rejects unknown types', () => {
    expect(() => buildAuthEmails(payload('sms'), ctx)).toThrow(/Unsupported/);
  });
});

describe('handleSendEmailHook', () => {
  it('sends the email through the Mail API and answers 200 {}', async () => {
    const { deps: d, fetch } = deps([new Response(JSON.stringify({ message_id: '<m@x>' }), { status: 202 })]);
    const res = await handleSendEmailHook(await signedRequest(JSON.stringify(payload('magiclink'))), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(env.MAILER_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body as string)).toMatchObject({ to: ['jane@example.com'], subject: 'Your Markup sign-in link' });
  });

  it('adds MAIL_REPLY_TO when it is set', async () => {
    const { deps: d, fetch } = deps([]);
    await handleSendEmailHook(await signedRequest(JSON.stringify(payload('signup'))), {
      ...d,
      env: (k) => (k === 'MAIL_REPLY_TO' ? 'help@markup.here' : env[k]),
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).reply_to).toBe('help@markup.here');
  });

  it('rejects an unsigned or wrongly signed call without sending', async () => {
    const { deps: d, fetch } = deps([]);
    const body = JSON.stringify(payload('signup'));
    const bad = await handleSendEmailHook(await signedRequest(body, { secret: `v1,whsec_${btoa('wrong')}` }), d);
    expect(bad.status).toBe(401);
    const unsigned = await handleSendEmailHook(new Request('https://x.test', { method: 'POST', body }), d);
    expect(unsigned.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns a safe error when the Mail API keeps failing', async () => {
    const { deps: d, logs } = deps([
      new Response(JSON.stringify({ error: 'queue full' }), { status: 503 }),
      new Response(JSON.stringify({ error: 'queue full' }), { status: 503 }),
      new Response(JSON.stringify({ error: 'queue full' }), { status: 503 }),
    ]);
    const res = await handleSendEmailHook(await signedRequest(JSON.stringify(payload('recovery'))), d);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: { http_code: 503, message: 'We could not send the email right now. Try again in a minute.' } });
    expect(JSON.stringify(body)).not.toContain('queue full');
    expect(JSON.stringify(logs)).not.toContain(KEY);
  });

  it('maps 401 from the Mail API to a generic 502 without retrying', async () => {
    const { deps: d, fetch } = deps([new Response(JSON.stringify({ error: 'bad key' }), { status: 401 })]);
    const res = await handleSendEmailHook(await signedRequest(JSON.stringify(payload('signup'))), d);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/key|credential/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fails closed when configuration is missing', async () => {
    const { deps: d, fetch } = deps([]);
    const res = await handleSendEmailHook(await signedRequest(JSON.stringify(payload('signup'))), {
      ...d,
      env: (k) => (k === 'MAILER_API_KEY' ? undefined : env[k]),
    });
    expect(res.status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers 400 for an unsupported type and 405 for GET', async () => {
    const { deps: d } = deps([]);
    expect((await handleSendEmailHook(await signedRequest(JSON.stringify(payload('sms'))), d)).status).toBe(400);
    expect((await handleSendEmailHook(new Request('https://x.test'), d)).status).toBe(405);
  });
});
