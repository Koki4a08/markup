import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkupDoc, type Actor } from '@markup/doc';

/** A real 2x2 JPEG, so jsPDF can read the image header. */
const JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDFoooryz7w/9k=';

const captured: { nodeId: string | null; pixelRatio: number }[] = [];

// jsdom has no canvas and no layout: html-to-image returns a canvas sized like the real one would be.
vi.mock('html-to-image', () => ({
  toCanvas: vi.fn(async (el: HTMLElement, opts: { width: number; height: number; pixelRatio: number }) => {
    captured.push({ nodeId: el.getAttribute('data-node-id'), pixelRatio: opts.pixelRatio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(opts.width * opts.pixelRatio);
    canvas.height = Math.round(opts.height * opts.pixelRatio);
    return canvas;
  }),
  toPng: vi.fn(),
}));

// The AVIF encoder is wasm; the test checks it gets the canvas pixels.
const avifEncode = vi.fn(async (image: { width: number; height: number }) => new TextEncoder().encode(`avif:${image.width}x${image.height}`).buffer);
vi.mock('@jsquash/avif/encode.js', () => ({ default: avifEncode }));

const { runExportTool } = await import('../src/bridge/exportTools');

const human: Actor = { id: 'u1', kind: 'human', name: 'KG' };
const restore: (() => void)[] = [];

beforeAll(() => {
  const px = (v: string) => parseFloat(v) || 0;
  const define = (proto: object, key: string, value: PropertyDescriptor) => {
    const before = Object.getOwnPropertyDescriptor(proto, key);
    Object.defineProperty(proto, key, { configurable: true, ...value });
    restore.push(() => (before ? Object.defineProperty(proto, key, before) : delete (proto as Record<string, unknown>)[key]));
  };
  define(HTMLElement.prototype, 'offsetWidth', { get(this: HTMLElement) { return px(this.style.width); } });
  define(HTMLElement.prototype, 'offsetHeight', { get(this: HTMLElement) { return px(this.style.height); } });
  const ctx = { drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: 'low', getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4), width, height }) };
  define(HTMLCanvasElement.prototype, 'getContext', { value: () => ctx });
  define(HTMLCanvasElement.prototype, 'toBlob', {
    value(this: HTMLCanvasElement, cb: (b: Blob | null) => void, type = 'image/png') {
      if (type === 'image/jpeg') cb(new Blob([Uint8Array.from(atob(JPEG_B64), (c) => c.charCodeAt(0))], { type }));
      else cb(new Blob([`${type}:${this.width}x${this.height}`], { type }));
    },
  });
});
afterAll(() => restore.forEach((r) => r()));
beforeEach(() => {
  captured.length = 0;
});

const decode = (b64: string) => atob(b64);

function setup() {
  const doc = new MarkupDoc({ name: 'Landing' });
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const [card] = doc.insertNodes(human, page.rootId, [{ type: 'frame', name: 'Card', styles: { position: 'absolute', left: 0, top: 0, width: 200, height: 100 } }]);
  const [icon] = doc.insertNodes(human, card!, [{ type: 'svg', name: 'Icon', svg: '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', styles: { width: 20, height: 20 } }]);
  return { doc, pageId: page.id, card: card!, icon: icon! };
}

type Files = { files: { nodeId: string; name: string; format: string; scale: string; mimeType: string; data: string; width?: number; height?: number }[] };

