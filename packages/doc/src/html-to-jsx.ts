import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { parseStyleAttr } from './styles';

type P5Node = DefaultTreeAdapterMap['childNode'];
type P5Element = DefaultTreeAdapterMap['element'];

const VOID = new Set(['br', 'img', 'hr', 'input', 'wbr', 'col', 'source', 'meta', 'link', 'area', 'embed', 'track']);
const RENAMED: Record<string, string> = { class: 'className', for: 'htmlFor', 'xlink:href': 'xlinkHref', 'xml:space': 'xmlSpace', tabindex: 'tabIndex' };

/** Characters JSX text cannot hold literally. */
export const escapeJsxText = (text: string) => text.replace(/[{}<>]/g, (c) => `{${JSON.stringify(c)}}`);

/** A JSX attribute value: plain quotes when safe, otherwise a JS string expression. */
export const jsxAttrValue = (value: string) => (/["{}\\\n]/.test(value) ? `{${JSON.stringify(value)}}` : `"${value}"`);

const attrName = (name: string) => RENAMED[name] ?? (/^(data|aria)-/.test(name) ? name : name.replace(/[-:]([a-z])/g, (_, c: string) => c.toUpperCase()));

function styleExpr(css: string): string {
  const entries = Object.entries(parseStyleAttr(css)).map(([k, v]) => `${/^[a-zA-Z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{{ ${entries.join(', ')} }}`;
}

function element(el: P5Element): string {
  const attrs = el.attrs.map((a) => (a.name === 'style' ? `style=${styleExpr(a.value)}` : `${attrName(a.prefix ? `${a.prefix}:${a.name}` : a.name)}=${jsxAttrValue(a.value)}`));
  const open = `<${el.tagName}${attrs.length ? ` ${attrs.join(' ')}` : ''}`;
  const children = el.childNodes.map(node).join('');
  if (!children && (VOID.has(el.tagName) || el.namespaceURI !== 'http://www.w3.org/1999/xhtml')) return `${open} />`;
  return `${open}>${children}</${el.tagName}>`;
}

function node(n: P5Node): string {
  if (n.nodeName === '#text') return escapeJsxText((n as DefaultTreeAdapterMap['textNode']).value);
  if ('tagName' in n) return element(n);
  return '';
}

/** Converts an HTML or SVG fragment to JSX that compiles: escaped text, self-closed void tags, JSX attribute names, style objects. */
export function htmlToJsx(html: string): string {
  return parseFragment(html).childNodes.map(node).join('');
}
