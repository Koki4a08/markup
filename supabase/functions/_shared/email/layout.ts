/**
 * One email layout for every Markup email: HTML plus a plain-text twin with the same meaning.
 *
 * The look borrows from the editor: a dark canvas hero with a soft accent glow, and the main action
 * shown as a selected layer (frame, corner handles, a pill under it, a "You" cursor). Below it, a
 * light sheet with the details.
 *
 * Email-safe on purpose: tables for layout, inline styles, bgcolor fallbacks for every gradient, a
 * bulletproof button, no remote images. Geist loads where clients allow web fonts and falls back to
 * Helvetica/Arial elsewhere. The logo and cursor travel with the message as inline images (cid:).
 */
import type { InlineImage } from '../mailer.ts';
import { CURSOR_PNG_BASE64, LOGO_PNG_BASE64 } from './assets.ts';

export const LOGO_CID = 'markup-logo';
export const CURSOR_CID = 'markup-cursor';
export const SITE = 'https://markup.here';

export const logoImage: InlineImage = { cid: LOGO_CID, content: LOGO_PNG_BASE64, content_type: 'image/png' };
export const cursorImage: InlineImage = { cid: CURSOR_CID, content: CURSOR_PNG_BASE64, content_type: 'image/png' };

export interface EmailContent {
  /** Inbox preview line. */
  preheader: string;
  /** Small label at the top right of the hero, e.g. "Sign in". */
  kicker: string;
  heading: string;
  /** One sentence under the heading, in the hero. */
  lead: string;
  /** Main call to action, drawn as a selected layer. */
  action?: { label: string; url: string };
  /** Show the "You" cursor next to the action. Default true; off for security notices. */
  cursor?: boolean;
  /** A one-time code instead of a button (reauthentication). */
  code?: string;
  /** Text in the pill under the selection, e.g. "Expires in 1 hour". */
  pill?: string;
  /** Plain text paragraphs in the light sheet; escaped here. */
  paragraphs: string[];
  /** Label / value rows in the light sheet. */
  details?: Array<[string, string]>;
  /** Why this email arrived and what to do if it was not expected. */
  footer: string;
}

const FONT = "'Geist','Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "'Geist Mono','SF Mono',SFMono-Regular,Menlo,Consolas,monospace";
const ACCENT = '#5b47ff';
const C = {
  page: '#f4f4f5',
  sheet: '#ffffff',
  line: '#e7e7ea',
  ink: '#0a0a0b',
  body: '#3f3f46',
  muted: '#71717a',
  canvas: '#0c0c0e',
};

const font = (size: number, line: number, color: string, weight = 400, family = FONT) =>
  `font-family:${family};font-size:${size}px;line-height:${line}px;font-weight:${weight};color:${color};`;
const ZERO = 'font-size:0;line-height:0;mso-line-height-rule:exactly;';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline images the rendered HTML references. */
export function imagesFor(content: EmailContent): InlineImage[] {
  return hasCursor(content) ? [logoImage, cursorImage] : [logoImage];
}

function hasCursor(content: EmailContent): boolean {
  return Boolean(content.action) && content.cursor !== false;
}

export function renderEmail(content: EmailContent): { html: string; text: string } {
  return { html: renderHtml(content), text: renderText(content) };
}

/**
 * Wraps `inner` in an editor-style selection: 1px accent frame 4px outside the element and 9px
 * corner handles centred on the frame. A 7x7 table so the geometry holds without positioning.
 */
function selection(inner: string): string {
  const handle = `<td rowspan="3" colspan="3" width="9" height="9" style="${ZERO}width:9px;height:9px;"><div style="${ZERO}width:7px;height:7px;background:#ffffff;border:1px solid ${ACCENT};border-radius:2px;">&nbsp;</div></td>`;
  const gap = (h: number) => `<td height="${h}" style="${ZERO}height:${h}px;">&nbsp;</td>`;
  const rule = `<td height="1" bgcolor="${ACCENT}" style="${ZERO}height:1px;background:${ACCENT};">&nbsp;</td>`;
  const edge = (cells: string) => `<tr>${handle}${cells}${handle}</tr>`;
  const vgap = `<td width="4" style="${ZERO}width:4px;">&nbsp;</td>`;
  const vrule = `<td width="1" bgcolor="${ACCENT}" style="${ZERO}width:1px;background:${ACCENT};">&nbsp;</td>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  ${edge(gap(4))}<tr>${rule}</tr><tr>${gap(4)}</tr>
  <tr>${vgap}${vrule}${vgap}<td style="padding:0;">${inner}</td>${vgap}${vrule}${vgap}</tr>
  ${edge(gap(4))}<tr>${rule}</tr><tr>${gap(4)}</tr>
</table>`;
}

