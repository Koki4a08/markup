/**
 * Supabase Auth emails, built from the Send Email Hook payload. Each email has a specific subject,
 * an HTML body and a plain-text body that say the same thing.
 *
 * Links go to Supabase's /auth/v1/verify, which checks the token and redirects to `redirect_to`
 * (already validated by Supabase against the allowed redirect URLs). With the PKCE flow the site
 * then receives ?code= and finishes sign-in.
 */
import type { MailMessage } from '../mailer.ts';
import { SITE, imagesFor, renderEmail, type EmailContent } from './layout.ts';

export interface HookUser {
  id?: string;
  email?: string;
  new_email?: string;
  user_metadata?: Record<string, unknown>;
}

export interface HookEmailData {
  token?: string;
  token_hash?: string;
  redirect_to?: string;
  email_action_type: string;
  site_url?: string;
  token_new?: string;
  token_hash_new?: string;
  old_email?: string;
  old_phone?: string;
  provider?: string;
  factor_type?: string;
}

export interface HookPayload {
  user: HookUser;
  email_data: HookEmailData;
}

export interface BuildContext {
  /** Project URL, e.g. https://<ref>.supabase.co (SUPABASE_URL in Edge Functions). */
  supabaseUrl: string;
  /** Fallback when the payload has no redirect_to / site_url. */
  siteUrl?: string;
}

export interface BuiltEmail {
  /** Template name, for logs. */
  template: string;
  message: MailMessage;
}

/** Matches the dashboard's "Email OTP Expiration" (Authentication → Sign In / Providers → Email). */
export const LINK_EXPIRY = '1 hour';
const FROM_NAME = 'Markup';
const IGNORE = 'If you did not ask for this, ignore this email. Nothing changes until the link is used.';
const ONCE = `Works once, expires in ${LINK_EXPIRY}`;

export class UnsupportedEmailError extends Error {
  constructor(type: string) {
    super(`Unsupported email_action_type: ${type}`);
    this.name = 'UnsupportedEmailError';
  }
}

