import { tools, type DocToolName, type ToolParams } from '@markup/protocol';
import type { MarkupDoc } from './document';
import { toJsx } from './jsx-export';
import { parsePx, rightEdge } from './ops';
import { findNodes, plainText, treeSummary } from './query';
import { MarkupError, type Actor, type MarkupNode, type PageIcon } from './schema';
import type { Token } from './tokens';

const ARTBOARD_GAP = 80;
const COMPONENT: Record<MarkupNode['type'], string> = { root: 'Root', frame: 'Frame', text: 'Text', image: 'Image', svg: 'SVG' };

export interface ToolContext {
  activePageId: string;
}

function parse<T extends DocToolName>(method: T, params: unknown): ToolParams<T> {
  const result = tools[method].input.safeParse(params ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new MarkupError('INVALID_PARAMS', `Invalid parameters for ${method}: ${detail}`);
  }
  return result.data as ToolParams<T>;
}

function position(node: MarkupNode) {
  const absolute = node.styles.position === 'absolute';
  return { x: absolute ? (parsePx(node.styles.left) ?? null) : null, y: absolute ? (parsePx(node.styles.top) ?? null) : null };
}

function summarize(doc: MarkupDoc, node: MarkupNode) {
  const isArtboard = node.parentId !== null && doc.requireNode(node.parentId).type === 'root';
  const { x, y } = position(node);
  return {
    id: node.id,
    name: node.name,
    component: COMPONENT[node.type],
    childCount: node.children.length,
    x,
    y,
    worldX: isArtboard ? x : null,
    worldY: isArtboard ? y : null,
  };
}

function fontsUsed(doc: MarkupDoc): string[] {
  const fonts = new Set<string>();
  for (const id of doc.nodes.keys()) {
    const family = doc.requireNode(id).styles.fontFamily;
    if (typeof family === 'string') {
      const first = family.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
      if (first) fonts.add(first);
    }
  }
  return [...fonts].sort();
}

function basicInfo(doc: MarkupDoc, pageId: string) {
  const pages = doc.pages();
  const page = pages.find((p) => p.type === 'page' && p.id === pageId);
  if (!page || page.type !== 'page') throw new MarkupError('PAGE_NOT_FOUND', `Page ${pageId} does not exist.`);
  const artboards = doc.requireNode(page.rootId).children.map((id) => {
    const n = doc.requireNode(id);
    return {
      id,
      name: n.name,
      width: parsePx(n.styles.width) ?? null,
      height: parsePx(n.styles.height) ?? null,
      worldX: parsePx(n.styles.left) ?? null,
      worldY: parsePx(n.styles.top) ?? null,
    };
  });
  return {
    fileId: doc.fileId,
    fileName: doc.name,
    page: { id: page.id, name: page.name },
    pages: pages.map((p) => (p.type === 'page' ? { type: 'page', id: p.id, name: p.name, icon: p.icon, isActive: p.id === pageId } : { type: 'divider', id: p.id })),
    nodeCount: doc.nodeCount(),
    artboards,
    fonts: fontsUsed(doc),
    tokens: (doc.getTokens() as Token[]).map(({ name, type, value }) => ({ name, type, value })),
  };
}

