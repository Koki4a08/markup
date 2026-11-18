import { toPng } from 'html-to-image';
import { MarkupError, type MarkupDoc } from '@markup/doc';
import { tools } from '@markup/protocol';
import type { DomTools } from './client';

const MAX_SCREENSHOT_SIDE = 2048;
const COMPONENT: Record<string, string> = { frame: 'Frame', text: 'Text', image: 'Image', svg: 'SVG', root: 'Root' };

const toCamel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

function parse<T>(name: keyof typeof tools, params: unknown): T {
  const r = tools[name].input.safeParse(params ?? {});
  if (!r.success) throw new MarkupError('INVALID_PARAMS', `Invalid parameters for ${name}: ${r.error.issues.map((i) => i.message).join('; ')}`);
  return r.data as T;
}

/** Tools that need the rendered canvas: selection, computed styles, screenshots. */
export function createDomTools(opts: { doc: MarkupDoc; canvas: () => HTMLElement | null; getSelection(): string[] }): DomTools {
  const element = (id: string) => {
    const node = opts.doc.getNode(id);
    if (!node) throw new MarkupError('NODE_NOT_FOUND', `Node ${id} does not exist.`);
    const el = opts.canvas()?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
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
          const el = opts.canvas()?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(n.id)}"]`);
          return { id: n.id, name: n.name, component: COMPONENT[n.type], width: el?.offsetWidth ?? null, height: el?.offsetHeight ?? null, artboardId: opts.doc.artboardOf(n.id) };
        }),
    }),

    get_computed_styles: (params) => {
      const { nodeIds } = parse<{ nodeIds: string[] }>('get_computed_styles', params);
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
      const { nodeId, scale = 1 } = parse<{ nodeId: string; scale?: number }>('get_screenshot', params);
      const el = element(nodeId);
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h) throw new MarkupError('INVALID_ARGUMENT', `Node ${nodeId} has no size to capture.`);
      const pixelRatio = Math.min(scale, MAX_SCREENSHOT_SIDE / Math.max(w, h));
      const dataUrl = await toPng(el, { pixelRatio, cacheBust: true, style: { translate: 'none', margin: '0', left: '0', top: '0', position: 'relative' } });
      return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mimeType: 'image/png', width: Math.round(w * pixelRatio), height: Math.round(h * pixelRatio) };
    },
  };
}
