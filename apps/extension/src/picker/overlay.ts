import { visibleShape } from '../capture/clip';
import { ensureUiFont, UI_FONT_FAMILY } from './font';

/*
 * Picker chrome, drawn in closed shadow roots so the page's CSS never reaches it. It uses the dark theme
 * of the Markup editor and markup.here (markup-website/src/styles/globals.css): zinc graphite glass,
 * hairline rings, raised neutral tiles for keys, and the indigo accent for the target and selection.
 * Keep these tokens in step with the site and the editor.
 */
const FONT = `'${UI_FONT_FAMILY}', 'Geist Variable', 'Geist', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
const STYLE = `
:host { all: initial;
  --ink: #fafafa; --ink-2: #a1a1aa; --ink-3: #6b6b74;
  --accent: #7f70ff; --accent-text: #a49bff; --accent-soft: rgb(127 112 255 / 0.14); --accent-softer: rgb(127 112 255 / 0.07);
  --success: #3fcf96; --danger: #ff7275;
  --glass: rgb(18 18 21 / 0.84);
  --glass-shadow: inset 0 1px 0 rgb(255 255 255 / 0.07), inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 0 0 1px rgb(0 0 0 / 0.55),
    0 2px 6px rgb(0 0 0 / 0.3), 0 18px 44px -12px rgb(0 0 0 / 0.7);
  --tile: linear-gradient(180deg, #26262c 0%, #16161a 100%);
  --tile-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08), inset 0 1px 0 rgb(255 255 255 / 0.1), inset 0 -1px 0 rgb(0 0 0 / 0.4),
    0 1px 2px rgb(0 0 0 / 0.5);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
* { box-sizing: border-box; pointer-events: none; }

/* Target and selection: the editor's hover outline and dashed selection item. */
.box { position: fixed; display: none; border: 1.5px solid var(--accent); background: var(--accent-softer); border-radius: 2px;
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.12), 0 0 18px -4px rgb(127 112 255 / 0.35);
  transition: left 90ms var(--ease-out), top 90ms var(--ease-out), width 90ms var(--ease-out), height 90ms var(--ease-out); }
.box.picked { border-width: 1px; border-style: dashed; background: var(--accent-soft); box-shadow: none; transition: none;
  animation: pick 260ms var(--ease-out); }
.box.capturing { border-style: solid; animation: scan 1.2s ease-in-out infinite; }
@keyframes pick { from { box-shadow: 0 0 0 6px rgb(127 112 255 / 0.22); } }
@keyframes scan { 50% { background: rgb(127 112 255 / 0.24); box-shadow: 0 0 0 4px rgb(127 112 255 / 0.16), 0 0 28px -4px rgb(127 112 255 / 0.5); } }

.label { position: fixed; display: none; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: 6px;
  background: var(--glass); -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
  box-shadow: var(--glass-shadow); color: var(--ink-3); font: 500 11px/1 ${FONT}; font-variant-numeric: tabular-nums;
  white-space: nowrap; max-width: 80vw; overflow: hidden; }
.label b { color: var(--accent-text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }

/* Shortcut bar: one glass capsule, the brand mark, the main action in full ink, the rest quieter. */
.hint { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); display: flex; align-items: center; gap: 12px;
  max-width: calc(100vw - 24px); height: 40px; padding: 0 14px 0 8px; border-radius: 14px; background: var(--glass);
  -webkit-backdrop-filter: blur(18px) saturate(1.5); backdrop-filter: blur(18px) saturate(1.5); box-shadow: var(--glass-shadow);
  color: var(--ink-2); font: 500 12px/1 ${FONT}; letter-spacing: -0.005em; white-space: nowrap; overflow: hidden;
  animation: rise 320ms var(--ease-out) backwards; }
.hint .item { display: inline-flex; align-items: center; gap: 6px; animation: fade 320ms var(--ease-out) backwards; }
.hint .item.main { color: var(--ink); }
.hint .or { color: var(--ink-3); }
.hint .sep { width: 1px; height: 14px; flex: none; background: rgb(255 255 255 / 0.08); }
.hint .keys { display: inline-flex; gap: 3px; }
kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 20px; padding: 0 5px;
  border-radius: 5px; background: var(--tile); box-shadow: var(--tile-shadow); color: #e4e4e7; font: 600 10.5px/1 ${FONT};
  letter-spacing: 0; }
kbd svg { display: block; }
.mark { display: block; width: 24px; height: 24px; flex: none; border-radius: 7px; overflow: hidden;
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.12), 0 1px 2px rgb(0 0 0 / 0.5), 0 4px 12px -4px rgb(127 112 255 / 0.55); }
.mark svg { display: block; width: 100%; height: 100%; }
/* Narrow windows keep the essentials instead of clipping the bar. */
@media (max-width: 900px) { .hint .opt-2 { display: none; } }
@media (max-width: 620px) { .hint .opt-1 { display: none; } }

/* Progress toast. */
.status { position: fixed; left: 50%; top: 18px; display: flex; align-items: center; gap: 10px; min-width: 240px; max-width: min(460px, calc(100vw - 32px));
  padding: 9px 14px 11px 9px; border-radius: 14px; background: var(--glass);
  -webkit-backdrop-filter: blur(18px) saturate(1.5); backdrop-filter: blur(18px) saturate(1.5); box-shadow: var(--glass-shadow);
  color: var(--ink); font: 500 13px/18px ${FONT}; overflow: hidden; transform: translateX(-50%);
  animation: drop 320ms var(--ease-out); }
