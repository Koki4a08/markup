import { get, type Decl } from './styles';

/** What visibleShape needs: computed style and a rect (any one coordinate space, used consistently). */
export interface ShapeEnv {
  style(el: Element): CSSStyleDeclaration;
  rect(el: Element): DOMRect;
}

/** Corner radii, top-left, top-right, bottom-right, bottom-left, as px strings. */
export type Radii = [string, string, string, string];

export interface Shape {
  /** The part of the element the page actually shows. */
  rect: DOMRect;
  radii: Radii;
  /** True when an ancestor cuts the element (an edge or a rounded corner). */
  clipped: boolean;
}

const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const;
const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const EPS = 1;

const num = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** Horizontal radius of a computed corner value ("6px", "6px 4px", "50%") in px. */
function radiusPx(value: string, width: number): number {
  const first = value.trim().split(/\s+/)[0] ?? '0';
  return first.endsWith('%') ? (num(first) / 100) * width : num(first);
}

function borders(cs: CSSStyleDeclaration): Record<(typeof SIDES)[number], number> {
  const out = { top: 0, right: 0, bottom: 0, left: 0 };
  for (const s of SIDES) {
    const style = get(cs, `border-${s}-style`);
    if (style && style !== 'none' && style !== 'hidden') out[s] = num(get(cs, `border-${s}-width`));
  }
  return out;
}

const clips = (cs: CSSStyleDeclaration) => ['overflow-x', 'overflow-y'].some((p) => /^(hidden|clip|auto|scroll)$/.test(get(cs, p)));

const intersect = (a: DOMRect, b: DOMRect) => {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return new DOMRect(x, y, Math.max(0, Math.min(a.right, b.right) - x), Math.max(0, Math.min(a.bottom, b.bottom) - y));
};

const near = (a: number, b: number) => Math.abs(a - b) <= EPS;
const pxs = (n: number) => `${Math.round(n * 100) / 100}px`;

/**
 * The shape of an element as the page paints it: its own rounded corners, cut by every ancestor that clips
 * (overflow hidden/auto/scroll). Where the element fills a clipping ancestor's corner, that ancestor's inner radius
 * rounds it — the usual "table inside a rounded box" case.
 */
export function visibleShape(el: Element, env: ShapeEnv): Shape {
  const own = env.style(el);
  const base = env.rect(el);
  const radii = CORNERS.map((c) => radiusPx(get(own, `border-${c}-radius`), base.width));
  let rect = base;
  let clipped = false;
  for (let anc = el.parentElement; anc; anc = anc.parentElement) {
    const cs = env.style(anc);
    if (!clips(cs)) continue;
    const r = env.rect(anc);
    const b = borders(cs);
    const pad = new DOMRect(r.x + b.left, r.y + b.top, Math.max(0, r.width - b.left - b.right), Math.max(0, r.height - b.top - b.bottom));
    const next = intersect(rect, pad);
    if (!near(next.x, rect.x) || !near(next.y, rect.y) || !near(next.right, rect.right) || !near(next.bottom, rect.bottom)) clipped = true;
    rect = next;
    // Inner radius of the clip = outer radius minus the adjoining border (the padding box is what clips).
    const inner = [
      Math.max(0, radiusPx(get(cs, 'border-top-left-radius'), r.width) - Math.max(b.top, b.left)),
      Math.max(0, radiusPx(get(cs, 'border-top-right-radius'), r.width) - Math.max(b.top, b.right)),
      Math.max(0, radiusPx(get(cs, 'border-bottom-right-radius'), r.width) - Math.max(b.bottom, b.right)),
      Math.max(0, radiusPx(get(cs, 'border-bottom-left-radius'), r.width) - Math.max(b.bottom, b.left)),
    ];
    const touches = [
      near(rect.x, pad.x) && near(rect.y, pad.y),
      near(rect.right, pad.right) && near(rect.y, pad.y),
      near(rect.right, pad.right) && near(rect.bottom, pad.bottom),
      near(rect.x, pad.x) && near(rect.bottom, pad.bottom),
    ];
    touches.forEach((t, i) => {
      if (t && inner[i]! > radii[i]!) {
        radii[i] = inner[i]!;
        clipped = true;
      }
    });
  }
  return { rect, radii: radii.map(pxs) as Radii, clipped };
}

/** A clip-path that cuts the snapshot root the way the page cuts the (single) target; empty when nothing cuts it. */
export function rootClip(target: Element, env: ShapeEnv): Decl[] {
  const shape = visibleShape(target, env);
  if (!shape.clipped) return [];
  const r = env.rect(target);
  const insets = [shape.rect.y - r.y, r.right - shape.rect.right, r.bottom - shape.rect.bottom, shape.rect.x - r.x].map((n) => pxs(Math.max(0, n)));
  return [['clip-path', `inset(${insets.join(' ')} round ${shape.radii.join(' ')})`]];
}
