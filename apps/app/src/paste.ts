import DOMPurify from 'dompurify';
import { parseHtml, type Actor, type MarkupDoc, type NodeSpec, type Styles } from '@markup/doc';
import type { Point } from './canvas/viewport';

export interface PasteData {
  html?: string;
  text?: string;
  files?: File[];
}

export interface PasteTarget {
  selection: string[];
  rootId: string;
  viewportCenter: Point;
  /** `paste` (default), `on-top` (over the selection, same position) or `replace` (swap each selected node). */
  mode?: 'paste' | 'on-top' | 'replace';
}

export const SNAPSHOT_MARKER = '<!--markup:snapshot v1-->';
/** The extension also marks each snapshot root div, since clipboard sanitisers can drop the comment. */
export const SNAPSHOT_ATTR = 'data-markup-snapshot';
/** On an exact snapshot root: the payload is the page's own structure and CSS, parsed in the permissive dialect. */
export const DIALECT_ATTR = 'data-markup-dialect';
export const HEIC_MESSAGE = 'HEIC images are not supported in this browser.';
const ARTBOARD_GAP = 80;
const MAX_IMAGE_SIDE = 2000;
const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 200;
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|heic|heif)$/i;
const HEIC = /^image\/(heic|heif)$/i;

const px = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+(\.\d+)?(px)?$/.test(v.trim()) ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

// A private instance, so the hooks below never touch the sanitiser the canvas uses.
const purifier = DOMPurify(window);
const SAFE_URL = /^(https?:|data:image\/(png|jpe?g|gif|webp|avif)[;,])/i;
const BAD_VALUE = /javascript:|vbscript:|expression\(|-moz-binding|behavior\s*:|@import|image-set\(|\\/i;
const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

/** Splits a style attribute on top-level semicolons (data URLs and quoted strings contain their own). */
function declarations(style: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of style) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Drops Office cruft and anything that can run script or load a non-image, non-http resource. */
function safeDeclaration(d: string): boolean {
  if (!d.trim() || /^\s*-?mso-/i.test(d) || BAD_VALUE.test(d)) return false;
  for (const m of d.matchAll(CSS_URL)) if (!SAFE_URL.test(m[2]!.trim())) return false;
  return !/url\(/i.test(d.replace(CSS_URL, ''));
}

purifier.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style') data.attrValue = declarations(data.attrValue).filter(safeDeclaration).join(';');
});

/** Sanitises pasted HTML and strips Office/Docs cruft; returns the cleaned body markup. */
export function cleanHtml(html: string): string {
  const safe = purifier.sanitize(html, {
    FORBID_TAGS: ['style', 'meta', 'script', 'iframe', 'object', 'embed', 'link', 'o:p'],
    ADD_ATTR: ['layer-name', 'data-source', SNAPSHOT_ATTR, DIALECT_ATTR],
    ALLOW_DATA_ATTR: true,
  });
  const body = new DOMParser().parseFromString(`<body>${safe}</body>`, 'text/html').body;
  // Google Docs wraps everything in <b id="docs-internal-guid-…"> (a bold lie); unwrap it.
  body.querySelectorAll('[id^="docs-internal-guid"]').forEach((el) => el.replaceWith(...Array.from(el.childNodes)));
  body.querySelectorAll('img').forEach((img) => {
    if (!SAFE_URL.test((img.getAttribute('src') ?? '').trim())) img.remove();
  });
  body.querySelectorAll('[style=""]').forEach((el) => el.removeAttribute('style'));
  return body.innerHTML;
}

const cleanSvg = (svg: string) => purifier.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svgSize(svg: string): { width: number; height: number } {
  const w = /<svg[^>]*\swidth="([\d.]+)(?:px)?"/i.exec(svg)?.[1];
  const h = /<svg[^>]*\sheight="([\d.]+)(?:px)?"/i.exec(svg)?.[1];
  if (w && h) return { width: parseFloat(w), height: parseFloat(h) };
  const vb = /viewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/i.exec(svg);
  return vb ? { width: parseFloat(vb[1]!), height: parseFloat(vb[2]!) } : { width: 100, height: 100 };
}

const readDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the image.'));
    r.readAsDataURL(file);
  });

