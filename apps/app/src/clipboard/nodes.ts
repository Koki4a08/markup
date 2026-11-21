import { fontFaces, keyframeRules, type MarkupDoc, type MarkupNode, type Styles } from '@markup/doc';
import { toCss } from '../canvas/NodeView';

/** Leads the clipboard HTML of layers copied in Markup; the root div's data-markup-nodes attribute survives sanitisers that drop it. */
export const NODES_MARKER = '<!--markup:nodes v1-->';
export const NODES_ATTR = 'data-markup-nodes';
/** The same attributes a page snapshot uses (paste.ts): the file's web fonts and motion rules the layers need. */
const FONTS_ATTR = 'data-markup-fonts';
const KEYFRAMES_ATTR = 'data-markup-keyframes';
const SVG_NS = 'http://www.w3.org/2000/svg';
/** On the root when the copy ends with an added "SVG effects" layer (the same file already has its definitions). */
export const DEFS_ATTR = 'data-markup-defs';

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

/** Every node on every page, depth first. */
function* allNodes(doc: MarkupDoc): Generator<MarkupNode> {
  for (const page of doc.pages()) {
    if (page.type !== 'page') continue;
    const stack = [page.rootId];
    while (stack.length) {
      const node = doc.getNode(stack.pop()!);
      if (!node) continue;
      yield node;
      stack.push(...node.children);
    }
  }
}

/**
 * SVG filters and clip paths the copied layers point at (url(#id)) but do not hold themselves (a snapshot keeps
 * them in its hidden "SVG effects" layer): copied into a hidden layer of their own, so they work in another file.
 */
function definitionsLayer(doc: MarkupDoc, html: string): string {
  const wanted = new Set([...html.matchAll(/url\(\s*(?:['"]|&quot;)?#([\w-]+)/g)].map((m) => m[1]!).filter((id) => !html.includes(`id="${id}"`)));
  if (!wanted.size) return '';
  const found = new Map<string, string>();
  for (const node of allNodes(doc)) {
    if (node.type !== 'svg' || !node.svg || ![...wanted].some((id) => node.svg!.includes(`id="${id}"`))) continue;
    const holder = new DOMParser().parseFromString(`<body>${node.svg}</body>`, 'text/html').body;
    for (const id of wanted) {
      const def = holder.querySelector(`[id="${CSS.escape(id)}"]`);
      if (def && !found.has(id)) found.set(id, def.outerHTML);
    }
    if (found.size === wanted.size) break;
  }
  if (!found.size) return '';
  return `<svg xmlns="${SVG_NS}" width="0" height="0" aria-hidden="true" layer-name="SVG effects" style="position:absolute;left:0px;top:0px;width:0px;height:0px;overflow:hidden;pointer-events:none"><defs>${[...found.values()].join('')}</defs></svg>`;
}

const familyOf = (face: string) => /font-family\s*:\s*(["']?)([^;"'}]+)\1/i.exec(face)?.[2]?.trim().toLowerCase() ?? '';
const ruleName = (rule: string) => /^@(?:keyframes|property)\s+([\w-]+)/.exec(rule)?.[1] ?? '';

/**
 * The clipboard HTML of a Markup copy: the marker, then a root div naming the source file and the permissive
 * dialect, carrying the embedded fonts and motion rules (@keyframes, @property) the layers use, so they look and
 * move the same when pasted into another file.
 */
export function nodesPayload(doc: MarkupDoc, ids: string[]): string {
  const html = nodesToHtml(doc, ids);
  const lower = html.toLowerCase();
  const fonts = fontFaces(doc).filter((face) => {
    const family = familyOf(face);
    return !!family && lower.includes(family);
  });
  const motion = keyframeRules(doc).filter((rule) => {
    const name = ruleName(rule);
    return !!name && html.includes(name);
  });
  const defs = definitionsLayer(doc, html);
  const extra = `${fonts.length ? ` ${FONTS_ATTR}="${escapeAttr(fonts.join('\n'))}"` : ''}${motion.length ? ` ${KEYFRAMES_ATTR}="${escapeAttr(motion.join('\n'))}"` : ''}${defs ? ` ${DEFS_ATTR}="1"` : ''}`;
  return `${NODES_MARKER}<div ${NODES_ATTR}="v1" data-markup-dialect="any" data-source-file="${escapeAttr(doc.fileId)}"${extra}>${html}${defs}</div>`;
}
