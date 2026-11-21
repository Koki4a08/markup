import { MarkupError, type Actor, type LibraryItem } from '@markup/doc';
// Through its own entry: runDocTool pulls in the protocol's zod schemas, which only the lazily loaded bridge needs.
import { runDocTool } from '@markup/doc/tools';
import { parseMarkupLink, tools, type ResourceToolName, type ToolParams } from '@markup/protocol';
import { fileUrl, type Workspace } from '../workspace/Workspace';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parse<T extends ResourceToolName>(method: T, params: unknown): ToolParams<T> {
  const result = tools[method].input.safeParse(params ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new MarkupError('INVALID_PARAMS', `Invalid parameters for ${method}: ${detail}`);
  }
  return result.data as ToolParams<T>;
}

/** An item as agents see it: parentId omitted at the top level, every local item a draft. */
function present(item: LibraryItem, tab?: { active: boolean }) {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    ...(item.parentId !== null ? { parentId: item.parentId } : {}),
    ...(item.type === 'file' ? { url: fileUrl(item.id) } : {}),
    ...(tab ? { open: true, active: tab.active } : {}),
    draft: true,
    ...(item.archived ? { archived: true } : {}),
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
  };
}

/** Accepts a bare id, /file/<id>[/<pageId>], or markup://file/<id>[/<pageId>]. */
export function parseFileRef(ref: string): { fileId: string; pageId?: string } {
  // A copied node or page link (markup://file/<id>/node/<n>, …/page/<p>) opens its file, and its page.
  const link = parseMarkupLink(ref);
  if (link && (link.nodeId || link.pageId)) return link.pageId ? { fileId: link.fileId, pageId: link.pageId } : { fileId: link.fileId };
  const m = /^(?:markup:\/\/file\/|\/?file\/)([^/?#]+)(?:\/([^/?#]+))?/.exec(ref.trim());
  if (!m) return { fileId: ref.trim() };
  return m[2] ? { fileId: decodeURIComponent(m[1]!), pageId: decodeURIComponent(m[2]) } : { fileId: decodeURIComponent(m[1]!) };
}

/** Tools about files, folders and tabs. They act on the workspace whatever file is in front. */
export async function runResourceTool(workspace: Workspace, method: ResourceToolName, rawParams: unknown, ctx: { actor: Actor }): Promise<unknown> {
  const { library } = workspace;
  switch (method) {
    case 'list_resources': {
      const p = parse(method, rawParams);
      const limit = p.limit ?? DEFAULT_LIMIT;
      const inScope = (item: LibraryItem) => (p.includeArchived || !item.archived) && (p.parentId === undefined || item.parentId === p.parentId);
      const open = workspace
        .tabs()
        .map((tab) => ({ tab, item: library.get(tab.fileId) }))
        .filter((o): o is { tab: (typeof o)['tab']; item: LibraryItem } => !!o.item && inScope(o.item));
      const openIds = new Set(open.map((o) => o.item.id));
      const rest = library.list({ includeArchived: p.includeArchived, parentId: p.parentId, limit: Math.min(MAX_LIMIT, limit + open.length) });
      const items = [...open.map((o) => present(o.item, o.tab)), ...rest.items.filter((i) => !openIds.has(i.id)).map((i) => present(i))];
      const truncated = items.length > limit || rest.truncated === true;
      return truncated ? { items: items.slice(0, limit), truncated: true } : { items };
    }
    case 'open_file': {
      const p = parse(method, rawParams);
      const ref = parseFileRef(p.fileId);
      const doc = await workspace.open(ref.fileId, p.pageId ?? ref.pageId);
      return runDocTool(doc, ctx.actor, 'get_basic_info', {}, { activePageId: workspace.activePageId(doc.fileId), currentUserId: 'local-user' });
    }
    case 'create_file': {
      const p = parse(method, rawParams);
      const item = await workspace.createFile({ name: p.name, parentId: p.parentId, cloneFileId: p.cloneFileId === undefined ? undefined : parseFileRef(p.cloneFileId).fileId });
      return { id: item.id, type: item.type, name: item.name, ...(item.parentId !== null ? { parentId: item.parentId } : {}), url: item.url };
    }
    case 'create_folder': {
      const p = parse(method, rawParams);
      return present(library.createFolder({ name: p.name, parentId: p.parentId }));
    }
    case 'rename_resource': {
      const p = parse(method, rawParams);
      const item = workspace.rename(p.resourceId, p.name);
      return { id: item.id, type: item.type, name: item.name };
    }
    case 'move_resources': {
      const p = parse(method, rawParams);
      const { moved, alreadyThere } = library.move(p.resourceIds, p.parentId);
      return { moved: moved.map((i) => present(i)), alreadyThere: alreadyThere.map((i) => present(i)) };
    }
    case 'archive_resources': {
      const p = parse(method, rawParams);
      return { items: library.archive(p.resourceIds).map((i) => present(i)) };
    }
    case 'unarchive_resources': {
      const p = parse(method, rawParams);
      return { items: library.unarchive(p.resourceIds).map((i) => present(i)) };
    }
  }
}