async function imageSpec(file: File): Promise<NodeSpec> {
  const heic = HEIC.test(file.type) || /\.(heic|heif)$/i.test(file.name);
  let size = { width: 200, height: 200 };
  let src: string;
  if (heic) {
    // Only webviews that can decode HEIC get this far; the result is re-encoded as PNG.
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error(HEIC_MESSAGE);
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    size = { width: canvas.width, height: canvas.height };
    src = canvas.toDataURL('image/png');
  } else {
    src = await readDataUrl(file);
    try {
      const bitmap = await createImageBitmap(file);
      size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
    } catch {
      /* Unknown natural size: keep the placeholder. */
    }
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(size.width, size.height, 1));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  return { type: 'image', name: file.name.replace(/\.[^.]+$/, '') || 'Image', src, styles: { width: `${width}px`, height: `${height}px` } };
}

/** Whether a top-level div of the cleaned markup carries the snapshot attribute, and whether one asks for the `any` dialect. */
function snapshotRoots(cleaned: string): { snapshot: boolean; any: boolean } {
  const body = new DOMParser().parseFromString(`<body>${cleaned}</body>`, 'text/html').body;
  const roots = Array.from(body.children).filter((el) => el.localName === 'div' && el.hasAttribute(SNAPSHOT_ATTR));
  return { snapshot: roots.length > 0, any: roots.some((el) => el.getAttribute(DIALECT_ATTR) === 'any') };
}

/** Everything the clipboard holds, as node specs, plus whether it is a snapshot payload. */
async function toSpecs(data: PasteData): Promise<{ specs: NodeSpec[]; snapshot: boolean }> {
  const images = (data.files ?? []).filter((f) => IMAGE_TYPES.test(f.type) || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(f.name));
  if (images.length) return { specs: await Promise.all(images.map(imageSpec)), snapshot: false };

  const html = data.html?.trim();
  if (html) {
    const cleaned = cleanHtml(html);
    const roots = snapshotRoots(cleaned);
    const snapshot = html.includes(SNAPSHOT_MARKER) || roots.snapshot;
    const { specs } = parseHtml(cleaned, { dialect: roots.any ? 'any' : 'strict' });
    if (specs.length) return { specs, snapshot };
  }

  const text = data.text?.trim();
  if (!text) return { specs: [], snapshot: false };
  if (/^<svg[\s>]/i.test(text)) {
    const svg = cleanSvg(text);
    if (svg.includes('<svg')) {
      const { width, height } = svgSize(svg);
      return { specs: [{ type: 'svg', svg, styles: { width: `${width}px`, height: `${height}px` } }], snapshot: false };
    }
  }
  return { specs: [{ type: 'text', text: escapeHtml(text).replace(/\r?\n/g, '<br>') }], snapshot: false };
}

const widthOf = (s: NodeSpec) => px(s.styles?.width) ?? DEFAULT_WIDTH;
const heightOf = (s: NodeSpec) => px(s.styles?.height) ?? DEFAULT_HEIGHT;

/** Snapshot roots become artboards themselves, side by side, centred on the viewport. */
function snapshotArtboards(specs: NodeSpec[], center: Point): NodeSpec[] {
  const roots = specs.filter((s) => s.type === 'frame');
  const total = roots.reduce((sum, s) => sum + widthOf(s), 0) + ARTBOARD_GAP * (roots.length - 1);
  let left = center.x - total / 2;
  return roots.map((s) => {
    const { position: _position, left: _l, top: _t, ...rest } = (s.styles ?? {}) as Styles;
    const out: NodeSpec = { ...s, styles: { ...rest, position: 'absolute', left, top: center.y - heightOf(s) / 2, width: `${widthOf(s)}px`, ...(px(s.styles?.height) !== undefined ? { height: `${heightOf(s)}px` } : {}) } };
    left += widthOf(s) + ARTBOARD_GAP;
    return out;
  });
}

