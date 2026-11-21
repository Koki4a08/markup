/**
 * id -> rendered element, filled by NodeView's ref, so canvas measuring does not scan the whole DOM with an
 * attribute selector per node. The same id can be mounted more than once (the export renderer mounts
 * NodeViews off-screen), so each lookup picks the element inside the requested root, and falls back to a
 * query when the registry has none (elements created outside NodeView, as tests do).
 */
const elements = new Map<string, Set<HTMLElement>>();

/** Registers a rendered node element; returns the cleanup that removes it. */
export function registerNodeElement(id: string, el: HTMLElement): () => void {
  let set = elements.get(id);
  if (!set) elements.set(id, (set = new Set()));
  set.add(el);
  return () => {
    const current = elements.get(id);
    if (!current) return;
    current.delete(el);
    if (!current.size) elements.delete(id);
  };
}

const selector = (id: string) => `[data-node-id="${CSS.escape(id)}"]`;

/** The element rendering node id inside root (the canvas, or any container of NodeViews). */
export function nodeElementIn(root: Element, id: string): HTMLElement | null {
  const set = elements.get(id);
  if (set) for (const el of set) if (root.contains(el)) return el;
  return root.querySelector<HTMLElement>(selector(id));
}

/** The element rendering node id on the editor canvas (inside `.canvas-world`). */
export function canvasNodeElement(id: string): HTMLElement | null {
  const set = elements.get(id);
  if (set) for (const el of set) if (el.isConnected && el.closest('.canvas-world')) return el;
  return document.querySelector<HTMLElement>(`.canvas-world ${selector(id)}`);
}
