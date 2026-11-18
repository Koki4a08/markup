import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One rendered file, as the editor returns it from export / export_combined_pdf. */
export interface ExportedFile {
  nodeId: string;
  name: string;
  format: string;
  scale: string;
  mimeType: string;
  /** Base64 file contents. */
  data: string;
}

export interface WrittenExport {
  nodeId: string;
  path: string;
  format: string;
}

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
  return result.files.map((file) => {
    const base = sanitize(file.name);
    const suffix = `@${file.scale}.${file.format}`;
    let path = join(dir, base + suffix);
    for (let n = 2; existsSync(path); n++) path = join(dir, `${base} (${n})${suffix}`);
    writeFileSync(path, Buffer.from(file.data, 'base64'), { flag: 'wx' });
    return { nodeId: file.nodeId, path, format: file.format };
  });
}
