import type { MarkupDoc } from './document';
import { htmlToJsx, jsxAttrValue } from './html-to-jsx';
import type { MarkupNode, Styles, StyleValue } from './schema';

export interface JsxOptions {
  format?: 'inline-styles' | 'tailwind';
  includeNodeIds?: boolean;
  includeRootPositioning?: boolean;
}

const ROOT_POSITION = new Set(['position', 'top', 'left', 'right', 'bottom']);

const KEYWORD: Record<string, Record<string, string>> = {
  display: { flex: 'flex', none: 'hidden', block: 'block' },
  flexDirection: { column: 'flex-col', row: 'flex-row', 'column-reverse': 'flex-col-reverse', 'row-reverse': 'flex-row-reverse' },
  flexWrap: { wrap: 'flex-wrap', nowrap: 'flex-nowrap' },
  alignItems: { 'flex-start': 'items-start', start: 'items-start', center: 'items-center', 'flex-end': 'items-end', end: 'items-end', stretch: 'items-stretch', baseline: 'items-baseline' },
  justifyContent: { 'flex-start': 'justify-start', start: 'justify-start', center: 'justify-center', 'flex-end': 'justify-end', end: 'justify-end', 'space-between': 'justify-between', 'space-around': 'justify-around', 'space-evenly': 'justify-evenly' },
  position: { absolute: 'absolute', relative: 'relative', fixed: 'fixed', sticky: 'sticky' },
  overflow: { hidden: 'overflow-hidden' },
};

/** Properties rendered as Tailwind arbitrary values, in output order. */
const ARBITRARY: [string, string][] = [
  ['gap', 'gap'],
  ['padding', 'p'],
  ['paddingTop', 'pt'],
  ['paddingRight', 'pr'],
  ['paddingBottom', 'pb'],
  ['paddingLeft', 'pl'],
  ['top', 'top'],
  ['right', 'right'],
  ['bottom', 'bottom'],
  ['left', 'left'],
  ['width', 'w'],
  ['height', 'h'],
  ['borderRadius', 'rounded'],
  ['backgroundColor', 'bg'],
  ['color', 'text'],
  ['fontSize', 'text'],
  ['fontWeight', 'font'],
];

const asCss = (key: string, v: StyleValue) => (typeof v === 'number' && key !== 'fontWeight' ? `${v}px` : String(v));

export function toTailwindClasses(styles: Styles): { className: string; rest: Styles } {
  const rest: Styles = { ...styles };
  const classes: string[] = [];
  for (const [key, map] of Object.entries(KEYWORD)) {
    const v = rest[key];
    const cls = v === undefined ? undefined : map[String(v)];
    if (cls) {
      classes.push(cls);
      delete rest[key];
    }
  }
  for (const [key, prefix] of ARBITRARY) {
    const v = rest[key];
    if (v === undefined) continue;
    const css = asCss(key, v);
    if (/\s/.test(css)) continue;
    classes.push(`${prefix}-[${css}]`);
    delete rest[key];
  }
  return { className: classes.join(' '), rest };
}

function styleObject(styles: Styles): string {
  const entries = Object.entries(styles).map(([k, v]) => `${/^[a-zA-Z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${typeof v === 'number' ? v : JSON.stringify(v)}`);
  return `{{ ${entries.join(', ')} }}`;
}

function attrs(node: MarkupNode, styles: Styles, opts: Required<JsxOptions>, extra: string[] = []): string {
  const parts: string[] = [];
  if (opts.includeNodeIds) parts.push(`id="${node.id}"`);
  parts.push(...extra);
  if (opts.format === 'tailwind') {
    const { className, rest } = toTailwindClasses(styles);
    if (className) parts.push(`className="${className}"`);
    if (Object.keys(rest).length) parts.push(`style=${styleObject(rest)}`);
  } else if (Object.keys(styles).length) parts.push(`style=${styleObject(styles)}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

export function toJsx(doc: MarkupDoc, nodeId: string, options: JsxOptions = {}): string {
  const opts: Required<JsxOptions> = { format: 'inline-styles', includeNodeIds: true, includeRootPositioning: false, ...options };
  const lines: string[] = [];

  const walk = (id: string, depth: number) => {
    const node = doc.requireNode(id);
    const pad = '  '.repeat(depth);
    let styles = node.styles;
    if (depth === 0 && !opts.includeRootPositioning) {
      styles = Object.fromEntries(Object.entries(styles).filter(([k]) => !ROOT_POSITION.has(k)));
    }
    switch (node.type) {
      case 'text':
        lines.push(`${pad}<p${attrs(node, styles, opts)}>${htmlToJsx(node.text ?? '')}</p>`);
        return;
      case 'image':
        lines.push(`${pad}<img${attrs(node, styles, opts, [`src=${jsxAttrValue(node.src ?? '')}`])} />`);
        return;
      case 'svg':
        lines.push(`${pad}${htmlToJsx(node.svg ?? '')}`);
        return;
      default:
        if (node.children.length === 0) {
          lines.push(`${pad}<div${attrs(node, styles, opts)} />`);
          return;
        }
        lines.push(`${pad}<div${attrs(node, styles, opts)}>`);
        for (const child of node.children) walk(child, depth + 1);
        lines.push(`${pad}</div>`);
    }
  };

  walk(nodeId, 0);
  return lines.join('\n');
}
