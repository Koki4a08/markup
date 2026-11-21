import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** One rendered file, as the editor returns it from export / export_combined_pdf. */
export interface ExportedFile {
  nodeId: string;
  name: string;
  format: string;
  scale: string;
  mimeType: string;
  /** Base64 file contents. */
  data: string;
  /** The pixel ratio used when the requested scale was over the render size limit. */
  clampedScale?: number;
}

export interface WrittenExport {
  nodeId: string;
  /** Absent when the file was rejected; see error. */
  path?: string;
  format: string;
  /** Set when the editor clamped the scale to stay under the render size limit. */
  clampedScale?: number;
  /** Why the file was not written. */
  error?: string;
}

/** Local copies of @markup/doc's SCALE_PATTERN and EXPORT_FORMATS: the editor's reply is not trusted. */
const SCALE_PATTERN = /^\d+(\.\d+)?(x|w|h|p)$/;
const EXPORT_FORMATS = new Set(['avif', 'jpg', 'mp4', 'pdf', 'png', 'svg', 'webm', 'webp']);

/** Where exports go: MARKUP_EXPORT_DIR, else ~/Downloads/Markup. */
export function exportDir(): string {
  return process.env.MARKUP_EXPORT_DIR || join(homedir(), 'Downloads', 'Markup');
}

/** Layer names become file names: path separators and characters Windows rejects become "-". */
function sanitize(name: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-').trim().replace(/[. ]+$/, '');
  return clean || 'Untitled';
}

/** Writes each file into dir (created if missing), never overwriting: "Hero@2x.png", "Hero (2)@2x.png", ... */
export function writeExports(result: { files: ExportedFile[] }, dir: string = exportDir()): WrittenExport[] {
  mkdirSync(dir, { recursive: true });
  const root = resolve(dir);
  return result.files.map((file): WrittenExport => {
    const format = String(file.format);
    const clamped = typeof file.clampedScale === 'number' ? { clampedScale: file.clampedScale } : {};
    const reject = (error: string): WrittenExport => ({ nodeId: file.nodeId, format, error });
    if (typeof file.scale !== 'string' || !SCALE_PATTERN.test(file.scale)) return reject(`Invalid export scale ${JSON.stringify(file.scale)}; the file was not written.`);
    if (!EXPORT_FORMATS.has(format)) return reject(`Invalid export format ${JSON.stringify(file.format)}; the file was not written.`);
    const base = sanitize(String(file.name ?? ''));
    const suffix = `@${file.scale}.${format}`;
    let path = join(dir, base + suffix);
    for (let n = 2; existsSync(path); n++) path = join(dir, `${base} (${n})${suffix}`);
    const full = resolve(path);
    if (!full.startsWith(root + sep) || full.slice(root.length + 1).includes(sep)) return reject('The export file name points outside the export folder; the file was not written.');
    writeFileSync(path, Buffer.from(file.data, 'base64'), { flag: 'wx' });
    return { nodeId: file.nodeId, path, format, ...clamped };
  });
}
