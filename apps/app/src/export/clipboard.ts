/** Browser and desktop plumbing for copying to the clipboard and saving files. */

export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('The clipboard is not available here.');
  await navigator.clipboard.writeText(text);
}

export async function copyImage(bytes: Uint8Array, mimeType = 'image/png'): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Copying images is not supported here.');
  await navigator.clipboard.write([new ClipboardItem({ [mimeType]: new Blob([bytes as BlobPart], { type: mimeType }) })]);
}

function download(name: string, bytes: Uint8Array, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Saves one file: a download in the browser, a save dialog and write on desktop. Resolves false when the user cancels. */
export async function saveFile(name: string, bytes: Uint8Array, mimeType: string): Promise<boolean> {
  if (!inTauri()) {
    download(name, bytes, mimeType);
    return true;
  }
  const [{ save }, { writeFile }] = await Promise.all([import('@tauri-apps/plugin-dialog'), import('@tauri-apps/plugin-fs')]);
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  const path = await save({ defaultPath: name, filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined });
  if (!path) return false;
  await writeFile(path, bytes);
  return true;
}
