import { TickStore } from './store';

/**
 * Bumped (once per frame) when canvas layout changes without a document transaction: a web font
 * finishes loading, an image inside a layer decodes, or inline text editing grows a layer. Overlays
 * that cache measured world rects re-measure on it, since pan and zoom no longer re-measure.
 */
export const layoutTick = new TickStore();

let installed = false;

const inLayer = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-node-id]');

/** Installs the global listeners once; they live for the page. */
export function watchLayout(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const bump = () => layoutTick.bump();
  document.fonts?.addEventListener?.('loadingdone', bump);
  // load does not bubble; capture sees every image (and other media) load in the canvas.
  document.addEventListener('load', (e) => inLayer(e.target) && bump(), true);
  document.addEventListener('input', (e) => inLayer(e.target) && bump(), true);
}