/** Runs one document-only MCP tool against a MarkupDoc on behalf of an actor. */
export function runDocTool(doc: MarkupDoc, actor: Actor, method: DocToolName, rawParams: unknown, ctx: ToolContext): unknown {
  switch (method) {
    case 'get_basic_info': {
      const p = parse(method, rawParams);
      return basicInfo(doc, p.pageId ?? ctx.activePageId);
    }
    case 'get_tree_summary': {
      const p = parse(method, rawParams);
      return treeSummary(doc, p.nodeId, p.depth ?? 3);
    }
    case 'get_children': {
      const p = parse(method, rawParams);
      return doc.requireNode(p.nodeId).children.map((id) => summarize(doc, doc.requireNode(id)));
    }
    case 'get_node_info': {
      const p = parse(method, rawParams);
      const n = doc.requireNode(p.nodeId);
      return {
        ...summarize(doc, n),
        width: parsePx(n.styles.width) ?? null,
        height: parsePx(n.styles.height) ?? null,
        visible: !n.hidden,
        locked: n.locked,
        parentId: n.parentId,
        childIds: n.children,
        artboardId: doc.artboardOf(n.id),
        ...(n.type === 'text' ? { textContent: plainText(n.text ?? '') } : {}),
      };
    }
    case 'get_jsx': {
      const p = parse(method, rawParams);
      return toJsx(doc, p.nodeId, { format: p.format, includeNodeIds: p.includeNodeIds, includeRootPositioning: p.includeRootPositioning });
    }
    case 'find_nodes': {
      const p = parse(method, rawParams);
      return findNodes(doc, p);
    }
    case 'create_artboard': {
      const p = parse(method, rawParams);
      const rootId = doc.rootOf(p.pageId ?? ctx.activePageId);
      const left = rightEdge(doc, rootId) + ARTBOARD_GAP;
      const styles = { display: 'flex', flexDirection: 'column', ...p.styles, position: 'absolute', left: p.styles.left ?? left, top: p.styles.top ?? 0 };
      const [nodeId] = doc.insertNodes(actor, rootId, [{ type: 'frame', name: p.name, styles }], undefined, `Created artboard "${p.name}"`);
      return { nodeId };
    }
    case 'write_html': {
      const p = parse(method, rawParams);
      return doc.writeHtml(actor, p.targetNodeId, p.html, p.mode);
    }
    case 'update_styles': {
      const p = parse(method, rawParams);
      return doc.updateStyles(actor, p.updates);
    }
    case 'set_text_content': {
      const p = parse(method, rawParams);
      doc.setText(actor, p.updates);
      return { updated: p.updates.map((u) => u.nodeId) };
    }
    case 'duplicate_nodes': {
      const p = parse(method, rawParams);
      return doc.duplicateNodes(actor, p.nodes);
    }
    case 'move_nodes': {
      const p = parse(method, rawParams);
      return doc.moveNodes(actor, p.moves);
    }
    case 'delete_nodes': {
      const p = parse(method, rawParams);
      doc.deleteNodes(actor, p.nodeIds);
      return { deleted: p.nodeIds };
    }
    case 'rename_nodes': {
      const p = parse(method, rawParams);
      doc.renameNodes(actor, p.updates);
      return { renamed: p.updates.map((u) => ({ nodeId: u.nodeId, name: doc.requireNode(u.nodeId).name })) };
    }
    case 'finish_working_on_nodes': {
      const p = parse(method, rawParams);
      doc.setWorking(actor, p.nodeIds ?? 'all', false);
      return { released: p.nodeIds ?? 'all' };
    }
    case 'get_tokens': {
      const p = parse(method, rawParams);
      return doc.getTokens(p);
    }
    case 'create_tokens': {
      const p = parse(method, rawParams);
      return doc.createTokens(actor, p.tokens);
    }
    case 'set_tokens': {
      const p = parse(method, rawParams);
      return doc.setTokens(actor, p.tokens);
    }
    case 'create_page': {
      const p = parse(method, rawParams);
      return { pageId: doc.createPage(actor, { name: p.name, icon: p.icon as PageIcon | undefined }) };
    }
    case 'update_pages': {
      const p = parse(method, rawParams);
      doc.updatePages(actor, p.updates);
      return { updated: p.updates.map((u) => u.pageId) };
    }
    case 'arrange_pages': {
      const p = parse(method, rawParams);
      return { pages: doc.arrangePages(actor, p.order, p.removeDividerIds) };
    }
    default: {
      const never: never = method;
      throw new MarkupError('INVALID_ARGUMENT', `Unknown tool ${String(never)}.`);
    }
  }
}
