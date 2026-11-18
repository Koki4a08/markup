import DOMPurify from 'dompurify';
import { memo, type CSSProperties } from 'react';
import type { Styles } from '@markup/doc';
import { useNode } from '../store/hooks';

/** Properties whose bare numbers are unitless in CSS; everything else gets px. */
const UNITLESS = new Set(['opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight', 'order', 'zoom', 'aspectRatio']);

export function toCss(styles: Styles): CSSProperties {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(styles)) out[k] = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v);
  return out as CSSProperties;
}

const TEXT_TAGS = ['b', 'strong', 'i', 'em', 'u', 's', 'a', 'br', 'span', 'code', 'sup', 'sub', 'small', 'mark'];

export const sanitizeText = (html: string) => DOMPurify.sanitize(html, { ALLOWED_TAGS: TEXT_TAGS, ALLOWED_ATTR: ['style', 'href'] });

export const sanitizeSvg = (svg: string) => DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });

/** Renders one document node as real DOM, recursively. */
export const NodeView = memo(function NodeView({ id }: { id: string }) {
  const node = useNode(id);
  if (!node || node.type === 'root') return null;
  const style = toCss(node.styles);
  if (node.hidden) style.display = 'none';
  const common = { 'data-node-id': id, style };
  switch (node.type) {
    case 'text':
      return <p {...common} dangerouslySetInnerHTML={{ __html: sanitizeText(node.text ?? '') }} />;
    case 'image':
      return <img {...common} src={node.src ?? ''} alt={node.name} draggable={false} />;
    case 'svg':
      return <div {...common} dangerouslySetInnerHTML={{ __html: sanitizeSvg(node.svg ?? '') }} />;
    default:
      return (
        <div {...common}>
          {node.children.map((child) => (
            <NodeView key={child} id={child} />
          ))}
        </div>
      );
  }
});
