import { DEFAULT_EXPORT, toJsx, type ExportSetting, type MarkupDoc } from '@markup/doc';
import { copyImage, copyText, saveFile } from './clipboard';
import { renderExport, withRenderedNodes } from './render';

/** `<layer name>@<scale>.<ext>`, safe as a file name. */
export const exportFileName = (layerName: string, scale: string, ext: string) => `${layerName.replace(/[\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'Layer'}@${scale}.${ext}`;

export async function copyAsCode(doc: MarkupDoc, ids: string[], format: 'inline-styles' | 'tailwind'): Promise<string> {
  await copyText(ids.map((id) => toJsx(doc, id, { format, includeNodeIds: false })).join('\n\n'));
  return format === 'tailwind' ? 'Copied as Tailwind' : 'Copied as React';
}

export async function copyAsPng(doc: MarkupDoc, ids: string[]): Promise<string> {
  const [id] = ids;
  if (!id) return '';
  const rendered = await withRenderedNodes(doc, [id], (element) => renderExport(element(id), { format: 'png', scale: '2x' }));
  await copyImage(rendered.bytes, rendered.mimeType);
  return ids.length > 1 ? 'Copied the first layer as PNG' : 'Copied as PNG';
}

/** Exports each node with its own settings (a default PNG at 2x when it has none). Returns how many files were saved. */
export async function exportNodes(doc: MarkupDoc, ids: string[]): Promise<number> {
  const jobs = ids.map((id) => ({ id, name: doc.requireNode(id).name, settings: doc.exportsOf(id).length ? doc.exportsOf(id) : [DEFAULT_EXPORT] }));
  const pending = jobs.flatMap((j) => j.settings.map((s: ExportSetting) => ({ ...j, setting: s })));
  const exportable = pending.filter((p) => p.setting.format !== 'mp4' && p.setting.format !== 'webm');
  if (exportable.length === 0) throw new Error('Video export is not available yet.');
  let count = 0;
  await withRenderedNodes(doc, ids, async (element) => {
    for (const job of exportable) {
      const out = await renderExport(element(job.id), job.setting);
      if (await saveFile(exportFileName(job.name, job.setting.scale, out.ext), out.bytes, out.mimeType)) count++;
    }
  });
  return count;
}