/** A fresh artboard around the content, centred at the viewport centre. */
function newArtboard(specs: NodeSpec[], center: Point): NodeSpec {
  const width = Math.max(...specs.map(widthOf));
  const single = specs.length === 1 && specs[0]!.type !== 'frame' ? heightOf(specs[0]!) : DEFAULT_HEIGHT;
  const name = specs.length === 1 ? specs[0]!.name : undefined;
  return {
    type: 'frame',
    name: name ?? 'Pasted',
    styles: { display: 'flex', flexDirection: 'column', position: 'absolute', left: center.x - width / 2, top: center.y - single / 2, width: `${width}px`, height: 'fit-content' },
    children: specs,
  };
}

const POSITION_KEYS = ['position', 'left', 'top', 'width', 'height'] as const;

/**
 * Turns clipboard content into layers. One undo step ("Pasted N layers"). Returns the ids of the top-level
 * layers created. Rejects with a user-facing message when the content cannot be used (HEIC without decoder).
 */
export async function pasteIntoDoc(doc: MarkupDoc, actor: Actor, data: PasteData, target: PasteTarget): Promise<string[]> {
  const { specs, snapshot } = await toSpecs(data);
  if (specs.length === 0) return [];
  const mode = target.mode ?? 'paste';
  const selected = target.selection.filter((id) => {
    const n = doc.getNode(id);
    return n && n.type !== 'root';
  });
  const summary = (n: number) => `Pasted ${n} layer${n === 1 ? '' : 's'}`;

  if (snapshot) {
    const artboards = snapshotArtboards(specs, target.viewportCenter);
    if (artboards.length) return doc.batch(actor, summary(artboards.length), () => doc.insertNodes(actor, target.rootId, artboards));
  }

  if (mode === 'replace' && selected.length) {
    return doc.batch(actor, summary(specs.length * selected.length), () =>
      selected.flatMap((id) => {
        const old = doc.requireNode(id);
        const kept = Object.fromEntries(POSITION_KEYS.filter((k) => old.styles[k] !== undefined).map((k) => [k, old.styles[k]!]));
        const replacement = specs.map((s, i) => (i === 0 ? { ...s, styles: { ...s.styles, ...kept } } : s));
        return doc.replaceNode(actor, id, replacement);
      }),
    );
  }

  if (mode === 'on-top' && selected.length) {
    const first = doc.requireNode(selected[0]!);
    const parent = doc.requireNode(first.parentId!);
    const at = { position: 'absolute', left: px(first.styles.left) ?? 0, top: px(first.styles.top) ?? 0 };
    const placed = specs.map((s, i) => (i === 0 ? { ...s, styles: { ...s.styles, ...at } } : s));
    return doc.batch(actor, summary(specs.length), () => doc.insertNodes(actor, parent.id, placed, parent.children.indexOf(first.id) + 1));
  }

  // Plain paste: into the one selected frame, beside a selected non-frame, else a new artboard.
  const only = selected.length === 1 ? doc.requireNode(selected[0]!) : null;
  const container = only ? (only.type === 'frame' ? only : doc.requireNode(only.parentId!)) : null;
  if (container && container.type !== 'root') return doc.batch(actor, summary(specs.length), () => doc.insertNodes(actor, container.id, specs));

  const artboard = newArtboard(specs, target.viewportCenter);
  return doc.batch(actor, summary(specs.length), () => doc.insertNodes(actor, target.rootId, [artboard]));
}

/** Reads the system clipboard (⇧⌘V, ⇧⌘R). Throws a readable error when access is denied. */
export async function readClipboard(): Promise<PasteData> {
  let items: ClipboardItems;
  try {
    items = await navigator.clipboard.read();
  } catch {
    throw new Error('Clipboard access was denied. Allow it in your browser, or paste with ⌘V.');
  }
  const data: PasteData = { files: [] };
  for (const item of items) {
    for (const type of item.types) {
      const blob = await item.getType(type);
      if (type === 'text/html') data.html = await blob.text();
      else if (type === 'text/plain') data.text = await blob.text();
      else if (type.startsWith('image/')) data.files!.push(new File([blob], `Pasted image.${type.split('/')[1]}`, { type }));
    }
  }
  return data;
}