.status.leaving { opacity: 0; filter: blur(3px); transform: translate(-50%, -6px);
  transition: opacity 200ms ease-out, transform 200ms ease-out, filter 200ms ease-out; }
.status .icon { display: grid; place-items: center; width: 24px; height: 24px; flex: none; border-radius: 7px; background: var(--tile);
  box-shadow: var(--tile-shadow); color: var(--accent-text); transition: color 200ms ease; }
.status .text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status .pct { min-width: 34px; text-align: right; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.status .bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; transform-origin: 0 50%; transform: scaleX(0);
  background: linear-gradient(90deg, rgb(127 112 255 / 0.4), var(--accent)); box-shadow: 0 0 10px rgb(127 112 255 / 0.6);
  border-radius: 0 2px 2px 0; }
.status.done .icon { color: var(--success); }
.status.done .bar { background: var(--success); box-shadow: 0 0 10px rgb(63 207 150 / 0.5); }
.status.error .icon { color: var(--danger); }
.status.error .bar { display: none; }
.cover { position: fixed; left: 0; top: 0; display: block; max-width: none; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes rise { from { opacity: 0; filter: blur(4px); transform: translate(-50%, 10px) scale(0.97); } }
@keyframes drop { from { opacity: 0; filter: blur(4px); transform: translate(-50%, -10px) scale(0.97); } }
@keyframes fade { from { opacity: 0; filter: blur(2px); transform: translateY(3px); } }
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
function svg(doc: Document, paths: string, cls = '', size = 14, weight = 2.25): SVGSVGElement {
  const el = doc.createElementNS(SVG_NS, 'svg');
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', String(weight));
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
  spinner: 'M21 12a9 9 0 1 1-6.2-8.56',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 8v5|M12 16.5h.01|M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
};

/** Symbol keys drawn as icons (font glyphs for these vary a lot between systems); word keys stay text. */
const KEY_ICON: Record<string, string> = {
  '↵': 'M20 4v7a4 4 0 0 1-4 4H4|m9 10-5 5 5 5',
  '⇧': 'M9 18v-6H5l7-7 7 7h-4v6H9z',
  '↑': 'm5 12 7-7 7 7|M12 19V5',
  '↓': 'M12 5v14|m19 12-7 7-7-7',
  '⌘': 'M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3',
  '⌥': 'M3 3h6l6 18h6|M14 3h7',
};

/** Bar items by how much they matter: 0 always shows, 1 and 2 drop out as the window narrows. */
const HINT_PRIORITY = [0, 1, 2, 1, 2, 0];

/** The Markup brand mark (assets/icon.svg). */
function brandMark(doc: Document): SVGSVGElement {
  const el = doc.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', '0 0 1024 1024');
  el.setAttribute('aria-hidden', 'true');
  const shapes: [string, Record<string, string>][] = [
    ['rect', { width: '1024', height: '1024', fill: '#2A17B0' }],
    ['path', { d: 'M583.0,500.3 L686.5,264.8 L821.1,264.8 L764.0,426.6 L844.0,760.0 L719.0,760.0 L674.5,588.6 L595.2,555.2Z', fill: '#B3ACFA', stroke: '#B3ACFA' }],
    ['path', { d: 'M176.7,760.0 L323.2,264.8 L469.7,264.8 L448.2,351.3 L594.8,632.2 L470.3,632.2 L388.4,490.2 L302.7,760.0Z', fill: '#FFFFFF', stroke: '#FFFFFF' }],
  ];
  for (const [tag, attrs] of shapes) {
    const s = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    if (tag === 'path') {
      s.setAttribute('stroke-width', '50.4');
      s.setAttribute('stroke-linejoin', 'round');
    }
    el.appendChild(s);
  }
  return el;
}

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
  mark.append(brandMark(doc));
  bar.append(mark);
  hintItems().forEach((item, i) => {
    const level = HINT_PRIORITY[i] ?? 0;
    const opt = level ? ` opt-${level}` : '';
    if (i) {
      const sep = doc.createElement('span');
      sep.className = `sep${opt}`;
      bar.append(sep);
    }
    const el = doc.createElement('span');
    el.className = `item${i === 0 ? ' main' : ''}${opt}`;
    el.style.animationDelay = `${60 + i * 35}ms`;
    const keys = doc.createElement('span');
    keys.className = 'keys';
    for (const k of item.keys) {
      if (k === 'Click') {
        el.append(doc.createTextNode('Click'));
        if (item.keys.length > 1) {
          const or = doc.createElement('span');
          or.className = 'or';
          or.textContent = 'or';
          el.append(or);
        }
        continue;
      }
      const kbd = doc.createElement('kbd');
      kbd.setAttribute('aria-label', k);
      if (KEY_ICON[k]) kbd.append(svg(doc, KEY_ICON[k], '', 11, 2.5));
      else kbd.textContent = k;
      keys.append(kbd);
    }
    el.append(keys, doc.createTextNode(item.text));
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
  ensureUiFont(doc);
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