describe('export tools', () => {
  it('png export at 2x has doubled size', async () => {
    const { doc, pageId, card } = setup();
    const res = (await runExportTool(doc, 'export', { nodes: { [card]: [] } }, { activePageId: pageId })) as Files;
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({ nodeId: card, name: 'Card', format: 'png', scale: '2x', mimeType: 'image/png', width: 400, height: 200 });
    expect(decode(res.files[0]!.data)).toBe('image/png:400x200');
    expect(captured).toEqual([{ nodeId: card, pixelRatio: 2 }]);

    const sized = (await runExportTool(doc, 'export', { nodes: { [card]: [{ format: 'webp', scale: '50w' }] } }, { activePageId: pageId })) as Files;
    expect(decode(sized.files[0]!.data)).toBe('image/webp:50x25');
  });

  it('avif is encoded from the canvas pixels', async () => {
    const { doc, pageId, card } = setup();
    const res = (await runExportTool(doc, 'export', { nodes: { [card]: [{ format: 'avif', scale: '1x' }] } }, { activePageId: pageId })) as Files;
    expect(res.files[0]).toMatchObject({ format: 'avif', mimeType: 'image/avif', width: 200, height: 100 });
    expect(decode(res.files[0]!.data)).toBe('avif:200x100');
  });

  it('svg export rejects frames', async () => {
    const { doc, pageId, card, icon } = setup();
    await expect(runExportTool(doc, 'export', { nodes: { [card]: [{ format: 'svg', scale: '1x' }] } }, { activePageId: pageId })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'SVG export is only available for SVG layers.',
    });
    const res = (await runExportTool(doc, 'export', { nodes: { [icon]: [{ format: 'svg', scale: '1x' }] } }, { activePageId: pageId })) as Files;
    expect(res.files[0]).toMatchObject({ format: 'svg', mimeType: 'image/svg+xml' });
    expect(decode(res.files[0]!.data)).toMatch(/^<svg[^>]*xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  });

  it('video gives UNSUPPORTED', async () => {
    const { doc, pageId, card } = setup();
    for (const params of [{ nodes: { [card]: [{ format: 'mp4', scale: '1x' }] } }, { nodes: { [card]: [{ format: 'webm', scale: '1x' }] } }, { type: 'video', nodes: { [card]: [] } }]) {
      await expect(runExportTool(doc, 'export', params, { activePageId: pageId })).rejects.toMatchObject({ code: 'UNSUPPORTED', message: 'Video export is not available yet.' });
    }
  });

  it('exports a node from an inactive page', async () => {
    const { doc, pageId } = setup();
    const other = doc.createPage(human, { name: 'Other' });
    const [hidden] = doc.insertNodes(human, doc.rootOf(other), [{ type: 'frame', name: 'Offstage', styles: { position: 'absolute', left: 500, top: 0, width: 30, height: 40 } }]);
    const res = (await runExportTool(doc, 'export', { nodes: { [hidden!]: [{ format: 'jpg', scale: '1x' }] } }, { activePageId: pageId })) as Files;
    expect(res.files[0]).toMatchObject({ nodeId: hidden, name: 'Offstage', format: 'jpg', mimeType: 'image/jpeg', width: 30, height: 40 });
    // The off-screen host is gone once the export is done.
    expect(document.querySelector('[data-markup-export-host]')).toBeNull();
    expect(document.querySelector(`[data-node-id="${hidden}"]`)).toBeNull();
    await expect(runExportTool(doc, 'export', { nodes: { nope: [] } }, { activePageId: pageId })).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });

  it('nodes-with-exports-only picks configured nodes', async () => {
    const { doc, pageId, card, icon } = setup();
    const other = doc.createPage(human, { name: 'Other' });
    const [elsewhere] = doc.insertNodes(human, doc.rootOf(other), [{ type: 'frame', name: 'Elsewhere', styles: { width: 10, height: 10 } }]);
    doc.setExports(human, icon, [{ format: 'png', scale: '1x' }, { format: 'svg', scale: '1x' }]);
    doc.setExports(human, elsewhere!, [{ format: 'png', scale: '1x' }]);
    const res = (await runExportTool(doc, 'export', { nodes: 'nodes-with-exports-only' }, { activePageId: pageId })) as Files;
    expect(res.files.map((f) => [f.nodeId, f.format])).toEqual([[icon, 'png'], [icon, 'svg']]);
    // An empty array uses the node's own settings.
    const own = (await runExportTool(doc, 'export', { nodes: { [icon]: [] } }, { activePageId: pageId })) as Files;
    expect(own.files.map((f) => f.format)).toEqual(['png', 'svg']);
    // pageId picks another page.
    const there = (await runExportTool(doc, 'export', { pageId: other, nodes: 'nodes-with-exports-only' }, { activePageId: pageId })) as Files;
    expect(there.files.map((f) => f.nodeId)).toEqual([elsewhere]);
    void card;
  });

  it('combined pdf orders by position', async () => {
    const { doc, pageId } = setup();
    const root = doc.rootOf(pageId);
    const at = (name: string, left: number, top: number) =>
      doc.insertNodes(human, root, [{ type: 'frame', name, styles: { position: 'absolute', left, top, width: 100, height: 50 } }])[0]!;
    const c = at('C', 0, 400);
    const b = at('B', 300, 0);
    const a = at('A', 0, 0);
    doc.setExports(human, b, [{ format: 'pdf', scale: '1x', pdfQuality: 'medium', pdfResampling: 'basic' }]);
    const res = (await runExportTool(doc, 'export_combined_pdf', { nodeIds: [c, b, a] }, { activePageId: pageId })) as Files;
    expect(captured.map((x) => x.nodeId)).toEqual([a, b, c]);
    // The only PDF setting found is medium/basic, so pages render at 1x.
    expect(captured.map((x) => x.pixelRatio)).toEqual([1, 1, 1]);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]).toMatchObject({ format: 'pdf', mimeType: 'application/pdf', name: 'Landing' });
    const pdf = decode(res.files[0]!.data);
    expect(pdf.startsWith('%PDF')).toBe(true);
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(3);
  });

  it('get_fill_image explains svg and missing fills', async () => {
    const { doc, pageId, card, icon } = setup();
    await expect(runExportTool(doc, 'get_fill_image', { nodeId: icon }, { activePageId: pageId })).resolves.toMatchObject({ message: expect.stringContaining('get_jsx') });
    await expect(runExportTool(doc, 'get_fill_image', { nodeId: card }, { activePageId: pageId })).resolves.toMatchObject({ message: expect.stringContaining('no image fill') });
    await expect(runExportTool(doc, 'get_fill_image', { nodeId: 'nope' }, { activePageId: pageId })).rejects.toMatchObject({ code: 'NODE_NOT_FOUND' });
  });
});
