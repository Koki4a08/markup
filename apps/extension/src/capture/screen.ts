/// <reference types="chrome" />
import { canvasPng } from './images';

export interface ViewState {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
}

/** Source rectangle in screenshot pixels for a page-coordinate rect; null unless it is fully on screen. */
export function viewportCrop(rect: DOMRect, view: ViewState, shot: { width: number; height: number }): { sx: number; sy: number; sw: number; sh: number } | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = rect.x - view.scrollX;
  const y = rect.y - view.scrollY;
  if (x < 0 || y < 0 || x + rect.width > view.width || y + rect.height > view.height) return null;
  const sx = shot.width / view.width;
  const sy = shot.height / view.height;
  return { sx: Math.round(x * sx), sy: Math.round(y * sy), sw: Math.round(rect.width * sx), sh: Math.round(rect.height * sy) };
}

const nextFrame = () => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, 50);
  requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(t), resolve())));
});

/**
 * Cuts regions out of one screenshot of the visible tab, taken lazily on first use with the picker's own overlay
 * hidden. For images the page shows but the extension cannot download (private, signed or cross-origin pixels).
 */
export function screenRegions(win: Window = window): (rect: DOMRect) => Promise<string | null> {
  let shot: Promise<HTMLImageElement | null> | null = null;
  /** The view the screenshot shows: the whole-page pass can ask mid-scroll, and the capture again after. */
  let shotView = '';
  const take = async (): Promise<HTMLImageElement | null> => {
    const hosts = [...win.document.querySelectorAll<HTMLElement>('[data-markup-snapshot]')];
    const previous = hosts.map((h) => h.style.visibility);
    hosts.forEach((h) => (h.style.visibility = 'hidden'));
    try {
      await nextFrame();
      const res = (await chrome.runtime.sendMessage({ type: 'capture-tab' })) as { dataUrl?: string } | undefined;
      if (!res?.dataUrl) return null;
      const img = new Image();
      img.src = res.dataUrl;
      await img.decode();
      return img;
    } catch {
      return null;
    } finally {
      hosts.forEach((h, i) => (h.style.visibility = previous[i] ?? ''));
    }
  };
  return async (rect) => {
    const view = { scrollX: win.scrollX, scrollY: win.scrollY, width: win.innerWidth, height: win.innerHeight };
    // Decide before taking the screenshot, so captures with only fetchable images never take one.
    if (!viewportCrop(rect, view, { width: view.width, height: view.height })) return null;
    const key = `${view.scrollX},${view.scrollY},${view.width},${view.height}`;
    if (key !== shotView) {
      shot = null;
      shotView = key;
    }
    const img = await (shot ??= take());
    if (!img) return null;
    const crop = viewportCrop(rect, view, { width: img.naturalWidth, height: img.naturalHeight });
    if (!crop) return null;
    const canvas = win.document.createElement('canvas');
    canvas.width = crop.sw;
    canvas.height = crop.sh;
    canvas.getContext('2d')?.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
    return canvasPng(canvas);
  };
}
