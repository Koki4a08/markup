/** Links the editor copies (Copy link) and agents pass back as node or file references. */

export const nodeLink = (fileId: string, nodeId: string) => `markup://file/${encodeURIComponent(fileId)}/node/${encodeURIComponent(nodeId)}`;
export const pageLink = (fileId: string, pageId: string) => `markup://file/${encodeURIComponent(fileId)}/page/${encodeURIComponent(pageId)}`;

export interface MarkupLink {
  fileId: string;
  pageId?: string;
  nodeId?: string;
}

const LINK = /^(?:markup:\/\/file\/|\/file\/)([^/?#\s]+)(?:\/(node|page)\/([^/?#\s]+))?\/?$/;

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Parses `markup://file/<f>`, `markup://file/<f>/node/<n>`, `markup://file/<f>/page/<p>` and the `/file/<f>…` route form.
 * Bare ids and other schemes are not links: null.
 */
export function parseMarkupLink(s: string): MarkupLink | null {
  const m = LINK.exec(s.trim());
  if (!m) return null;
  const link: MarkupLink = { fileId: decode(m[1]!) };
  if (m[2] === 'node') link.nodeId = decode(m[3]!);
  if (m[2] === 'page') link.pageId = decode(m[3]!);
  return link;
}
