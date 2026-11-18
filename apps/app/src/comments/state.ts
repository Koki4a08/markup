import { useCallback, useSyncExternalStore } from 'react';
import type { CommentThread } from '@markup/doc';

export type StatusFilter = 'open' | 'resolved' | 'all';
export type SortKey = 'page' | 'newest' | 'activity';

export interface CommentFilter {
  status: StatusFilter;
  currentPageOnly: boolean;
  sort: SortKey;
  search: string;
}

export const DEFAULT_FILTER: CommentFilter = { status: 'open', currentPageOnly: true, sort: 'page', search: '' };

export interface Draft {
  pageId: string;
  nodeId: string | null;
  x: number;
  y: number;
}

/** Pins of resolved threads only show while the panel filter includes them. */
export const pinVisible = (t: CommentThread, filter: CommentFilter) => (t.status === 'open' ? filter.status !== 'resolved' : filter.status !== 'open');

export const lastMessage = (t: CommentThread) => t.messages[t.messages.length - 1];

// Last-seen message time per thread, kept in localStorage per file. Everything works without storage.
const KEY = (fileId: string) => `markup:comments-seen:${fileId}`;
const seenCache = new Map<string, Record<string, number>>();
const listeners = new Set<() => void>();

function loadSeen(fileId: string): Record<string, number> {
  let seen = seenCache.get(fileId);
  if (!seen) {
    try {
      seen = JSON.parse(localStorage.getItem(KEY(fileId)) ?? '{}') as Record<string, number>;
    } catch {
      seen = {};
    }
    seenCache.set(fileId, seen);
  }
  return seen;
}

export function markSeen(fileId: string, thread: CommentThread): void {
  const at = lastMessage(thread)?.createdAt ?? thread.updatedAt;
  const seen = loadSeen(fileId);
  if ((seen[thread.id] ?? 0) >= at) return;
  const next = { ...seen, [thread.id]: at };
  seenCache.set(fileId, next);
  try {
    localStorage.setItem(KEY(fileId), JSON.stringify(next));
  } catch {
    /* storage unavailable: unread state lasts for this session only */
  }
  for (const fn of [...listeners]) fn();
}

export function useSeen(fileId: string): Record<string, number> {
  const subscribe = useCallback((fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }, []);
  return useSyncExternalStore(subscribe, () => loadSeen(fileId), () => loadSeen(fileId));
}

/** Unread: someone else wrote the latest message and it is newer than what this browser has seen. */
export function isUnread(t: CommentThread, seen: Record<string, number>, userId: string): boolean {
  const last = lastMessage(t);
  return !!last && last.authorId !== userId && last.createdAt > (seen[t.id] ?? 0);
}
