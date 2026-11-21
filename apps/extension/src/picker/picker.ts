import { Overlay } from './overlay';

export type CaptureTargets = Element[] | 'page';
/** `exact` keeps the page's structure and CSS; `simplified` re-derives it into Markup's flex/absolute dialect. */
export type CaptureMode = 'exact' | 'simplified';

const SWALLOWED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'contextmenu'] as const;

export class Picker {
  target: Element | null = null;
  selected: Element[] = [];
  private overlay: Overlay | null = null;
  /** Elements we climbed from with ArrowUp, so ArrowDown can retrace. */
  private path: Element[] = [];
  private readonly win: Window;

  constructor(
    private readonly doc: Document,
    /** Called with no mode for the default (exact) capture, and with 'simplified' when Alt was held. */
    private readonly onCapture: (targets: CaptureTargets, mode?: CaptureMode) => void,
  ) {
    this.win = doc.defaultView!;
  }

  /** Called whenever the picker stops (Escape, toggle, or after a capture). */
  onStop: (() => void) | null = null;

  get active(): boolean {
    return this.overlay !== null;
  }

  start(): void {
    if (this.overlay) return;
    this.overlay = new Overlay(this.doc);
    this.win.addEventListener('mousemove', this.onMove, true);
    this.win.addEventListener('keydown', this.onKey, true);
    this.win.addEventListener('click', this.onClick, true);
    this.win.addEventListener('scroll', this.refresh, true);
    this.win.addEventListener('resize', this.refresh, true);
    for (const t of SWALLOWED) this.win.addEventListener(t, this.swallow, true);
  }

  stop(): void {
    if (!this.overlay) return;
    this.win.removeEventListener('mousemove', this.onMove, true);
    this.win.removeEventListener('keydown', this.onKey, true);
    this.win.removeEventListener('click', this.onClick, true);
    this.win.removeEventListener('scroll', this.refresh, true);
    this.win.removeEventListener('resize', this.refresh, true);
    for (const t of SWALLOWED) this.win.removeEventListener(t, this.swallow, true);
    this.overlay.destroy();
    this.overlay = null;
    this.onStop?.();
    this.target = null;
    this.selected = [];
    this.path = [];
  }

  toast(message: string, error = false): void {
    this.overlay?.toast(message, error);
  }

  /** Hides the picker chrome while a capture works in the background (and shows it again). */
  setChromeVisible(visible: boolean): void {
    this.overlay?.setVisible(visible);
  }

  /** Back to picking after a capture failed: the copied outlines stop pulsing. */
  idle(): void {
    this.overlay?.setVisible(true);
    this.overlay?.showSelected(this.selected);
    this.overlay?.highlight(this.target);
  }

  private refresh = (): void => {
    this.overlay?.highlight(this.target);
    this.overlay?.showSelected(this.selected);
  };

  private setTarget(el: Element | null): void {
    this.target = el;
    this.overlay?.highlight(el);
  }

  private resolve(e: MouseEvent): Element | null {
    const own = this.overlay!.host;
    let el = e.target instanceof Element ? e.target : null;
    if (!el || el === own || own.contains(el)) {
      const stack = this.doc.elementsFromPoint?.(e.clientX, e.clientY) ?? [];
      el = stack.find((x) => x !== own && !own.contains(x)) ?? null;
    }
    if (el === this.doc.documentElement) el = this.doc.body;
    return el;
  }

  private onMove = (e: MouseEvent): void => {
    const el = this.resolve(e);
    if (!el || el === this.target) return;
    this.path = [];
    this.setTarget(el);
  };

  private onKey = (e: KeyboardEvent): void => {
    switch (e.key) {
      case 'ArrowUp': {
        this.eat(e);
        const t = this.target;
        const parent = t?.parentElement;
        if (t && t !== this.doc.body && parent) {
          this.path.push(t);
          this.setTarget(parent === this.doc.documentElement ? this.doc.body : parent);
        }
        return;
      }
      case 'ArrowDown': {
        this.eat(e);
        const next = this.path.pop() ?? this.target?.firstElementChild ?? null;
        if (next) this.setTarget(next);
        return;
      }
      case 'Enter':
        this.eat(e);
        if (e.ctrlKey || e.metaKey) this.emit('page', e.altKey);
        else this.capture(e.altKey);
        return;
      case 'Escape':
        this.eat(e);
        this.stop();
        return;
    }
  };

  private onClick = (e: MouseEvent): void => {
    this.eat(e);
    const el = this.resolve(e);
    if (!el) return;
    if (el !== this.target) {
      this.path = [];
      this.setTarget(el);
    }
    if (e.shiftKey) {
      this.selected = this.selected.includes(el) ? this.selected.filter((x) => x !== el) : [...this.selected, el];
      this.overlay?.showSelected(this.selected);
    } else {
      this.capture(e.altKey);
    }
  };

  private emit(targets: CaptureTargets, simplified: boolean): void {
    if (targets !== 'page') this.overlay?.showCapturing(targets);
    if (simplified) this.onCapture(targets, 'simplified');
    else this.onCapture(targets);
  }

  private capture(simplified = false): void {
    const targets = [...this.selected];
    if (this.target && !targets.includes(this.target)) targets.push(this.target);
    if (targets.length === 0) return;
    this.selected = [];
    this.overlay?.showSelected([]);
    this.emit(targets, simplified);
  }

  private swallow = (e: Event): void => this.eat(e);

  private eat(e: Event): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}
