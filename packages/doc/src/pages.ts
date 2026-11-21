import * as Y from 'yjs';
import type { MarkupDoc } from './document';
import { newId } from './ynode';
import { MarkupError, type PageIcon } from './schema';

export interface PageUpdate {
  pageId: string;
  name?: string;
  icon?: PageIcon | null;
}

export type ArrangeItem = string | { type: 'divider' };

export function updatePages(doc: MarkupDoc, updates: PageUpdate[]): void {
  const entries = updates.map((u) => {
    const entry = doc.pagesArr.toArray().find((p) => p.get('type') === 'page' && p.get('id') === u.pageId);
    if (!entry) throw new MarkupError('PAGE_NOT_FOUND', `Page ${u.pageId} does not exist.`);
    return { entry, u };
  });
  for (const { entry, u } of entries) {
    if (u.name !== undefined) entry.set('name', u.name);
    if (u.icon !== undefined) entry.set('icon', u.icon);
  }
}

/** Rebuilds the page list in the given order (Yjs cannot move a shared type). Validates fully before writing. */
export function arrangePages(doc: MarkupDoc, order: ArrangeItem[], removeDividerIds: string[] = []): void {
  const existing = doc.pagesArr.toArray();
  const dividerIds = new Set(existing.filter((p) => p.get('type') === 'divider').map((p) => p.get('id') as string));
  const removed = new Set(removeDividerIds);
  for (const id of removed) {
    if (!dividerIds.has(id)) throw new MarkupError('INVALID_ORDER', `${id} is not a divider, so it cannot be removed.`);
  }
  const expected = new Set(existing.map((p) => p.get('id') as string).filter((id) => !removed.has(id)));
  const seen = new Set<string>();
  for (const item of order) {
    if (typeof item !== 'string') continue;
    if (!expected.has(item)) throw new MarkupError('INVALID_ORDER', `${item} is unknown, removed, or not part of the page list.`);
    if (seen.has(item)) throw new MarkupError('INVALID_ORDER', `${item} is listed more than once.`);
    seen.add(item);
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new MarkupError('INVALID_ORDER', `Order is missing: ${missing.join(', ')}. Re-read the page list and pass every item.`);

  const byId = new Map(existing.map((p) => [p.get('id') as string, p.toJSON() as Record<string, unknown>]));
  const rebuilt = order.map((item) => {
    const fields = typeof item === 'string' ? byId.get(item)! : { type: 'divider', id: newId() };
    const entry = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(fields)) entry.set(key, value);
    return entry;
  });
  doc.pagesArr.delete(0, doc.pagesArr.length);
  doc.pagesArr.push(rebuilt);
}
