import { MarkupError, type MarkupDoc } from '@markup/doc';
import type { DomToolName } from '@markup/protocol';
import type { DomTools } from './client';
import { nodeElementIn } from '../canvas/registry';
import { revealsSettled } from '../canvas/deferred';

const MAX_SCREENSHOT_SIDE = 2048;
const THUMBNAIL_WIDTH = 320;
/**
 * Dashboard cards show the whole artboard scaled to fit a short box, so a tall artboard never shows
 * taller than this; capping the bitmap keeps tall captured pages from storing a huge image.
 */
const THUMBNAIL_MAX_HEIGHT = 480;
const COMPONENT: Record<string, string> = { frame: 'Frame', text: 'Text', image: 'Image', svg: 'SVG', root: 'Root' };

const toCamel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** The protocol's zod schemas and html-to-image load with the first agent call, not at startup. */
async function parse<T>(name: DomToolName, params: unknown): Promise<T> {
  const { tools } = await import('@markup/protocol');
  const r = tools[name].input.safeParse(params ?? {});
  if (!r.success) throw new MarkupError('INVALID_PARAMS', `Invalid parameters for ${name}: ${r.error.issues.map((i) => i.message).join('; ')}`);
  return r.data as T;
}

/** Tools that need the rendered canvas: selection, computed styles, screenshots. */
export function createDomTools(opts: { doc: MarkupDoc; canvas: () => HTMLElement | null; getSelection(): string[] }): DomTools {
  const element = (id: string) => {
    const node = opts.doc.getNode(id);
    if (!node) throw new MarkupError('NODE_NOT_FOUND', `Node ${id} does not exist.`);
    const root = opts.canvas();
    const el = root ? nodeElementIn(root, id) : null;
    if (!el) throw new MarkupError('NODE_NOT_FOUND', `Node ${id} is not rendered. It is on another page than the one the user is viewing, or hidden.`);
    return el;
  };

  /** Computed values of a fresh element of the same tag, used to report only what the node changes. */
  const defaultsFor = (tag: string): CSSStyleDeclaration => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
    const probe = document.createElement(tag);
    host.appendChild(probe);
    document.body.appendChild(host);
    const snapshot = getComputedStyle(probe);
    const copy = {} as Record<string, string>;
    for (let i = 0; i < snapshot.length; i++) {
      const prop = snapshot.item(i);
      copy[prop] = snapshot.getPropertyValue(prop);
    }
    host.remove();
    return copy as unknown as CSSStyleDeclaration;
  };

  return {
    get_selection: () => ({
      nodes: opts
        .getSelection()
        .map((id) => opts.doc.getNode(id))
        .filter((n) => !!n)
        .map((n) => {
          const root = opts.canvas();
          const el = root ? nodeElementIn(root, n.id) : null;
          return { id: n.id, name: n.name, component: COMPONENT[n.type], width: el?.offsetWidth ?? null, height: el?.offsetHeight ?? null, artboardId: opts.doc.artboardOf(n.id) };
        }),
    }),

    get_computed_styles: async (params) => {
      const { nodeIds } = await parse<{ nodeIds: string[] }>('get_computed_styles', params);
      // Layers an agent just wrote may still be mounting behind a placeholder.
      await revealsSettled();
      const out: Record<string, Record<string, string>> = {};
      const defaults = new Map<string, CSSStyleDeclaration>();
      for (const id of nodeIds) {
        const el = element(id);
        const tag = el.tagName.toLowerCase();
        if (!defaults.has(tag)) defaults.set(tag, defaultsFor(tag));
        const base = defaults.get(tag) as unknown as Record<string, string>;
        const cs = getComputedStyle(el);
        const styles: Record<string, string> = {};
        for (let i = 0; i < cs.length; i++) {
          const prop = cs.item(i);
          const v = cs.getPropertyValue(prop);
          if (v !== base[prop] && prop !== 'translate') styles[toCamel(prop)] = v;
        }
        styles.width = `${el.offsetWidth}px`;
        styles.height = `${el.offsetHeight}px`;
        out[id] = styles;
      }
      return out;
    },

    get_screenshot: async (params) => {
      const { nodeId, scale = 1 } = await parse<{ nodeId: string; scale?: number }>('get_screenshot', params);
      await revealsSettled();
      const el = element(nodeId);
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h) throw new MarkupError('INVALID_ARGUMENT', `Node ${nodeId} has no size to capture.`);
      const pixelRatio = Math.min(scale, MAX_SCREENSHOT_SIDE / Math.max(w, h));
      const { toPng } = await import('html-to-image');
      const dataUrl = await toPng(el, { pixelRatio, cacheBust: true, style: { translate: 'none', margin: '0', left: '0', top: '0', position: 'relative' } });
      return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png', width: Math.round(w * pixelRatio), height: Math.round(h * pixelRatio) };
    },
  };
}

/**
 * Image data URL of an artboard for the dashboard: at most 320px wide and 480px tall, WebP where
 * the webview can encode it (it keeps transparency), else PNG. The element is cloned at once,
 * so the capture still finishes when the editor unmounts right after (closing its tab).
 */
export function captureThumbnail(canvas: HTMLElement | null, artboardId: string | undefined): Promise<string | undefined> | undefined {
  const el = artboardId && canvas ? nodeElementIn(canvas, artboardId) : null;
  if (!el || !el.offsetWidth || !el.offsetHeight) return undefined;
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const clone = el.cloneNode(true) as HTMLElement;
  Object.assign(clone.style, { position: 'relative', left: '0', top: '0', margin: '0', translate: 'none' });
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;';
  host.appendChild(clone);
  document.body.appendChild(host);
  const pixelRatio = Math.min(THUMBNAIL_WIDTH / width, THUMBNAIL_MAX_HEIGHT / height);
  return import('html-to-image')
    .then(({ toCanvas }) => toCanvas(clone, { width, height, pixelRatio }))
    .then((canvas) => canvas.toDataURL('image/webp', 0.85) as string | undefined)
    .finally(() => host.remove());
}
