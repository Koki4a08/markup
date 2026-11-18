import { parseFragment, serialize, serializeOuter, type DefaultTreeAdapterMap } from 'parse5';
import type { NodeSpec, NodeType, Styles } from './schema';
import { normalizeStyles, parseStyleAttr, type Dialect } from './styles';

type P5Node = DefaultTreeAdapterMap['childNode'];
type P5Element = DefaultTreeAdapterMap['element'];
type P5Parent = DefaultTreeAdapterMap['parentNode'];

/** Inline formatting tags kept inside a Text node's HTML. */
const INLINE = new Set(['span', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'br', 'code', 'sup', 'sub', 'small', 'mark']);
/** Elements that become one Text node when everything inside them is inline. */
const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'span', 'label', 'a', 'li', 'blockquote', 'pre', 'code', 'small', 'strong', 'b', 'em', 'i']);

const isElement = (n: P5Node): n is P5Element => 'tagName' in n;
const isText = (n: P5Node): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text';
const attr = (el: P5Element, name: string) => el.attrs.find((a) => a.name === name)?.value;

function isInlineOnly(el: P5Parent): boolean {
  return el.childNodes.every((c) => isText(c) || (isElement(c) && INLINE.has(c.tagName) && isInlineOnly(c)) || c.nodeName === '#comment');
}

/**
 * HTML → node specs. In the `any` dialect styles are kept as written and a text node keeps the whitespace at its
 * edges (exact snapshots lay text out in inline flow, where those spaces separate words across nodes).
 */
export function parseHtml(html: string, opts: { dialect?: Dialect } = {}): { specs: NodeSpec[]; ignored: string[] } {
  const dialect = opts.dialect ?? 'strict';
  const edge = (s: string) => (dialect === 'any' ? s : s.trim());
  const ignored = new Set<string>();
  const fragment = parseFragment(html);

  const stylesFor = (el: P5Element, type: NodeType): Styles | undefined => {
    const raw = attr(el, 'style');
    if (!raw) return undefined;
    const { styles, ignored: dropped } = normalizeStyles(parseStyleAttr(raw), { type, isArtboard: false }, dialect);
    dropped.forEach((k) => ignored.add(k));
    return styles as Styles;
  };

  const withName = (spec: NodeSpec, el: P5Element): NodeSpec => {
    const name = attr(el, 'layer-name');
    if (name) spec.name = name;
    return spec;
  };

  const textSpec = (htmlText: string): NodeSpec | null => (htmlText.trim() ? { type: 'text', text: htmlText.trim() } : null);

  /** Converts children of a frame: runs of text and inline elements merge into one Text node. */
  const convertChildren = (parent: P5Parent): NodeSpec[] => {
    const out: NodeSpec[] = [];
    let run: P5Node[] = [];
    const flushRun = () => {
      if (run.length === 0) return;
      const holder = { nodeName: '#document-fragment', childNodes: run } as unknown as DefaultTreeAdapterMap['documentFragment'];
      const spec = textSpec(serialize(holder));
      if (spec) out.push(spec);
      run = [];
    };
    for (const child of parent.childNodes) {
      if (isText(child) || (isElement(child) && INLINE.has(child.tagName) && child.tagName !== 'span' && isInlineOnly(child))) {
        run.push(child);
        continue;
      }
      flushRun();
      if (isElement(child)) out.push(convertElement(child));
    }
    flushRun();
    return out;
  };

  const convertElement = (el: P5Element): NodeSpec => {
    const tag = el.tagName;
    if (tag === 'x-markup-clone') {
      const nodeId = attr(el, 'node-id') ?? '';
      const styles = stylesFor(el, 'frame');
      return withName({ type: 'frame', cloneOf: styles ? { nodeId, styles } : { nodeId } }, el);
    }
    if (tag === 'img') {
      const spec: NodeSpec = { type: 'image', src: attr(el, 'src') ?? '' };
      const styles = stylesFor(el, 'image');
      if (styles) spec.styles = styles;
      return withName(spec, el);
    }
    if (tag === 'svg') {
      const spec: NodeSpec = { type: 'svg', svg: serializeOuter(el) };
      const styles = stylesFor(el, 'svg');
      if (styles) spec.styles = styles;
      return withName(spec, el);
    }
    if (TEXT_TAGS.has(tag) && isInlineOnly(el)) {
      const spec: NodeSpec = { type: 'text', text: edge(serialize(el)) };
      const styles = stylesFor(el, 'text');
      if (styles) spec.styles = styles;
      return withName(spec, el);
    }
    const spec: NodeSpec = { type: 'frame', children: convertChildren(el) };
    const styles = stylesFor(el, 'frame');
    if (styles) spec.styles = styles;
    return withName(spec, el);
  };

  return { specs: convertChildren(fragment), ignored: [...ignored] };
}
