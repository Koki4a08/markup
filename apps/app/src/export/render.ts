import { toCanvas } from 'html-to-image';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { MarkupError, clampPixelRatio, parseScale, type Actor, type ExportSetting, type MarkupDoc } from '@markup/doc';
import { NodeView } from '../canvas/NodeView';
import { DocProvider } from '../store/DocProvider';
import { ensureFontsLoaded, fontFacesUsed, type UsedFont } from '../fonts/fontLoader';
import { knownLocalFonts } from '../fonts/localFonts';

export interface Rendered {
  bytes: Uint8Array;
  mimeType: string;
  ext: string;
  /** Pixel size of raster output; the node size in px for svg and pdf. */
  width: number;
  height: number;
  /** The pixel ratio used when the requested scale was over the render size limit (MAX_EXPORT_SIDE / MAX_EXPORT_AREA). */
  clampedScale?: number;
}

type PdfQuality = NonNullable<ExportSetting['pdfQuality']>;
type PdfResampling = NonNullable<ExportSetting['pdfResampling']>;

/** Undo the canvas placement so the node renders at its own origin. */
const NEUTRAL = { translate: 'none', margin: '0', left: '0', top: '0', position: 'relative' } as const;
const PDF_JPEG_QUALITY: Record<PdfQuality, number> = { low: 0.6, medium: 0.8, high: 0.95 };
const RASTER: Record<string, { mimeType: string; quality?: number; opaque?: boolean }> = {
  png: { mimeType: 'image/png' },
  jpg: { mimeType: 'image/jpeg', quality: 0.92, opaque: true },
  webp: { mimeType: 'image/webp', quality: 0.92 },
};
const EXPORT_ACTOR: Actor = { id: 'export', kind: 'human', name: 'Export' };

const sizeOf = (el: HTMLElement) => ({ width: el.offsetWidth, height: el.offsetHeight });

/** Renders el to a canvas; the ratio is lowered when the output would exceed the browser's canvas size limit. */
async function rasterize(el: HTMLElement, pixelRatio: number, backgroundColor?: string): Promise<HTMLCanvasElement> {
  const { width, height } = sizeOf(el);
  if (!width || !height) throw new MarkupError('INVALID_ARGUMENT', `Node ${el.getAttribute('data-node-id')} has no size to export.`);
  return toCanvas(el, { width, height, pixelRatio: clampPixelRatio(pixelRatio, { width, height }).pixelRatio, cacheBust: true, backgroundColor, style: NEUTRAL });
}

function toBytes(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new MarkupError('INVALID_ARGUMENT', `This browser cannot encode ${mimeType}.`));
        blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
      },
      mimeType,
      quality,
    );
  });
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available.');
  return ctx;
}

/** A PDF page image: detailed renders at twice the size and downsamples smoothly, basic renders once. */
async function pdfPageCanvas(el: HTMLElement, pixelRatio: number, resampling: PdfResampling): Promise<HTMLCanvasElement> {
  if (resampling === 'basic') return rasterize(el, pixelRatio, '#ffffff');
  const big = await rasterize(el, pixelRatio * 2, '#ffffff');
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(big.width / 2));
  out.height = Math.max(1, Math.round(big.height / 2));
  const ctx = context2d(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, out.width, out.height);
  return out;
}

/** One PDF; each page is the node's size in px, holding the node as a JPEG. */
export async function renderPdf(els: HTMLElement[], opts: { pixelRatio?: (el: HTMLElement) => number; quality: PdfQuality; resampling: PdfResampling }): Promise<Rendered> {
  const { jsPDF } = await import('jspdf');
  let pdf: InstanceType<typeof jsPDF> | null = null;
  let first = { width: 0, height: 0 };
  for (const el of els) {
    const { width, height } = sizeOf(el);
    const canvas = await pdfPageCanvas(el, opts.pixelRatio?.(el) ?? 1, opts.resampling);
    const jpeg = await toBytes(canvas, 'image/jpeg', PDF_JPEG_QUALITY[opts.quality]);
    const orientation = width > height ? 'landscape' : 'portrait';
    if (!pdf) {
      pdf = new jsPDF({ unit: 'px', format: [width, height], orientation, hotfixes: ['px_scaling'], compress: true });
      first = { width, height };
    } else pdf.addPage([width, height], orientation);
    pdf.addImage(jpeg, 'JPEG', 0, 0, width, height);
  }
  if (!pdf) throw new MarkupError('INVALID_ARGUMENT', 'Nothing to export.');
  return { bytes: new Uint8Array(pdf.output('arraybuffer')), mimeType: 'application/pdf', ext: 'pdf', ...first };
}

/** An SVG layer renders as a div whose direct child is the <svg>; frames only hold other layers. */
const svgOf = (el: HTMLElement) => (el.tagName === 'DIV' ? el.querySelector<SVGSVGElement>(':scope > svg') : null);

function svgMarkup(svg: SVGSVGElement, el: HTMLElement, pixelRatio: number): Uint8Array {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const { width, height } = sizeOf(el);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (width && height) {
    copy.setAttribute('width', String(Math.round(width * pixelRatio * 100) / 100));
    copy.setAttribute('height', String(Math.round(height * pixelRatio * 100) / 100));
  }
  return new TextEncoder().encode(new XMLSerializer().serializeToString(copy));
}

