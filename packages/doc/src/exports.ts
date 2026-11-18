import type { MarkupDoc } from './document';
import { MarkupError } from './schema';

export const EXPORT_FORMATS = ['avif', 'jpg', 'mp4', 'pdf', 'png', 'svg', 'webm', 'webp'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportSetting {
  format: ExportFormat;
  /** "2x" multiplier, or a target size: "720p" shortest side, "512w" width, "512h" height. */
  scale: string;
  pdfQuality?: 'low' | 'medium' | 'high';
  pdfResampling?: 'detailed' | 'basic';
  durationSeconds?: number;
}

export const DEFAULT_EXPORT: ExportSetting = { format: 'png', scale: '2x' };

export const SCALE_PATTERN = /^\d+(\.\d+)?(x|w|h|p)$/;

/** Pixel ratio for a scale string, given the node's size in CSS px. */
export function parseScale(scale: string, size: { width: number; height: number }): number {
  const m = SCALE_PATTERN.exec(scale);
  const value = m ? Number(scale.slice(0, -1)) : NaN;
  if (!m || !(value > 0)) throw new MarkupError('INVALID_PARAMS', `Invalid export scale "${scale}". Use a multiplier like "2x", or a size like "720p", "512w" or "512h".`);
  const unit = m[2];
  if (unit === 'x') return value;
  const side = unit === 'w' ? size.width : unit === 'h' ? size.height : Math.min(size.width, size.height);
  if (!(side > 0)) throw new MarkupError('INVALID_ARGUMENT', `Cannot export at "${scale}": the node has no size.`);
  return value / side;
}

const QUALITIES = ['low', 'medium', 'high'];
const RESAMPLING = ['detailed', 'basic'];

function validate(settings: ExportSetting[]): ExportSetting[] {
  if (!Array.isArray(settings)) throw new MarkupError('INVALID_ARGUMENT', 'Export settings must be an array.');
  return settings.map((s) => {
    if (!s || !(EXPORT_FORMATS as readonly string[]).includes(s.format)) throw new MarkupError('INVALID_ARGUMENT', `Unknown export format "${s?.format}". Use one of ${EXPORT_FORMATS.join(', ')}.`);
    parseScale(String(s.scale), { width: 1, height: 1 });
    if (s.pdfQuality !== undefined && !QUALITIES.includes(s.pdfQuality)) throw new MarkupError('INVALID_ARGUMENT', `Unknown pdfQuality "${s.pdfQuality}".`);
    if (s.pdfResampling !== undefined && !RESAMPLING.includes(s.pdfResampling)) throw new MarkupError('INVALID_ARGUMENT', `Unknown pdfResampling "${s.pdfResampling}".`);
    if (s.durationSeconds !== undefined && !(s.durationSeconds >= 1 && s.durationSeconds <= 300)) throw new MarkupError('INVALID_ARGUMENT', 'durationSeconds must be between 1 and 300.');
    const out: ExportSetting = { format: s.format, scale: s.scale };
    if (s.pdfQuality !== undefined) out.pdfQuality = s.pdfQuality;
    if (s.pdfResampling !== undefined) out.pdfResampling = s.pdfResampling;
    if (s.durationSeconds !== undefined) out.durationSeconds = s.durationSeconds;
    return out;
  });
}

/** Replaces a node's export settings; stored as a JSON array on the node's `exports` field. */
export function setExports(doc: MarkupDoc, nodeId: string, settings: ExportSetting[]): void {
  const node = doc.yNode(nodeId);
  const clean = validate(settings);
  if (clean.length) node.set('exports', clean);
  else node.delete('exports');
}

export function exportsOf(doc: MarkupDoc, nodeId: string): ExportSetting[] {
  const value = doc.yNode(nodeId).get('exports');
  return Array.isArray(value) ? (value as ExportSetting[]).map((s) => ({ ...s })) : [];
}
