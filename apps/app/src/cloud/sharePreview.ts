import type { MarkupDoc } from '@markup/doc';
import { parsePxValue } from '../canvas/geometry';
import { renderExport, withRenderedNodes } from '../export/render';
import { encodeBundle, imageType, type FrameImage } from './shareBundle';

/** Sharpness of the shared view: 2x, lowered for big artboards so each image stays reasonable. */
const TARGET_RATIO = 2;
const MAX_SIDE = 8192;
const MAX_AREA = 12_000_000;
/** Same cap as the share function (MAX_PREVIEW_BYTES), a little under it. */
export const MAX_BUNDLE_BYTES = 39 * 1024 * 1024;
const MAX_FRAMES = 300;

export class PreviewTooLarge extends Error {}

/** Pixel ratio for one artboard of this CSS size. */
export function previewRatio(width: number, height: number): number {
  if (!(width > 0 && height > 0)) return 1;
  const r = Math.min(TARGET_RATIO, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_AREA / (width * height)));
  return Math.max(0.05, Math.floor(r * 1000) / 1000);
}

/**
 * Renders every visible artboard of every page into one share bundle, with the same renderer as
 * exports, so the shared view looks like the canvas. Pages are rendered one at a time.
 */
export async function renderSharePreview(doc: MarkupDoc, name: string): Promise<Uint8Array> {
  const pages: { id: string; name: string; frames: FrameImage[] }[] = [];
  let total = 0;
  let count = 0;
  for (const page of doc.pages()) {
    if (page.type !== 'page') continue;
    const ids = doc.requireNode(page.rootId).children.filter((id) => {
      const node = doc.getNode(id);
      return node && !node.hidden && node.type !== 'root';
    });
    const frames: FrameImage[] = [];
    if (ids.length) {
      count += ids.length;
      if (count > MAX_FRAMES) throw new PreviewTooLarge(`Sharing shows up to ${MAX_FRAMES} artboards. Hide or remove some and try again.`);
      await withRenderedNodes(doc, ids, async (element) => {
        for (const id of ids) {
          const node = doc.requireNode(id);
          const el = element(id);
          const width = el.offsetWidth;
          const height = el.offsetHeight;
          if (!width || !height) continue;
          const ratio = previewRatio(width, height);
          const out = await renderExport(el, { format: 'webp', scale: `${ratio}x` });
          total += out.bytes.byteLength;
          if (total > MAX_BUNDLE_BYTES) throw new PreviewTooLarge('This file is too large to share as a view. Hide or remove some artboards and try again.');
          frames.push({
            id,
            name: node.name || 'Artboard',
            x: parsePxValue(node.styles.left),
            y: parsePxValue(node.styles.top),
            width,
            height,
            type: imageType(out.bytes),
            bytes: out.bytes,
          });
        }
      });
    }
    pages.push({ id: page.id, name: page.name, frames });
  }
  return encodeBundle({ name, createdAt: new Date().toISOString() }, pages);
}
