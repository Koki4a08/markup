import type { MarkupDoc, MarkupNode, Styles } from '@markup/doc';
import { toCss } from '../canvas/NodeView';

/** Leads the clipboard HTML of layers copied in Markup; the root div's data-markup-nodes attribute survives sanitisers that drop it. */
export const NODES_MARKER = '<!--markup:nodes v1-->';
export const NODES_ATTR = 'data-markup-nodes';

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kebab = (key: string) => (key.startsWith('--') ? key : key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/^ms-/, '-ms-'));

/** Inline style text, camelCase keys converted, bare numbers given px where CSS needs a unit. */
export function styleAttr(styles: Styles): string {
  const css = toCss(styles) as Record<string, string>;
  return Object.entries(css)
    .map(([k, v]) => `${kebab(k)}: ${v}`)
    .join('; ');
}

const nameAttr = (node: MarkupNode) => (node.name ? ` layer-name="${escapeAttr(node.name)}"` : '');
const styleOf = (node: MarkupNode) => {
  const style = styleAttr(node.styles);
  return style ? ` style="${escapeAttr(style)}"` : '';
};

function nodeHtml(doc: MarkupDoc, node: MarkupNode): string {
  switch (node.type) {
    case 'text':
      return `<p${nameAttr(node)}${styleOf(node)}>${node.text ?? ''}</p>`;
    case 'image':
      return `<img${nameAttr(node)} src="${escapeAttr(node.src ?? '')}"${styleOf(node)}>`;
    case 'svg': {
      const svg = (node.svg ?? '').trim();
      // The layer's own styles and name go on the root <svg>, where the HTML import reads them back.
      const extra = `${/^<svg\b[^>]*\sstyle=/i.test(svg) ? '' : styleOf(node)}${nameAttr(node)}`;
      return /^<svg\b/i.test(svg) ? svg.replace(/^<svg\b/i, `<svg${extra}`) : svg;
    }
    case 'frame':
      return `<div${nameAttr(node)}${styleOf(node)}>${node.children.map((id) => nodeHtml(doc, doc.requireNode(id))).join('')}</div>`;
    default:
      return '';
  }
}

/** The nodes as HTML in Markup's own vocabulary: frames as divs with inline styles, text as p, images as img, svgs as their markup. */
export function nodesToHtml(doc: MarkupDoc, ids: string[]): string {
  return ids
    .map((id) => doc.getNode(id))
    .filter((n): n is MarkupNode => !!n && n.type !== 'root')
    .map((n) => nodeHtml(doc, n))
    .join('');
}

/** The clipboard HTML of a Markup copy: the marker, then a root div naming the source file and the permissive dialect. */
export function nodesPayload(doc: MarkupDoc, ids: string[]): string {
  return `${NODES_MARKER}<div ${NODES_ATTR}="v1" data-markup-dialect="any" data-source-file="${escapeAttr(doc.fileId)}">${nodesToHtml(doc, ids)}</div>`;
}
