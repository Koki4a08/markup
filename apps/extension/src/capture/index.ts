import { browserEnv, type CaptureEnv } from './env';
import { capture } from './serialize';

export { capture } from './serialize';

/**
 * Captures the targets and puts the result on the clipboard. Must be called from the user gesture: the clipboard
 * write starts synchronously with a promise-valued ClipboardItem, so slow image fetches cannot outlive the gesture's
 * transient activation. Falls back to a copy event via execCommand when the async clipboard refuses.
 */
export async function captureAndCopy(targets: Element[] | 'page', env: CaptureEnv = browserEnv()): Promise<void> {
  const meta = { title: document.title, url: location.href };
  const plain = `${meta.title}\n${meta.url}`;
  const html = capture(targets, env, meta);
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