async function encodeAvif(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const image = context2d(canvas).getImageData(0, 0, canvas.width, canvas.height);
  const { default: encode } = await import('@jsquash/avif/encode.js');
  return new Uint8Array(await encode(image));
}

/** Renders one mounted node element with one export setting. */
export async function renderExport(el: HTMLElement, setting: ExportSetting): Promise<Rendered> {
  const { format } = setting;
  if (format === 'mp4' || format === 'webm') throw new MarkupError('UNSUPPORTED', 'Video export is not available yet.');
  const size = sizeOf(el);
  const pixelRatio = parseScale(setting.scale, size);
  if (format === 'svg') {
    const svg = svgOf(el);
    if (!svg) throw new MarkupError('INVALID_ARGUMENT', 'SVG export is only available for SVG layers.');
    return { bytes: svgMarkup(svg, el, pixelRatio), mimeType: 'image/svg+xml', ext: 'svg', ...size };
  }
  const { clampedScale } = clampPixelRatio(pixelRatio, size);
  const clamped = clampedScale === undefined ? {} : { clampedScale };
  if (format === 'pdf') return { ...(await renderPdf([el], { pixelRatio: () => pixelRatio, quality: setting.pdfQuality ?? 'high', resampling: setting.pdfResampling ?? 'detailed' })), ...clamped };
  const canvas = await rasterize(el, pixelRatio, RASTER[format]?.opaque ? '#ffffff' : undefined);
  const dims = { width: canvas.width, height: canvas.height, ...clamped };
  if (format === 'avif') return { bytes: await encodeAvif(canvas), mimeType: 'image/avif', ext: 'avif', ...dims };
  const raster = RASTER[format];
  if (!raster) throw new MarkupError('INVALID_ARGUMENT', `Unknown export format "${format}".`);
  return { bytes: await toBytes(canvas, raster.mimeType, raster.quality), mimeType: raster.mimeType, ext: format, ...dims };
}

/**
 * One frame, or 50 ms when frames do not come: browsers pause requestAnimationFrame in hidden
 * documents and WebView2 pauses it while minimised, the usual state while an agent works.
 */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 50);
    if (typeof requestAnimationFrame === 'function' && !document.hidden)
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
  });

/** A CSS font shorthand for document.fonts.load. */
const fontQuery = (f: UsedFont) => `${f.style} ${f.weight} 16px "${f.family.replace(/["\\]/g, '')}"`;

/**
 * Waits for the mounted nodes' images and fonts, at most 5 s so an image or font that never loads cannot
 * hang an export. stylesheets settles when the fonts' stylesheets have loaded; each face in fonts is then
 * loaded explicitly, since document.fonts.ready only covers fonts the page already asked for.
 */
export async function settled(host: HTMLElement, fonts: UsedFont[] = [], stylesheets: Promise<void> = Promise.resolve()): Promise<void> {
  await nextFrame();
  const images = [...host.querySelectorAll('img')].filter((img) => img.getAttribute('src') && !img.complete);
  const loaded = images.map(
    (img) =>
      new Promise<void>((r) => {
        img.addEventListener('load', () => r(), { once: true });
        img.addEventListener('error', () => r(), { once: true });
      }),
  );
  const faces = stylesheets.then(async () => {
    if (!document.fonts) return;
    await Promise.all(fonts.map((f) => document.fonts.load(fontQuery(f)).catch(() => undefined)));
    await document.fonts.ready;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((r) => (timer = setTimeout(r, 5000)));
  try {
    await Promise.race([Promise.all([...loaded, faces]), cap]);
  } finally {
    clearTimeout(timer);
  }
}

/** The node's artboard (top-level ancestor below the page root), so the node lays out inside its real parents. */
function artboardOf(doc: MarkupDoc, nodeId: string): string {
  let id = nodeId;
  for (;;) {
    const parentId = doc.requireNode(id).parentId;
    if (!parentId || doc.requireNode(parentId).type === 'root') return id;
    id = parentId;
  }
}

/**
 * Mounts the artboards holding nodeIds into a hidden off-screen host with the same NodeView the
 * canvas uses, so nodes on any page, of any open tab, can be rendered. Unmounted when fn settles.
 */
export async function withRenderedNodes<T>(doc: MarkupDoc, nodeIds: string[], fn: (element: (id: string) => HTMLElement) => Promise<T>): Promise<T> {
  for (const id of nodeIds) if (doc.requireNode(id).type === 'root') throw new MarkupError('IS_ROOT', 'A page root cannot be exported; export its artboards.');
  const artboards = [...new Set(nodeIds.map((id) => artboardOf(doc, id)))];
  // The canvas only loads fonts for the page on screen; nodes on other pages or tabs need theirs too.
  const fonts = fontFacesUsed(doc, artboards);
  const stylesheets = ensureFontsLoaded([...new Set(fonts.map((f) => f.family))], knownLocalFonts());
  const host = document.createElement('div');
  host.setAttribute('data-markup-export-host', '');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;';
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    const children = artboards.map((id) => createElement(NodeView, { key: id, id }));
    flushSync(() => root.render(createElement(DocProvider, { doc, actor: EXPORT_ACTOR, children })));
    await settled(host, fonts, stylesheets);
    return await fn((id) => {
      const el = host.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
      if (!el) throw new MarkupError('NODE_NOT_FOUND', `Node ${id} could not be rendered.`);
      return el;
    });
  } finally {
    root.unmount();
    host.remove();
  }
}
