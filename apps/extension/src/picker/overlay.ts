const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; pointer-events: none; }
.box { position: fixed; display: none; border: 2px solid #2563eb; background: rgba(37, 99, 235, 0.12); border-radius: 2px; }
.box.picked { background: rgba(37, 99, 235, 0.22); border-style: dashed; }
.label { position: fixed; display: none; padding: 3px 8px; border-radius: 6px; background: #111827; color: #f9fafb;
  font: 600 11px/16px system-ui, -apple-system, 'Segoe UI', sans-serif; white-space: nowrap; max-width: 80vw; overflow: hidden; text-overflow: ellipsis; }
.hint { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); padding: 7px 14px; border-radius: 999px;
  background: #111827; color: #e5e7eb; font: 500 12px/16px system-ui, -apple-system, 'Segoe UI', sans-serif; white-space: nowrap; }
.toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); display: none; padding: 8px 16px; border-radius: 8px;
  background: #2563eb; color: #fff; font: 600 13px/18px system-ui, -apple-system, 'Segoe UI', sans-serif; }
.toast.error { background: #b91c1c; }
`;

export const HINT = '↑↓ adjust · Enter capture · ⌘Enter page · Esc exit';

export class Overlay {
  readonly host: HTMLElement;
  private readonly box: HTMLElement;
  private readonly label: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly picked: HTMLElement[] = [];
  private readonly root: ShadowRoot;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly doc: Document) {
    [this.host, this.root] = shadowHost(doc);
    this.box = this.div('box');
    this.label = this.div('label');
    const hint = this.div('hint');
    hint.textContent = HINT;
    this.toastEl = this.div('toast');
    this.root.append(this.box, this.label, hint, this.toastEl);
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
    place(this.box, r);
    this.label.textContent = describe(target, r);
    this.label.style.display = 'block';
    this.label.style.left = `${Math.max(0, r.left)}px`;
    this.label.style.top = `${r.top > 26 ? r.top - 24 : r.bottom + 4}px`;
  }

  showSelected(elements: Element[]): void {
    while (this.picked.length > elements.length) this.picked.pop()!.remove();
    while (this.picked.length < elements.length) {
      const d = this.div('box picked');
      this.root.appendChild(d);
      this.picked.push(d);
    }
    elements.forEach((el, i) => place(this.picked[i]!, el.getBoundingClientRect()));
  }

  toast(message: string, error = false): void {
    clearTimeout(this.toastTimer);
    this.toastEl.textContent = message;
    this.toastEl.className = error ? 'toast error' : 'toast';
    this.toastEl.style.display = 'block';
    this.toastTimer = setTimeout(() => (this.toastEl.style.display = 'none'), 2500);
  }

  destroy(): void {
    clearTimeout(this.toastTimer);
    this.host.remove();
  }
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
  const [host, root] = shadowHost(doc);
  const toast = doc.createElement('div');
  toast.className = error ? 'toast error' : 'toast';
  toast.style.display = 'block';
  toast.textContent = message;
  root.append(toast);
  doc.documentElement.appendChild(host);
  setTimeout(() => host.remove(), 2500);
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
