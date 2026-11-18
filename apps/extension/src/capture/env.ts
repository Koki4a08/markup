// apps/app type-checks this file too (its snapshot paste test runs the real capture), so name the chrome types here.
/// <reference types="chrome" />
import { SAFE_IMAGE } from './images';
import { screenRegions } from './screen';

export type Pseudo = '::before' | '::after' | '::placeholder';

/** Everything capture reads from the live page. Injectable so tests can run without layout. */
export interface CaptureEnv {
  style(el: Element, pseudo?: Pseudo): CSSStyleDeclaration;
  /** Border box in page coordinates (viewport rect + scroll offset). */
  rect(el: Element): DOMRect;
  /** A data:image/(png|jpeg|gif|webp|avif) URL for the image, or null when it cannot be loaded. */
  fetchImage(url: string): Promise<string | null>;
  /** Page-coordinate bounds of a run of text and inline nodes, or null when unknown. */
  textRect?(nodes: Node[]): DOMRect | null;
  /** A PNG data URL of what the visible tab shows inside a page-coordinate rect, or null when it is off screen. */
  snapshotRegion?(rect: DOMRect): Promise<string | null>;
}

const MAX_RASTER_SIDE = 4096;

const readBlob = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });

/** Re-encodes an image the app would not accept (SVG, BMP, ICO…) as PNG. */
async function rasterize(doc: Document, dataUrl: string): Promise<string | null> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const svg = /^data:image\/svg/i.test(dataUrl);
    const scale = svg ? 2 : 1;
    const w = Math.max(1, img.naturalWidth || 300) * scale;
    const h = Math.max(1, img.naturalHeight || 150) * scale;
    const fit = Math.min(1, MAX_RASTER_SIDE / Math.max(w, h));
    const canvas = doc.createElement('canvas');
    canvas.width = Math.round(w * fit);
    canvas.height = Math.round(h * fit);
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

async function normalize(doc: Document, dataUrl: string | undefined | null): Promise<string | null> {
  if (!dataUrl) return null;
  if (SAFE_IMAGE.test(dataUrl)) return dataUrl;
  if (/^data:image\//i.test(dataUrl)) return rasterize(doc, dataUrl);
  return null;
}

/** The live page: computed styles, layout rects, and images through the background proxy. */
export function browserEnv(win: Window = window): CaptureEnv {
  const doc = win.document;
  const shift = (r: DOMRect) => new DOMRect(r.x + win.scrollX, r.y + win.scrollY, r.width, r.height);
  return {
    snapshotRegion: screenRegions(win),
    style: (el, pseudo) => win.getComputedStyle(el, pseudo),
    rect: (el) => shift(el.getBoundingClientRect()),
    textRect(nodes) {
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) return null;
      const range = doc.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
      const r = range.getBoundingClientRect();
      return r.width || r.height ? shift(r) : null;
    },
    async fetchImage(url) {
      try {
        if (/^data:/i.test(url)) return await normalize(doc, url);
        if (/^blob:/i.test(url)) return await normalize(doc, await readBlob(await (await fetch(url)).blob()));
        if (!/^https?:/i.test(url)) return null;
        const res = (await chrome.runtime.sendMessage({ type: 'fetch-image', url })) as { dataUrl?: string; error?: string } | undefined;
        return await normalize(doc, res?.dataUrl);
      } catch {
        return null;
      }
    },
  };
}