/** Builds every email one hook call needs (two for a secure email change, otherwise one). */
export function buildAuthEmails(payload: HookPayload, ctx: BuildContext): BuiltEmail[] {
  const { user, email_data: data } = payload;
  const type = data.email_action_type;
  const email = user.email ?? '';
  const site = cleanSite(data.site_url || ctx.siteUrl || SITE);
  const verify = (tokenHash: string | undefined, verifyType: string) =>
    verifyUrl(ctx.supabaseUrl, tokenHash ?? '', verifyType, data.redirect_to || site);

  switch (type) {
    case 'signup':
      return [
        build('signup', email, 'Confirm your email to finish signing up for Markup', {
          preheader: 'One click and your Markup account is ready.',
          kicker: 'New account',
          heading: 'Confirm your email',
          lead: 'One click and your Markup account is ready.',
          action: { label: 'Confirm email', url: verify(data.token_hash, 'signup') },
          pill: `Expires in ${LINK_EXPIRY}`,
          paragraphs: [`Thanks for signing up. Confirm that ${email} is your address to finish creating your account.`],
          details: [
            ['Account', email],
            ['Link', ONCE],
          ],
          footer: `Sent because someone created a Markup account with ${email}. ${IGNORE}`,
        }),
      ];

    case 'magiclink':
    case 'email':
      return [
        build('magiclink', email, 'Your Markup sign-in link', {
          preheader: `Sign in to Markup. The link expires in ${LINK_EXPIRY}.`,
          kicker: 'Sign in',
          heading: 'Sign in to Markup',
          lead: 'No password needed. Use the button and you are in.',
          action: { label: 'Sign in to Markup', url: verify(data.token_hash, type) },
          pill: `Expires in ${LINK_EXPIRY}`,
          paragraphs: ['Open the link in the same browser where you asked for it, so we can finish signing you in.'],
          details: [
            ['Account', email],
            ['Link', ONCE],
          ],
          footer: `Sent because someone asked for a sign-in link for ${email}. ${IGNORE}`,
        }),
      ];

    case 'recovery':
      return [
        build('recovery', email, 'Reset your Markup password', {
          preheader: 'Choose a new password for your Markup account.',
          kicker: 'Password',
          heading: 'Reset your password',
          lead: 'Choose a new password and you are back in.',
          action: { label: 'Choose a new password', url: verify(data.token_hash, 'recovery') },
          pill: `Expires in ${LINK_EXPIRY}`,
          paragraphs: [`We got a request to reset the password for ${email}. Your current password keeps working until you choose a new one.`],
          details: [
            ['Account', email],
            ['Link', ONCE],
          ],
          footer: `Sent because someone asked to reset the password for ${email}. If it was not you, ignore this email. Your password stays the same.`,
        }),
      ];

    case 'invite':
      return [
        build('invite', email, 'You have been invited to Markup', {
          preheader: 'Accept the invitation to create your Markup account.',
          kicker: 'Invitation',
          heading: 'You are invited to Markup',
          lead: 'A design canvas where every layer is real HTML and CSS.',
          action: { label: 'Accept invitation', url: verify(data.token_hash, 'invite') },
          pill: `Expires in ${LINK_EXPIRY}`,
          paragraphs: ['Accept the invitation to create your account. It takes a few seconds.'],
          details: [
            ['Account', email],
            ['Link', ONCE],
          ],
          footer: `Sent because someone invited ${email} to Markup. If you were not expecting it, you can ignore this email.`,
        }),
      ];

    case 'email_change':
      return buildEmailChange(user, data, verify);

    case 'reauthentication': {
      const code = (data.token ?? '').trim();
      if (!code) throw new UnsupportedEmailError(`${type} without a code`);
      return [
        build('reauthentication', email, 'Your Markup verification code', {
          preheader: `Your code is ${code}. It expires in ${LINK_EXPIRY}.`,
          kicker: 'Verification',
          heading: 'Confirm it is you',
          lead: 'Enter this code in Markup to continue with the change you started.',
          code,
          pill: `Expires in ${LINK_EXPIRY}`,
          paragraphs: ['Never share this code. Markup will never ask you for it by email or chat.'],
          details: [
            ['Account', email],
            ['Code', `Works once, expires in ${LINK_EXPIRY}`],
          ],
          footer: `Sent because someone asked to change sensitive settings on the Markup account for ${email}. If it was not you, change your password.`,
        }),
      ];
    }

    case 'password_changed_notification':
      return [notice(type, email, site, 'Your Markup password was changed', 'Your password was changed', 'The password for your Markup account was just changed.', email)];

    case 'email_changed_notification': {
      const oldEmail = data.old_email || email;
      return [
        notice(
          type,
          oldEmail,
          site,
          'The email for your Markup account was changed',
          'Your email address was changed',
          `The email address for your Markup account changed from ${oldEmail} to ${email}.`,
          email,
          `Sent as a security notice because ${oldEmail} was the address on a Markup account.`,
        ),
      ];
    }

    case 'phone_changed_notification':
      return [notice(type, email, site, 'The phone number for your Markup account was changed', 'Your phone number was changed', 'The phone number on your Markup account was just changed.', email)];

    case 'identity_linked_notification':
      return [
        notice(type, email, site, 'A sign-in method was added to your Markup account', 'New sign-in method added', `${providerName(data.provider)} can now be used to sign in to your Markup account.`, email),
      ];

    case 'identity_unlinked_notification':
      return [
        notice(type, email, site, 'A sign-in method was removed from your Markup account', 'Sign-in method removed', `${providerName(data.provider)} can no longer be used to sign in to your Markup account.`, email),
      ];

    case 'mfa_factor_enrolled_notification':
      return [
        notice(type, email, site, 'Two-step verification was added to your Markup account', 'Two-step verification added', `A new ${factorName(data.factor_type)} verification method was added to your Markup account.`, email),
      ];

    case 'mfa_factor_unenrolled_notification':
      return [
        notice(type, email, site, 'Two-step verification was removed from your Markup account', 'Two-step verification removed', `A ${factorName(data.factor_type)} verification method was removed from your Markup account.`, email),
      ];

    default:
      throw new UnsupportedEmailError(type);
  }
}

