import type { CaptureMode, CaptureTargets } from '../picker/picker';
import { browserEnv, type CaptureEnv } from './env';
import { escAttr, FONTS_ATTR, SNAPSHOT_ATTR } from './dom';
import { captureExact } from './exact';
import { embedFonts } from './fonts';
import { capture } from './serialize';

export { capture } from './serialize';
export { captureExact } from './exact';

/**
 * Captures the targets (exact mode unless `simplified` is asked for) and puts the result on the clipboard. Must be called from the user gesture: the clipboard
 * write starts synchronously with a promise-valued ClipboardItem, so slow image fetches cannot outlive the gesture's
 * transient activation. Falls back to a copy event via execCommand when the async clipboard refuses.
 */
export async function captureAndCopy(
  targets: CaptureTargets,
  mode?: CaptureMode | CaptureEnv,
  env?: CaptureEnv,
  /** Runs before the page is read (inside the clipboard promise), e.g. loading the whole page first. */
  opts: { prepare?: () => Promise<void>; onFontProgress?: (fraction: number) => void } = {},
): Promise<void> {
  // `captureAndCopy(targets, env)` still means the default (exact) mode.
  if (typeof mode === 'object') [mode, env] = ['exact', mode];
  const meta = { title: document.title, url: location.href };
  const plain = `${meta.title}\n${meta.url}`;
  const read = mode === 'simplified' ? capture : captureExact;
  const html = (opts.prepare ? opts.prepare() : Promise.resolve())
    .then(() => read(targets, env ?? browserEnv(), meta))
    .then((h) => withFonts(h, targets, opts.onFontProgress));
  const htmlBlob = html.then((h) => new Blob([h], { type: 'text/html' }));
  htmlBlob.catch(() => {}); // Rejections surface through `html` below.
  let written: Promise<void>;
  try {
    written = navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
  } catch (err) {
    written = Promise.reject(err);
  }
  try {
    await Promise.all([written, html]);
  } catch {
    const result = await html; // Throws the capture error if capture itself failed.
    if (!copyWithExecCommand(result, plain)) throw new Error('Could not write to the clipboard');
  }
}

/** Same-origin and CORS-enabled resources load from the page; anything else is left out. */
const fetchFont = async (url: string): Promise<Blob | null> => {
  const r = await fetch(url, { credentials: 'omit' }).catch(() => null);
  return r?.ok ? r.blob() : null;
};
const fetchText = async (url: string): Promise<string | null> => {
  const r = await fetch(url, { credentials: 'omit' }).catch(() => null);
  return r?.ok ? r.text() : null;
};

/**
 * Adds the page's web fonts the capture needs to its root (as an attribute: clipboard sanitisers drop
 * <style>), so Markup lays the text out with the same glyphs. A capture without page fonts is unchanged.
 */
async function withFonts(html: string, targets: CaptureTargets, onProgress?: (f: number) => void): Promise<string> {
  const roots = targets === 'page' ? [document.documentElement] : targets;
  const text = roots.map((el) => el.textContent ?? '').join('');
  const css = await embedFonts(document, html, text, { fetchFont, fetchText, onProgress }).catch(() => '');
  if (!css) return html;
  const at = html.indexOf(`<div ${SNAPSHOT_ATTR}=`);
  if (at < 0) return html;
  return `${html.slice(0, at)}<div ${FONTS_ATTR}="${escAttr(css)}" ${html.slice(at + 5)}`;
}

function copyWithExecCommand(html: string, plain: string): boolean {
  const holder = document.createElement('div');
  holder.contentEditable = 'true';
  holder.setAttribute('aria-hidden', 'true');
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;';
  holder.textContent = plain;
  let copied = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData('text/html', html);
    e.clipboardData.setData('text/plain', plain);
    e.preventDefault();
    copied = true;
  };
  document.addEventListener('copy', onCopy, true);
  document.documentElement.appendChild(holder);
  try {
    const range = document.createRange();
    range.selectNodeContents(holder);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    holder.focus();
    return document.execCommand('copy') && copied;
  } catch {
    return false;
  } finally {
    document.removeEventListener('copy', onCopy, true);
    window.getSelection()?.removeAllRanges();
    holder.remove();
  }
}
