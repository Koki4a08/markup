/**
 * Live preview of a drag that changes the HTML tree. The dragged layers' copies are inserted into the real
 * DOM at the drop point, so the browser lays the page out exactly as it will after the drop: siblings
 * reflow, flex rows re-wrap, the container grows. The originals are taken out of layout (display: none)
 * unless the drag duplicates them. Nothing in the document changes until the drop commits one move.
 *
 * The copies are plain clones outside React and outside the node registry (their data-node-id attributes
 * are dropped), so canvas measuring and hit testing never mistake them for layers.
 */
export class FlowPreview {
  private clones: HTMLElement[] | null = null;
  private hidden: { el: HTMLElement; display: string }[] = [];
  private container: HTMLElement | null = null;
  private before: Element | null = null;

  constructor(
    private readonly originals: readonly HTMLElement[],
    private readonly keepOriginals: boolean,
  ) {}

  /** Puts the copies in `container` before `before` (null appends); a no-op when they already sit there. */
  place(container: HTMLElement, before: Element | null): void {
    if (before && before.parentElement !== container) before = null;
    if (this.clones && this.container === container && this.before === before) return;
    const clones = (this.clones ??= this.originals.map(cloneForFlow));
    for (const clone of clones) container.insertBefore(clone, before);
    if (this.container !== container) {
      this.container?.removeAttribute('data-drop-target');
      container.setAttribute('data-drop-target', '');
    }
    this.container = container;
    this.before = before;
    if (!this.keepOriginals && !this.hidden.length) {
      for (const el of this.originals) {
        this.hidden.push({ el, display: el.style.display });
        el.style.display = 'none';
      }
    }
  }

  get active(): boolean {
    return !!this.container;
  }

  /** Removes the copies and the target highlight and brings the originals back, leaving the DOM as React left it. */
  clear(): void {
    for (const clone of this.clones ?? []) clone.remove();
    this.clones = null;
    this.container?.removeAttribute('data-drop-target');
    this.container = null;
    this.before = null;
    for (const { el, display } of this.hidden) el.style.display = display;
    this.hidden = [];
  }
}

/** A copy of a layer's element that joins its new parent's flow: unregistered, and no longer absolutely placed. */
function cloneForFlow(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.removeAttribute('data-node-id');
  for (const inner of clone.querySelectorAll('[data-node-id]')) inner.removeAttribute('data-node-id');
  clone.setAttribute('data-drag-ghost', '');
  clone.setAttribute('aria-hidden', 'true');
  const s = clone.style;
  if (s.position === 'absolute' || s.position === 'fixed') {
    for (const p of ['position', 'left', 'top', 'right', 'bottom', 'inset']) s.removeProperty(p);
  }
  s.removeProperty('translate');
  s.pointerEvents = 'none';
  return clone;
}