/**
 * Secure email change sends two emails. Supabase names the hashes backwards for compatibility:
 * `token_hash_new` belongs to the CURRENT address (user.email), `token_hash` to the NEW one
 * (user.new_email). With secure change off there is one pair, for the new address.
 */
function buildEmailChange(
  user: HookUser,
  data: HookEmailData,
  verify: (tokenHash: string | undefined, type: string) => string,
): BuiltEmail[] {
  const current = user.email ?? '';
  const next = user.new_email ?? '';
  const emails: BuiltEmail[] = [];

  if (data.token_hash_new && current) {
    emails.push(
      build('email_change_current', current, 'Confirm the email change for your Markup account', {
        preheader: `Confirm moving your Markup account to ${next}.`,
        kicker: 'Email change',
        heading: 'Confirm your email change',
        lead: 'Confirm from this address too, so we know the request came from you.',
        action: { label: 'Confirm email change', url: verify(data.token_hash_new, 'email_change') },
        pill: `Expires in ${LINK_EXPIRY}`,
        paragraphs: [`Someone asked to move your Markup account to a new email address.`],
        details: [
          ['From', current],
          ['To', next],
          ['Link', ONCE],
        ],
        footer: `Sent because ${current} is the address on a Markup account. If you did not ask for this change, ignore this email and change your password.`,
      }),
    );
  }

  if (data.token_hash && next) {
    emails.push(
      build('email_change_new', next, 'Confirm your new email for Markup', {
        preheader: 'One click to start using this address with Markup.',
        kicker: 'Email change',
        heading: 'Confirm your new email',
        lead: 'One click to start using this address with Markup.',
        action: { label: 'Confirm new email', url: verify(data.token_hash, 'email_change') },
        pill: `Expires in ${LINK_EXPIRY}`,
        paragraphs: [`Confirm that ${next} is the new address for your Markup account.`],
        details: [
          ['New email', next],
          ['Link', ONCE],
        ],
        footer: `Sent because someone asked to use ${next} for a Markup account. ${IGNORE}`,
      }),
    );
  }

  if (emails.length === 0) throw new UnsupportedEmailError('email_change without a token');
  return emails;
}

/** Security notices share one shape: what changed, and a way back in if it was not you. */
function notice(
  template: string,
  to: string,
  site: string,
  subject: string,
  heading: string,
  lead: string,
  account: string,
  footer = `Sent as a security notice because a change was made to the Markup account for ${account}.`,
): BuiltEmail {
  return build(template, to, subject, {
    preheader: lead,
    kicker: 'Security',
    heading,
    lead,
    action: { label: 'Reset password', url: `${site}/login/` },
    cursor: false,
    pill: 'Only if this was not you',
    paragraphs: ['If you made this change, there is nothing else to do. If you did not, reset your password right away.'],
    details: [
      ['Account', account],
      ['When', 'Just now'],
    ],
    footer,
  });
}

function build(template: string, to: string, subject: string, content: EmailContent): BuiltEmail {
  const { html, text } = renderEmail(content);
  return {
    template,
    message: { to: [to], subject, text, html, from_name: FROM_NAME, inline_images: imagesFor(content) },
  };
}

export function verifyUrl(supabaseUrl: string, tokenHash: string, type: string, redirectTo: string): string {
  if (!tokenHash) throw new UnsupportedEmailError(`${type} without a token`);
  const base = supabaseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ token: tokenHash, type, redirect_to: redirectTo });
  return `${base}/auth/v1/verify?${params.toString()}`;
}

function cleanSite(url: string): string {
  return url.replace(/\/+$/, '');
}

function providerName(provider: string | undefined): string {
  const names: Record<string, string> = { github: 'GitHub', google: 'Google', email: 'Email and password' };
  if (!provider) return 'A new sign-in method';
  return names[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function factorName(factor: string | undefined): string {
  const names: Record<string, string> = { totp: 'authenticator app', phone: 'phone', webauthn: 'security key' };
  return (factor && names[factor]) || 'two-step';
}
