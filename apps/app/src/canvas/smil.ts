import type { DOMPurify } from 'dompurify';

/**
 * SVG's own animation elements (SMIL: <animate>, <set>, <animateTransform>, <animateMotion>), so pasted icons,
 * loaders and illustrations keep moving. DOMPurify leaves <animate> and <set> out by default because they can
 * rewrite another attribute (an href to javascript:); here they are kept only while they animate presentation or
 * geometry, with values that load nothing.
 */
export const SMIL_TAGS = ['animate', 'set', 'animateTransform', 'animateMotion', 'mpath'];
/** Timing and value attributes DOMPurify does not know. */
export const SMIL_ATTRS = ['from', 'to', 'calcMode'];

const SMIL = new Set(SMIL_TAGS.map((t) => t.toLowerCase()));
/** What an animation element may change: how things look and where they are, never a link or a handler. */
const ANIMATABLE = new Set([
  'opacity', 'fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'transform', 'gradientTransform', 'patternTransform', 'd', 'points',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'width', 'height', 'offset', 'stop-color',
  'stop-opacity', 'visibility', 'display', 'viewBox', 'stdDeviation', 'baseFrequency', 'numOctaves', 'seed', 'scale', 'dx', 'dy',
  'rotate', 'startOffset', 'color', 'flood-color', 'flood-opacity', 'lighting-color', 'font-size', 'letter-spacing',
  'values', 'k1', 'k2', 'k3', 'k4', 'radius', 'amplitude', 'exponent', 'intercept', 'slope', 'tableValues', 'pathLength',
]);
const VALUE_ATTRS = ['from', 'to', 'by', 'values'];
/** A value that loads or runs something; a url(#id) paint reference is fine. */
const UNSAFE_VALUE = /javascript:|vbscript:|data:|<|url\(\s*['"]?(?!#)/i;

/** Installs the check on a DOMPurify instance; pass SMIL_TAGS / SMIL_ATTRS as ADD_TAGS / ADD_ATTR when sanitizing. */
export function allowSmil(purifier: DOMPurify): void {
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (!el.localName || !SMIL.has(el.localName.toLowerCase())) return;
    const tag = el.localName.toLowerCase();
    const href = el.getAttribute('href') ?? el.getAttribute('xlink:href');
    const target = tag === 'animatemotion' || tag === 'mpath' || ANIMATABLE.has(el.getAttribute('attributeName') ?? '');
    const values = VALUE_ATTRS.every((a) => !UNSAFE_VALUE.test(el.getAttribute(a) ?? ''));
    if (target && values && (!href || href.startsWith('#'))) return;
    el.parentNode?.removeChild(el);
  });
}
