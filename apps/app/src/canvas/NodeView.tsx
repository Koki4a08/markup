import DOMPurify from 'dompurify';
import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { isShorthandStyle, orderStyles, type Styles } from '@markup/doc';
import { useDoc } from '../store/DocProvider';
import { useNode } from '../store/hooks';
import { finishReveal, scheduleReveal, shouldDefer } from './deferred';
import { allowSmil, SMIL_ATTRS, SMIL_TAGS } from './smil';
import { registerNodeElement } from './registry';

/** Properties whose bare numbers are unitless in CSS; everything else gets px. */
const UNITLESS = new Set(['opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight', 'order', 'zoom', 'aspectRatio']);

export function toCss(styles: Styles): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(orderStyles(styles))) out[k] = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v);
  return out as CSSProperties;
}

const TEXT_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'a', 'br', 'span', 'code', 'sup', 'sub', 'small', 'mark'];

/**
 * Text without a '<' has no markup to strip: it renders the same as DOMPurify's serialization of it, and
 * skipping the sanitizer (which parses a whole document per call) keeps opening text-heavy files fast.
 */
export const sanitizeText = (html: string) => (html.includes('<') ? DOMPurify.sanitize(html, { ALLOWED_TAGS: TEXT_TAGS, ALLOWED_ATTR: ['style', 'href'] }) : html);

// Its own instance (the SMIL check must not run on text sanitising), made on first use: this module also loads
// where there is no window.
let svgPurifier: ReturnType<typeof DOMPurify> | null = null;
const purifierForSvg = () => {
  if (!svgPurifier) {
    svgPurifier = DOMPurify(window);
    allowSmil(svgPurifier);
  }
  return svgPurifier;
};

export const sanitizeSvg = (svg: string) => purifierForSvg().sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: SMIL_TAGS, ADD_ATTR: SMIL_ATTRS });

/** Renders one document node as real DOM, recursively. */
export const NodeView = memo(function NodeView({ id }: { id: string }) {
  const node = useNode(id);
  // Registers the rendered element so canvas measuring finds it without a DOM-wide query.
  const elRef = useRef<HTMLElement | null>(null);
  const ref = useCallback(
    (el: HTMLElement | null) => {
      elRef.current = el;
      return el ? registerNodeElement(id, el) : undefined;
    },
    [id],
  );
  // Children present at the first render mount with this node (its own gate covers them); one added later
  // (a paste, an agent's write) mounts deferred when it is heavy.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const styles = node?.styles;
  const hidden = node?.hidden;
  // React updates only the properties that changed, and a changed shorthand resets its longhands in the browser
  // (a new background clears an unchanged backgroundColor): those are put back after the update.
  const prevStyles = useRef(styles);
  useLayoutEffect(() => {
    const prev = prevStyles.current;
    prevStyles.current = styles;
    if (!styles || !prev || prev === styles) return;
    if (!Object.keys(styles).some((k) => isShorthandStyle(k) && styles[k] !== prev[k])) return;
    const el = elRef.current;
    if (!el) return;
    const css = toCss(styles) as Record<string, string>;
    const inline = el.style as unknown as Record<string, string>;
    for (const [k, v] of Object.entries(css)) if (!isShorthandStyle(k) && !(k === 'display' && hidden)) inline[k] = v;
  }, [styles, hidden]);
  if (!node || node.type === 'root') return null;
  const style = toCss(node.styles);
  if (node.hidden) style.display = 'none';
  const common = { 'data-node-id': id, style, ref };
  switch (node.type) {
    case 'text':
      // Markup's dialect has no margins, so the browser's default paragraph margin must not apply either.
      return <p {...common} style={{ margin: 0, ...style }} dangerouslySetInnerHTML={{ __html: sanitizeText(node.text ?? '') }} />;
    case 'image':
      return <img {...common} src={node.src ?? ''} alt={node.name} draggable={false} />;
    case 'svg':
      // A sized layer scales its drawing to the box, so W/H in the inspector (and resize handles) resize the vector.
      return <div {...common} data-svg-fit={node.styles.width !== undefined || node.styles.height !== undefined ? '' : undefined} dangerouslySetInnerHTML={{ __html: sanitizeSvg(node.svg ?? '') }} />;
    default:
      return (
        <div {...common}>
          {node.children.map((child) => (
            <DeferredNodeView key={child} id={child} defer={mounted.current} />
          ))}
        </div>
      );
  }
});

/** Layout styles a placeholder keeps, so the shimmer takes the place and size the layer will. */
const PLACEHOLDER_KEYS = [
  'position', 'left', 'top', 'right', 'bottom', 'inset', 'zIndex', 'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
  'aspectRatio', 'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf', 'justifySelf', 'gridColumn', 'gridRow', 'gridArea', 'order',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'borderRadius', 'transform', 'translate', 'rotate', 'scale',
] as const;

/** Shown in place of a heavy layer until it mounts; a layer without a fixed height gets a stand-in one. */
function LayerPlaceholder({ styles }: { styles: Styles }) {
  const css = toCss(styles) as Record<string, unknown>;
  const style: Record<string, unknown> = {};
  for (const k of PLACEHOLDER_KEYS) if (css[k] !== undefined) style[k] = css[k];
  if (!css.height || css.height === 'auto' || String(css.height).includes('content')) style.minHeight ??= 240;
  if (!css.width || css.width === 'auto' || String(css.width).includes('content')) style.minWidth ??= 240;
  return <div className="layer-placeholder" style={style as CSSProperties} aria-busy="true" aria-label="Loading layer" />;
}

/**
 * NodeView, or for a heavy subtree a shimmer placeholder first: the real layers mount in a queued transition
 * (see deferred.ts), so a big artboard or paste never blocks the window in one long commit.
 */
export const DeferredNodeView = memo(function DeferredNodeView({ id, defer = true }: { id: string; defer?: boolean }) {
  const { doc } = useDoc();
  const [ready, setReady] = useState(() => !defer || !shouldDefer(doc, id));
  useEffect(() => {
    if (ready) return;
    const job = scheduleReveal(() => startTransition(() => setReady(true)));
    return () => finishReveal(job);
  }, [ready]);
  if (ready) return <NodeView id={id} />;
  const node = doc.getNode(id);
  return node ? <LayerPlaceholder styles={node.styles} /> : null;
});