function renderHtml(c: EmailContent): string {
  const e = escapeHtml;

  const button = c.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>
    <td class="btn" bgcolor="#ffffff" style="border-radius:8px;background:#ffffff;">
      <a class="btn-a" href="${e(c.action.url)}" target="_blank" style="display:inline-block;padding:13px 24px;border-radius:8px;${font(15, 20, C.ink, 600)}letter-spacing:-0.005em;text-decoration:none;">${e(c.action.label)}</a>
    </td>
  </tr>
</table>`
    : '';

  const code = c.code
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
  <tr>${[...c.code]
    .map(
      (digit, i) =>
        `<td style="padding:0 ${i === c.code!.length - 1 ? 0 : 6}px 0 0;"><div style="width:40px;height:52px;border-radius:8px;background:#1b1b1f;border:1px solid #2c2c31;text-align:center;${font(26, 52, '#ffffff', 600, MONO)}">${e(digit)}</div></td>`,
    )
    .join('')}</tr>
</table>`
    : '';

  const target = button || code;
  const cursor = hasCursor(c)
    ? `<td class="cursor" valign="top" style="padding:34px 0 0 2px;">
  <img src="cid:${CURSOR_CID}" width="24" height="24" alt="" style="display:block;width:24px;height:24px;border:0;">
  <div style="margin:-7px 0 0 15px;display:inline-block;padding:3px 8px;border-radius:6px 6px 6px 2px;background:${ACCENT};${font(11, 16, '#ffffff', 600)}letter-spacing:0.01em;white-space:nowrap;">You</div>
</td>`
    : '';
  const pill = c.pill
    ? `<tr><td style="padding:10px 0 0;" align="center"><span style="display:inline-block;padding:3px 8px;border-radius:5px;background:${ACCENT};${font(11, 16, '#ffffff', 500)}white-space:nowrap;">${e(c.pill)}</span></td></tr>`
    : '';
  const stage = target
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0 0;">
  <tr>
    <td valign="top">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0">
        <tr><td>${selection(target)}</td></tr>
        ${pill}
      </table>
    </td>
    ${cursor}
  </tr>
</table>`
    : '';

  const paragraphs = c.paragraphs
    .map((p) => `<p class="body" style="margin:0 0 14px;${font(15, 24, C.body)}">${e(p)}</p>`)
    .join('\n');

  const details = c.details?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:10px 0 0;border-collapse:collapse;">
${c.details
  .map(
    ([label, value]) => `  <tr>
    <td class="rule muted label" valign="top" width="104" style="width:104px;padding:12px 12px 12px 0;border-top:1px solid ${C.line};${font(11, 20, C.muted, 500, MONO)}letter-spacing:0.06em;text-transform:uppercase;">${e(label)}</td>
    <td class="rule ink" valign="top" style="padding:12px 0;border-top:1px solid ${C.line};${font(14, 20, C.ink, 500)}word-break:break-word;">${e(value)}</td>
  </tr>`,
  )
  .join('\n')}
</table>`
    : '';

  const fallback = c.action
    ? `<div class="well" style="margin:24px 0 0;padding:14px 16px;border-radius:10px;background:#fafafa;border:1px solid ${C.line};">
  <p class="muted" style="margin:0 0 6px;${font(12, 18, C.muted)}">Button not working? Paste this link into your browser:</p>
  <a class="link" href="${e(c.action.url)}" target="_blank" style="${font(12, 18, ACCENT, 400, MONO)}word-break:break-all;text-decoration:none;">${e(c.action.url)}</a>
</div>`
    : '';

  // Invisible filler so inbox previews show only the preheader, not the body that follows it.
  const filler = '&#847;&zwnj;&nbsp;'.repeat(40);

  return `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(c.heading)}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a { color:${ACCENT}; }
  @media (max-width: 560px) {
    .outer { padding:16px 10px 32px !important; }
    .hero { padding:28px 22px 32px !important; }
    .sheet { padding:26px 22px 28px !important; }
    .h1 { font-size:26px !important; line-height:32px !important; }
    .cursor { display:none !important; }
    .label { width:84px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .page { background:#09090b !important; }
    .sheet { background:#121215 !important; }
    .frame { border-color:#26262b !important; }
    .ink { color:#fafafa !important; }
    .body { color:#c8c8ce !important; }
    .muted { color:#8e8e96 !important; }
    .rule { border-color:#26262b !important; }
    .well { background:#17171b !important; border-color:#26262b !important; }
    .link { color:#a39aff !important; }
  }
</style>
</head>
<body class="page" style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${e(c.preheader)}${filler}</div>
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
  <tr>
    <td class="outer" align="center" style="padding:40px 16px 48px;">
      <table role="presentation" class="frame" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;border-collapse:separate;border:1px solid ${C.line};border-radius:16px;">
        <tr>
          <td class="hero" bgcolor="${C.canvas}" style="padding:32px 40px 40px;border-radius:15px 15px 0 0;background-color:${C.canvas};background-image:radial-gradient(90% 120% at 100% 0%,rgba(91,71,255,0.30) 0%,rgba(91,71,255,0.08) 45%,rgba(91,71,255,0) 70%);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td valign="middle"><img src="cid:${LOGO_CID}" width="28" height="28" alt="Markup logo" style="display:block;width:28px;height:28px;border:0;border-radius:7px;"></td>
                      <td valign="middle" style="padding-left:10px;${font(16, 20, '#ffffff', 600)}letter-spacing:-0.01em;">Markup</td>
                    </tr>
                  </table>
                </td>
                <td align="right" valign="middle" style="${font(11, 16, '#8b8b93', 500, MONO)}letter-spacing:0.08em;text-transform:uppercase;">${e(c.kicker)}</td>
              </tr>
            </table>
            <h1 class="h1" style="margin:44px 0 10px;${font(30, 36, '#ffffff', 600)}letter-spacing:-0.025em;">${e(c.heading)}</h1>
            <p style="margin:0;max-width:420px;${font(15, 24, '#a1a1aa')}">${e(c.lead)}</p>
            ${stage}
          </td>
        </tr>
        <tr>
          <td class="sheet rule" bgcolor="${C.sheet}" style="padding:32px 40px 36px;border-top:1px solid ${C.line};border-radius:0 0 15px 15px;background:${C.sheet};">
            ${paragraphs}
            ${details}
            ${fallback}
          </td>
        </tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:22px 8px 0;">
            <p class="muted" style="margin:0 0 12px;${font(12, 18, C.muted)}">${e(c.footer)}</p>
            <p class="muted" style="margin:0;${font(12, 18, C.muted)}"><a class="muted" href="${SITE}" target="_blank" style="color:${C.muted};text-decoration:none;font-weight:600;">Markup</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a class="muted" href="${SITE}/privacy/" target="_blank" style="color:${C.muted};text-decoration:underline;">Privacy</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a class="muted" href="${SITE}/support/" target="_blank" style="color:${C.muted};text-decoration:underline;">Support</a></p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
`;
}

function renderText(c: EmailContent): string {
  const lines = [c.heading, '', c.lead, ''];
  if (c.code) lines.push(`Your code: ${c.code}`, '');
  if (c.action) lines.push(`${c.action.label}:`, c.action.url, '');
  if (c.pill) lines.push(`${c.pill}.`, '');
  for (const p of c.paragraphs) lines.push(p, '');
  if (c.details?.length) {
    for (const [label, value] of c.details) lines.push(`${label}: ${value}`);
    lines.push('');
  }
  lines.push('--', c.footer, '', `Markup  ${SITE}`, `Privacy  ${SITE}/privacy/`, `Support  ${SITE}/support/`);
  return `${lines.join('\n')}\n`;
}
