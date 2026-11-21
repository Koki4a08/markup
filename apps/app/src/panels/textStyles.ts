import type { MarkupDoc, MarkupNode, StyleValue } from '@markup/doc';

/**
 * Text-layer edits from the inspector apply to the whole layer, like a design tool's text properties: the
 * same property written on inline runs inside the text (a captured page's `<span style="color: …">`) and a
 * `-webkit-text-fill-color` the layer inherits (exact snapshots carry one) would otherwise win over it.
 */

/** Inline CSS properties a layer-level text style replaces inside the text's own markup. */
const INLINE_PROPS: Record<string, string[]> = {
  color: ['color', '-webkit-text-fill-color'],
  fontFamily: ['font-family'],
  fontSize: ['font-size'],
  fontWeight: ['font-weight'],
  fontStyle: ['font-style'],
  lineHeight: ['line-height'],
  letterSpacing: ['letter-spacing'],
};

const FILL_KEYS = ['WebkitTextFillColor', 'webkitTextFillColor'] as const;
const fillOf = (n: MarkupNode): StyleValue | undefined => FILL_KEYS.map((k) => n.styles[k]).find((v) => v !== undefined);

/**
 * What the node's text fill must become so its `color` shows: 'currentcolor' when the nearest declared fill
 * (its own or an ancestor's) paints a fixed colour, undefined when nothing does or it is gradient text
 * (a transparent fill over a clipped background, which a colour change must not undo).
 */
export function fillOverride(doc: MarkupDoc, node: MarkupNode): StyleValue | undefined {
  for (let cur: MarkupNode | undefined = node; cur; cur = cur.parentId ? doc.getNode(cur.parentId) : undefined) {
    const fill = fillOf(cur);
    if (fill === undefined) continue;
    const v = String(fill).trim().toLowerCase();
    return v === 'transparent' || v === 'currentcolor' ? undefined : 'currentcolor';
  }
  return undefined;
}

/** The node's styles for one layer-level text edit, with the fill fix a colour change needs. */
export function textStyles(doc: MarkupDoc, node: MarkupNode, styles: Record<string, StyleValue | null>): Record<string, StyleValue | null> {
  if (!('color' in styles) || styles.color === null) return styles;
  const fill = fillOverride(doc, node);
  if (fill === undefined) return styles;
  // Clear the other spelling so only one fill declaration is stored.
  return { ...styles, WebkitTextFillColor: fill, webkitTextFillColor: null };
}

/** The text's HTML without the given inline properties; null when nothing changed. */
export function stripInline(html: string, keys: string[]): string | null {
  const props = keys.flatMap((k) => INLINE_PROPS[k] ?? []);
  if (!props.length || !html.includes('style')) return null;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  let changed = false;
  for (const el of tpl.content.querySelectorAll<HTMLElement>('[style]')) {
    for (const p of props) {
      if (el.style.getPropertyValue(p)) {
        el.style.removeProperty(p);
        changed = true;
      }
    }
    if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
  }
  return changed ? tpl.innerHTML : null;
}

/** Font weight as the inspector's options spell it ('bold' → '700'). */
export function weightValue(v: StyleValue | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  return s === 'normal' ? '400' : s === 'bold' ? '700' : s;
}
