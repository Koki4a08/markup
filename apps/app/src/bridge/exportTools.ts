import { DEFAULT_EXPORT, MarkupError, type ExportSetting, type MarkupDoc } from '@markup/doc';
import { tools, type ExportToolName } from '@markup/protocol';
import { renderExport, renderPdf, withRenderedNodes } from '../export/render';

/** Longest side of a fill image handed to an agent; larger images are scaled down. */
export const MAX_FILL_IMAGE_SIDE = 1568;

export interface ExportedFile {
  nodeId: string;
  name: string;
  format: ExportSetting['format'];
  scale: string;
  mimeType: string;
  /** Base64 file contents; `markup mcp` writes them to disk. */
  data: string;
  width: number;
  height: number;
  /** The pixel ratio used when the requested scale was over the render size limit. */
  clampedScale?: number;
}

/** A node left out of an export, with why. */
export interface SkippedNode {
  nodeId: string;
  reason: string;
}

export interface ExportResult {
  files: ExportedFile[];
  /** Hidden or zero-size nodes that were not exported; absent when none were skipped. */
  skipped?: SkippedNode[];
}

function parse<T>(name: ExportToolName, params: unknown): T {
  const r = tools[name].input.safeParse(params ?? {});
  if (!r.success) throw new MarkupError('INVALID_PARAMS', `Invalid parameters for ${name}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  return r.data as T;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const VIDEO = new Set(['mp4', 'webm']);
const unsupportedVideo = () => new MarkupError('UNSUPPORTED', 'Video export is not available yet.');

/** Every node under the page root, in layer order, that has export settings. */
function configuredNodes(doc: MarkupDoc, pageId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const child of doc.requireNode(id).children) {
      if (doc.exportsOf(child).length) out.push(child);
      walk(child);
    }
  };
  walk(doc.rootOf(pageId));
  return out;
}

const px = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) || 0 : 0);

/** Approximate world position: the sum of left/top up the ancestor chain (artboards are absolutely placed). */
function worldPosition(doc: MarkupDoc, nodeId: string): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (let node = doc.getNode(nodeId); node && node.type !== 'root'; node = node.parentId ? doc.getNode(node.parentId) : undefined) {
    x += px(node.styles.left);
    y += px(node.styles.top);
  }
  return { x, y };
}

/** Why a node cannot be rendered before mounting it: it or an ancestor is hidden. */
function hiddenReason(doc: MarkupDoc, nodeId: string): string | null {
  for (let node = doc.getNode(nodeId); node && node.type !== 'root'; node = node.parentId ? doc.getNode(node.parentId) : undefined)
    if (node.hidden) return node.id === nodeId ? 'The node is hidden.' : `Its parent ${node.id} is hidden.`;
  return null;
}

const NO_SIZE = 'The node has no size (zero width or height).';
const hasSize = (el: HTMLElement) => el.offsetWidth > 0 && el.offsetHeight > 0;

/**
 * Splits off hidden nodes. When strict (one node explicitly requested) a hidden node is an error;
 * otherwise it is skipped and reported so one hidden layer does not fail the rest.
 */
function dropHidden(doc: MarkupDoc, ids: string[], strict: boolean, skipped: SkippedNode[]): string[] {
  return ids.filter((nodeId) => {
    const reason = hiddenReason(doc, nodeId);
    if (!reason) return true;
    if (strict) throw new MarkupError('INVALID_ARGUMENT', `Cannot export node ${nodeId}: ${reason} Show it first.`);
    skipped.push({ nodeId, reason });
    return false;
  });
}

const withSkipped = (files: ExportedFile[], skipped: SkippedNode[]): ExportResult => (skipped.length ? { files, skipped } : { files });

const QUALITY_RANK = { low: 0, medium: 1, high: 2 } as const;

async function exportNodes(doc: MarkupDoc, params: Record<string, unknown>, activePageId: string): Promise<ExportResult> {
  const p = parse<{ pageId?: string; type?: 'image' | 'video'; nodes: 'nodes-with-exports-only' | Record<string, ExportSetting[]> }>('export', params);
  if (p.type === 'video') throw unsupportedVideo();
  const jobs: { nodeId: string; setting: ExportSetting }[] = [];
  if (p.nodes === 'nodes-with-exports-only') {
    const pageId = p.pageId ?? activePageId;
    const ids = configuredNodes(doc, pageId);
    if (!ids.length) throw new MarkupError('INVALID_ARGUMENT', 'No nodes on this page have export settings. Pass nodes as a map of node ID to settings ([] for defaults).');
    for (const nodeId of ids) for (const setting of doc.exportsOf(nodeId)) jobs.push({ nodeId, setting });
  } else {
    for (const [nodeId, settings] of Object.entries(p.nodes)) {
      // [] means the node's own settings, or the default when it has none (exportsOf also checks the node exists).
      const own = doc.exportsOf(nodeId);
      const list = settings.length ? settings : own.length ? own : [DEFAULT_EXPORT];
      for (const setting of list) jobs.push({ nodeId, setting });
    }
  }
  if (!jobs.length) throw new MarkupError('INVALID_ARGUMENT', 'Nothing to export: nodes is empty.');
  if (jobs.some((j) => VIDEO.has(j.setting.format))) throw unsupportedVideo();
  const skipped: SkippedNode[] = [];
  const strict = p.nodes !== 'nodes-with-exports-only' && Object.keys(p.nodes).length === 1;
  const ids = dropHidden(doc, [...new Set(jobs.map((j) => j.nodeId))], strict, skipped);
  if (!ids.length) return withSkipped([], skipped);
  return withRenderedNodes(doc, ids, async (element) => {
    const files: ExportedFile[] = [];
    const sizeless = new Set<string>();
    for (const { nodeId, setting } of jobs) {
      if (!ids.includes(nodeId) || sizeless.has(nodeId)) continue;
      const el = element(nodeId);
      if (!strict && !hasSize(el)) {
        sizeless.add(nodeId);
        skipped.push({ nodeId, reason: NO_SIZE });
        continue;
      }
      const r = await renderExport(el, setting);
      const file: ExportedFile = { nodeId, name: doc.requireNode(nodeId).name, format: setting.format, scale: setting.scale, mimeType: r.mimeType, data: toBase64(r.bytes), width: r.width, height: r.height };
      if (r.clampedScale !== undefined) file.clampedScale = r.clampedScale;
      files.push(file);
    }
    return withSkipped(files, skipped);
  });
}

async function exportCombinedPdf(doc: MarkupDoc, params: Record<string, unknown>): Promise<ExportResult> {
  const { nodeIds } = parse<{ nodeIds: string[] }>('export_combined_pdf', params);
  const unique = [...new Set(nodeIds)];
  for (const id of unique) doc.requireNode(id);
  const skipped: SkippedNode[] = [];
  const ids = dropHidden(doc, unique, unique.length === 1, skipped);
  if (!ids.length) throw new MarkupError('INVALID_ARGUMENT', 'Nothing to export: every node is hidden.');
  const pos = new Map(ids.map((id) => [id, worldPosition(doc, id)]));
  ids.sort((a, b) => pos.get(a)!.y - pos.get(b)!.y || pos.get(a)!.x - pos.get(b)!.x);
  const pdfSettings = ids.flatMap((id) => doc.exportsOf(id)).filter((s) => s.format === 'pdf');
  const quality = pdfSettings.length ? pdfSettings.map((s) => s.pdfQuality ?? 'high').reduce((a, b) => (QUALITY_RANK[b] > QUALITY_RANK[a] ? b : a)) : 'high';
  const resampling = !pdfSettings.length || pdfSettings.some((s) => (s.pdfResampling ?? 'detailed') === 'detailed') ? 'detailed' : 'basic';
  return withRenderedNodes(doc, ids, async (element) => {
    const pages = ids.filter((nodeId) => {
      if (ids.length === 1 || hasSize(element(nodeId))) return true;
      skipped.push({ nodeId, reason: NO_SIZE });
      return false;
    });
    if (!pages.length) throw new MarkupError('INVALID_ARGUMENT', 'Nothing to export: no node has a size.');
    const r = await renderPdf(pages.map(element), { quality, resampling });
    return withSkipped([{ nodeId: pages[0]!, name: doc.name, format: 'pdf', scale: '1x', mimeType: r.mimeType, data: toBase64(r.bytes), width: r.width, height: r.height }], skipped);
  });
}

function fillUrl(doc: MarkupDoc, nodeId: string): string | null {
  const node = doc.requireNode(nodeId);
  if (node.type === 'image' && node.src) return node.src;
  const bg = node.styles.backgroundImage;
  const m = typeof bg === 'string' ? /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(bg) : null;
  return m?.[2] || null;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new MarkupError('INVALID_ARGUMENT', `Could not load the image at ${url.startsWith('data:') ? 'its data URL' : url}.`));
    img.src = url;
  });
}

async function fillImage(doc: MarkupDoc, params: Record<string, unknown>) {
  const { nodeId } = parse<{ nodeId: string }>('get_fill_image', params);
  const node = doc.requireNode(nodeId);
  if (node.type === 'svg') return { message: `Node ${nodeId} is an SVG layer, not an image fill. Use get_jsx to read its SVG markup.` };
  const url = fillUrl(doc, nodeId);
  if (!url) return { message: `Node ${nodeId} has no image fill.` };
  const img = await loadImage(url);
  const ratio = Math.min(1, MAX_FILL_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is not available.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return {
    data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    mimeType: 'image/jpeg',
    width: canvas.width,
    height: canvas.height,
    // A data URL would only repeat the image; agents get the pixels above.
    originalUrl: url.startsWith('data:') ? null : url,
  };
}

/** export, export_combined_pdf and get_fill_image for one open document; nodes on any page render off-screen. */
export function runExportTool(doc: MarkupDoc, method: ExportToolName, params: Record<string, unknown>, ctx: { activePageId: string }): Promise<unknown> {
  if (method === 'export') return exportNodes(doc, params, ctx.activePageId);
  if (method === 'export_combined_pdf') return exportCombinedPdf(doc, params);
  return fillImage(doc, params);
}
