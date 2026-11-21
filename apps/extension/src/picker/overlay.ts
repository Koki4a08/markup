import { visibleShape } from '../capture/clip';

/*
 * Picker chrome, drawn in closed shadow roots so the page's CSS never reaches it. It matches the Markup
 * editor: graphite surfaces, hairline borders, blue for the target and selection.
 */
const FONT = `system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; pointer-events: none; }
.box { position: fixed; display: none; border: 1.5px solid #4c8dff; background: rgba(76, 141, 255, 0.1); border-radius: 2px;
  transition: left 80ms ease-out, top 80ms ease-out, width 80ms ease-out, height 80ms ease-out; }
.box.picked { background: rgba(76, 141, 255, 0.18); border-style: dashed; transition: none; }
.box.capturing { border-style: solid; animation: scan 1.1s ease-in-out infinite; }
@keyframes scan { 50% { background: rgba(76, 141, 255, 0.28); box-shadow: 0 0 0 4px rgba(76, 141, 255, 0.18); } }
.label { position: fixed; display: none; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 6px;
  background: #161618; border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 6px 18px -6px rgba(0, 0, 0, 0.5);
  color: #a1a1aa; font: 500 11px/1 ${FONT}; white-space: nowrap; max-width: 80vw; overflow: hidden; }
.label b { color: #8ab4ff; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.hint { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
  max-width: calc(100vw - 32px); padding: 8px 14px 8px 10px; border-radius: 12px; background: #161618;
  border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 16px 40px -10px rgba(0, 0, 0, 0.6);
  color: #ededef; font: 500 12.5px/18px ${FONT}; white-space: nowrap; overflow: hidden; animation: rise 220ms cubic-bezier(0.16, 1, 0.3, 1); }
.hint .item { display: inline-flex; align-items: center; gap: 6px; }
.hint .dot { width: 3px; height: 3px; border-radius: 50%; background: #52525b; flex: none; }
kbd { display: inline-grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 5px;
  background: #26262a; border: 1px solid rgba(255, 255, 255, 0.12); border-bottom-width: 2px; color: #ededef;
  font: 600 11px/1 ${FONT}; }
.mark { display: grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: 6px; background: #2f6fe8; color: #fff; }
.status { position: fixed; left: 50%; top: 18px; display: flex; align-items: center; gap: 10px; min-width: 220px; max-width: min(460px, calc(100vw - 32px));
  padding: 10px 14px 12px 12px; border-radius: 12px; background: #161618; border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 16px 40px -10px rgba(0, 0, 0, 0.6); color: #ededef; font: 500 13px/18px ${FONT};
  overflow: hidden; transform: translateX(-50%); animation: drop 240ms cubic-bezier(0.16, 1, 0.3, 1); }
.status.leaving { opacity: 0; transform: translate(-50%, -6px); transition: opacity 200ms ease-out, transform 200ms ease-out; }
.status .icon { display: grid; place-items: center; width: 22px; height: 22px; flex: none; border-radius: 6px; background: #26262a; color: #8ab4ff; }
.status .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status .pct { color: #a1a1aa; font-variant-numeric: tabular-nums; }
.status .bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: #4c8dff; transform-origin: 0 50%;
  transform: scaleX(0); }
.status .pct { min-width: 34px; text-align: right; }
.cover { position: fixed; left: 0; top: 0; display: block; max-width: none; }
.status.done .icon { background: rgba(52, 211, 153, 0.14); color: #34d399; }
.status.done .bar { background: #34d399; }
.status.error .icon { background: rgba(248, 113, 113, 0.14); color: #f87171; }
.status.error .bar { display: none; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes rise { from { opacity: 0; transform: translate(-50%, 8px); } }
@keyframes drop { from { opacity: 0; transform: translate(-50%, -8px); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The hint bar's shortcuts, in the reading order of the bar. */
export function hintItems(mac = isMac()): { keys: string[]; text: string }[] {
  return [
    { keys: ['Click', '↵'], text: 'capture' },
    { keys: ['⇧'], text: 'add to selection' },
    { keys: [mac ? '⌥' : 'Alt', '↵'], text: 'simplified' },
    { keys: [mac ? '⌘' : 'Ctrl', '↵'], text: 'whole page' },
    { keys: ['↑', '↓'], text: 'fine-tune' },
    { keys: ['Esc'], text: 'cancel' },
  ];
}

/** The hint as one line of text (also the bar's accessible name). */
export const HINT = hintItems(false)
  .map((i) => `${i.keys.join(' ')} ${i.text}`)
  .join(' · ');

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(doc: Document, paths: string, cls = ''): SVGSVGElement {
  const el = doc.createElementNS(SVG_NS, 'svg');
  el.setAttribute('width', '14');
  el.setAttribute('height', '14');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '2');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  if (cls) el.setAttribute('class', cls);
  for (const d of paths.split('|')) {
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    el.appendChild(p);
  }
  return el;
}

const ICON = {
  mark: 'M4 8V5a1 1 0 0 1 1-1h3|M16 4h3a1 1 0 0 1 1 1v3|M20 16v3a1 1 0 0 1-1 1h-3|M8 20H5a1 1 0 0 1-1-1v-3|M10 9.5l5.5 2.3-2.3.8-.8 2.3z',
  spinner: 'M21 12a9 9 0 1 1-6.2-8.56',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 8v5|M12 16.5h.01|M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
};

export class Overlay {
  readonly host: HTMLElement;
  private readonly box: HTMLElement;
  private readonly label: HTMLElement;
  private readonly picked: HTMLElement[] = [];
  private readonly root: ShadowRoot;
  private status: CaptureStatus | null = null;

  constructor(private readonly doc: Document) {
    [this.host, this.root] = shadowHost(doc);
    this.box = this.div('box');
    this.label = this.div('label');
    this.root.append(this.box, this.label, hintBar(doc));
    doc.documentElement.appendChild(this.host);
  }

  private div(cls: string): HTMLElement {
    const d = this.doc.createElement('div');
    d.className = cls;
    return d;
  }

  highlight(target: Element | null): void {
    if (!target) {
      this.box.style.display = 'none';
      this.label.style.display = 'none';
      return;
    }
    const r = target.getBoundingClientRect();
    placeShape(this.box, target);
    const [name, size] = describe(target, r).split(' · ');
    const b = this.doc.createElement('b');
    b.textContent = name ?? '';
    this.label.replaceChildren(b, this.doc.createTextNode(size ?? ''));
    this.label.style.display = 'flex';
    this.label.style.left = `${Math.max(4, r.left)}px`;
    this.label.style.top = `${r.top > 30 ? r.top - 28 : r.bottom + 6}px`;
  }

  showSelected(elements: Element[]): void {
    while (this.picked.length > elements.length) this.picked.pop()!.remove();
    while (this.picked.length < elements.length) {
      const d = this.div('box picked');
      this.root.appendChild(d);
      this.picked.push(d);
    }
    elements.forEach((el, i) => {
      this.picked[i]!.className = 'box picked';
      placeShape(this.picked[i]!, el);
    });
  }

  /** Marks the targets as being copied: the picked outlines pulse until the capture settles. */
  showCapturing(elements: Element[]): void {
    this.showSelected(elements);
    for (const d of this.picked) d.className = 'box picked capturing';
    this.box.style.display = 'none';
    this.label.style.display = 'none';
  }

  /** A one-line message (errors from capture); replaces any status the overlay shows. */
  toast(message: string, error = false): void {
    this.status ??= new CaptureStatus(this.doc);
    if (error) this.status.fail(message);
    else this.status.succeed(message);
    for (const d of this.picked) d.className = 'box picked';
  }

  /** Hides or shows the picker chrome (hint, outlines) without tearing it down. */
  setVisible(visible: boolean): void {
    this.host.style.visibility = visible ? '' : 'hidden';
  }

  destroy(): void {
    this.status?.dismiss();
    this.host.remove();
  }
}

function hintBar(doc: Document): HTMLElement {
  const bar = doc.createElement('div');
  bar.className = 'hint';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-label', HINT);
  const mark = doc.createElement('span');
  mark.className = 'mark';
  mark.append(svg(doc, ICON.mark));
  bar.append(mark);
  hintItems().forEach((item, i) => {
    if (i) {
      const dot = doc.createElement('span');
      dot.className = 'dot';
      bar.append(dot);
    }
    const el = doc.createElement('span');
    el.className = 'item';
    item.keys.forEach((k, j) => {
      if (k === 'Click') el.append(doc.createTextNode(j === 0 && item.keys.length > 1 ? 'Click or' : 'Click'));
      else {
        const kbd = doc.createElement('kbd');
        kbd.textContent = k;
        el.append(kbd);
      }
    });
    el.append(doc.createTextNode(item.text));
    bar.append(el);
  });
  return bar;
}

/**
 * The capture's progress toast at the top of the page: spinner and percentage while copying, then a
 * check (or the error) for a moment. Lives in its own host so it outlives the picker overlay.
 */
export class CaptureStatus {
  private readonly host: HTMLElement;
  private readonly el: HTMLElement;
  private readonly icon: HTMLElement;
  private readonly text: HTMLElement;
  private readonly pct: HTMLElement;
  private readonly bar: HTMLElement;
  /** Where the work actually is (0..1), and what the toast currently draws while it eases toward it. */
  private target = 0;
  private shown = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;
  private last = 0;

  constructor(private readonly doc: Document) {
    let root: ShadowRoot;
    [this.host, root] = shadowHost(doc);
    this.host.setAttribute('data-markup-status', '');
    this.el = doc.createElement('div');
    this.el.className = 'status';
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    this.icon = doc.createElement('span');
    this.icon.className = 'icon';
    this.text = doc.createElement('span');
    this.text.className = 'text';
    this.pct = doc.createElement('span');
    this.pct.className = 'pct';
    this.bar = doc.createElement('span');
    this.bar.className = 'bar';
    this.el.append(this.icon, this.text, this.pct, this.bar);
    root.append(this.el);
    doc.documentElement.appendChild(this.host);
  }

  start(message: string): void {
    clearTimeout(this.timer);
    this.el.className = 'status';
    this.icon.replaceChildren(svg(this.doc, ICON.spinner, 'spin'));
    this.text.textContent = message;
    this.target = this.shown = 0;
    this.draw();
  }

  /** Changes the message while keeping the spinner and progress (one phase of a capture to the next). */
  setMessage(message: string): void {
    this.text.textContent = message;
  }

  /**
   * Real progress from 0 to 1. Never moves backwards and holds below 100% until the copy has landed;
   * the toast eases toward it every frame, so the number climbs smoothly instead of jumping.
   */
  progress(fraction: number): void {
    this.target = Math.min(0.99, Math.max(this.target, fraction));
    this.animate();
  }

  succeed(message: string): void {
    this.target = 1;
    // Let the bar finish its run to 100% before the check replaces the spinner.
    const finish = () => this.settle('done', ICON.check, message, 2200);
    if (this.shown >= 0.995 || !this.canAnimate()) return finish();
    this.animate(finish);
  }

  fail(message: string): void {
    this.settle('error', ICON.alert, message, 4500);
  }

  dismiss(): void {
    clearTimeout(this.timer);
    this.stop();
    this.host.remove();
  }

  private canAnimate(): boolean {
    const win = this.doc.defaultView;
    return !!win && typeof win.requestAnimationFrame === 'function' && !win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  private stop(): void {
    if (this.frame) this.doc.defaultView?.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private animate(done?: () => void): void {
    if (!this.canAnimate()) {
      this.shown = this.target;
      this.draw();
      return done?.();
    }
    if (this.frame) {
      if (done) this.onReached = done;
      return;
    }
    if (done) this.onReached = done;
    const win = this.doc.defaultView!;
    this.last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(64, now - this.last);
      this.last = now;
      const gap = this.target - this.shown;
      // Exponential ease toward the target (~90% of the gap in 400ms), with a small floor so the last
      // percent does not crawl, and a cap so a sudden leap still reads as motion.
      const step = Math.min(gap, Math.max(gap * (1 - Math.exp(-dt / 170)), dt * 0.00012), dt * 0.0022);
      this.shown += step;
      this.draw();
      if (this.target - this.shown > 0.0005) this.frame = win.requestAnimationFrame(tick);
      else {
        this.shown = this.target;
        this.draw();
        this.frame = 0;
        const reached = this.onReached;
        this.onReached = null;
        reached?.();
      }
    };
    this.frame = win.requestAnimationFrame(tick);
  }

  private onReached: (() => void) | null = null;

  private settle(kind: 'done' | 'error', icon: string, message: string, ms: number): void {
    this.stop();
    this.onReached = null;
    this.el.className = `status ${kind}`;
    this.icon.replaceChildren(svg(this.doc, icon));
    this.text.textContent = message;
    this.pct.textContent = '';
    if (kind === 'done') this.bar.style.transform = 'scaleX(1)';
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.el.classList.add('leaving');
      this.timer = setTimeout(() => this.dismiss(), 220);
    }, ms);
  }

  private draw(): void {
    this.pct.textContent = `${Math.floor(this.shown * 100)}%`;
    this.bar.style.transform = `scaleX(${this.shown})`;
  }
}

/**
 * A still picture of the tab laid over the page while it is scrolled through in the background, so the
 * reader keeps seeing exactly what they were looking at. The page's own scrollbar is made transparent
 * for the duration (its width stays, so nothing reflows).
 */
export class ScrollCover {
  private host: HTMLElement | null = null;
  private restoreScrollbar: (() => void) | null = null;

  constructor(private readonly doc: Document) {}

  /** Shows the cover from a screenshot data URL; false when the picture could not be prepared. */
  async show(dataUrl: string): Promise<boolean> {
    const doc = this.doc;
    const win = doc.defaultView!;
    const img = doc.createElement('img');
    img.src = dataUrl;
    try {
      await img.decode();
    } catch {
      return false;
    }
    const [host, root] = shadowHost(doc);
    host.setAttribute('data-markup-cover', '');
    img.className = 'cover';
    img.alt = '';
    img.style.width = `${win.innerWidth}px`;
    img.style.height = `${win.innerHeight}px`;
    root.append(img);
    // Under the progress toast, above everything else.
    const status = doc.querySelector('[data-markup-status]');
    if (status) doc.documentElement.insertBefore(host, status);
    else doc.documentElement.appendChild(host);
    this.host = host;
    const html = doc.documentElement;
    const previous = html.style.getPropertyValue('scrollbar-color');
    const priority = html.style.getPropertyPriority('scrollbar-color');
    html.style.setProperty('scrollbar-color', 'transparent transparent', 'important');
    this.restoreScrollbar = () => html.style.setProperty('scrollbar-color', previous, priority);
    return true;
  }

  remove(): void {
    this.host?.remove();
    this.host = null;
    this.restoreScrollbar?.();
    this.restoreScrollbar = null;
  }
}

const viewportShapeEnv = (win: Window) => ({ style: (el: Element) => win.getComputedStyle(el), rect: (el: Element) => el.getBoundingClientRect() });

/** Outlines what the page actually shows of an element: cut by clipping ancestors, with its rounded corners. */
function placeShape(box: HTMLElement, el: Element): void {
  const win = el.ownerDocument.defaultView ?? window;
  const shape = visibleShape(el, viewportShapeEnv(win));
  place(box, shape.rect);
  box.style.borderRadius = shape.radii.join(' ');
}

/** A full-viewport, click-through host with the overlay styles in a closed shadow root. Capture skips it. */
function shadowHost(doc: Document): [HTMLElement, ShadowRoot] {
  const host = doc.createElement('div');
  host.setAttribute('data-markup-snapshot', '');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = STYLE;
  root.append(style);
  return [host, root];
}

/** A toast that outlives the picker overlay (shown after a successful capture stops the picker). */
export function flashToast(doc: Document, message: string, error = false): void {
  const status = new CaptureStatus(doc);
  if (error) status.fail(message);
  else status.succeed(message);
}

function place(el: HTMLElement, r: DOMRect): void {
  el.style.display = 'block';
  el.style.left = `${r.left}px`;
  el.style.top = `${r.top}px`;
  el.style.width = `${r.width}px`;
  el.style.height = `${r.height}px`;
}

export function describe(el: Element, r: DOMRect): string {
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean)[0] : '';
  const name = el.tagName.toLowerCase() + (cls ? `.${cls}` : '');
  return `${name} · ${Math.round(r.width)}×${Math.round(r.height)}`;
}
