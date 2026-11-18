import * as Y from 'yjs';
import type { MarkupDoc } from './document';
import { MarkupError, type Actor } from './schema';
import { newId } from './ynode';

export interface CommentAttachment {
  name: string;
  url: string;
  mimeType: string;
}

export interface CommentMessage {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: number;
  attachments: CommentAttachment[];
  reactions: Record<string, string[]>;
  deleted?: true;
}

export interface CommentThread {
  id: string;
  pageId: string;
  nodeId: string | null;
  /** Offset inside nodeId, or world coordinates when nodeId is null. */
  x: number;
  y: number;
  status: 'open' | 'resolved';
  createdAt: number;
  updatedAt: number;
  messages: CommentMessage[];
  deleted?: true;
}

export const commentsArr = (doc: MarkupDoc) => doc.ydoc.getArray<Y.Map<unknown>>('comments');

const notFound = (what: string, id: string) => new MarkupError('INVALID_ARGUMENT', `${what} ${id} does not exist.`);

function readMessage(m: Y.Map<unknown>): CommentMessage {
  const out: CommentMessage = {
    id: m.get('id') as string,
    authorId: m.get('authorId') as string,
    authorName: m.get('authorName') as string,
    body: m.get('body') as string,
    createdAt: m.get('createdAt') as number,
    attachments: (m.get('attachments') as CommentAttachment[] | undefined) ?? [],
    reactions: (m.get('reactions') as Record<string, string[]> | undefined) ?? {},
  };
  if (m.get('deleted')) out.deleted = true;
  return out;
}

function readThread(t: Y.Map<unknown>): CommentThread {
  const out: CommentThread = {
    id: t.get('id') as string,
    pageId: t.get('pageId') as string,
    nodeId: (t.get('nodeId') as string | null) ?? null,
    x: t.get('x') as number,
    y: t.get('y') as number,
    status: t.get('status') as 'open' | 'resolved',
    createdAt: t.get('createdAt') as number,
    updatedAt: t.get('updatedAt') as number,
    messages: (t.get('messages') as Y.Array<Y.Map<unknown>>).toArray().map(readMessage),
  };
  if (t.get('deleted')) out.deleted = true;
  return out;
}

function newMessage(actor: Actor, body: string): Y.Map<unknown> {
  const text = body.trim();
  if (!text) throw new MarkupError('INVALID_ARGUMENT', 'A comment cannot be empty.');
  const m = new Y.Map<unknown>();
  m.set('id', newId());
  m.set('authorId', actor.id);
  m.set('authorName', actor.name);
  m.set('body', text);
  m.set('createdAt', Date.now());
  m.set('attachments', []);
  m.set('reactions', {});
  return m;
}

function yThread(doc: MarkupDoc, threadId: string): Y.Map<unknown> {
  const t = commentsArr(doc).toArray().find((x) => x.get('id') === threadId && !x.get('deleted'));
  if (!t) throw notFound('Comment thread', threadId);
  return t;
}

function yMessage(thread: Y.Map<unknown>, messageId: string): Y.Map<unknown> {
  const messages = (thread.get('messages') as Y.Array<Y.Map<unknown>>).toArray();
  const m = messages.find((x) => x.get('id') === messageId && !x.get('deleted'));
  if (!m) throw notFound('Comment message', messageId);
  return m;
}

export function createThread(
  doc: MarkupDoc,
  actor: Actor,
  opts: { pageId: string; nodeId: string | null; x: number; y: number; body: string },
): string {
  doc.rootOf(opts.pageId);
  if (opts.nodeId !== null) doc.yNode(opts.nodeId);
  const first = newMessage(actor, opts.body);
  const now = Date.now();
  const id = newId();
  const t = new Y.Map<unknown>();
  t.set('id', id);
  t.set('pageId', opts.pageId);
  t.set('nodeId', opts.nodeId);
  t.set('x', opts.x);
  t.set('y', opts.y);
  t.set('status', 'open');
  t.set('createdAt', now);
  t.set('updatedAt', now);
  const messages = new Y.Array<Y.Map<unknown>>();
  t.set('messages', messages);
  commentsArr(doc).push([t]);
  messages.push([first]);
  return id;
}

export function reply(doc: MarkupDoc, actor: Actor, threadId: string, body: string): string {
  const t = yThread(doc, threadId);
  const m = newMessage(actor, body);
  (t.get('messages') as Y.Array<Y.Map<unknown>>).push([m]);
  t.set('updatedAt', Date.now());
  return m.get('id') as string;
}

export function setThreadStatus(doc: MarkupDoc, threadId: string, status: 'open' | 'resolved'): void {
  const t = yThread(doc, threadId);
  if (t.get('status') === status) return;
  t.set('status', status);
  t.set('updatedAt', Date.now());
}

export function deleteMessage(doc: MarkupDoc, threadId: string, messageId: string): void {
  const t = yThread(doc, threadId);
  const messages = (t.get('messages') as Y.Array<Y.Map<unknown>>).toArray();
  const m = yMessage(t, messageId);
  m.set('deleted', true);
  // Deleting the opening message removes the whole conversation.
  if (messages[0] === m) t.set('deleted', true);
  t.set('updatedAt', Date.now());
}

/** Toggles the actor's reaction with this emoji. */
export function react(doc: MarkupDoc, actor: Actor, threadId: string, messageId: string, emoji: string): void {
  if (!emoji) throw new MarkupError('INVALID_ARGUMENT', 'An emoji is required.');
  const m = yMessage(yThread(doc, threadId), messageId);
  const reactions = { ...((m.get('reactions') as Record<string, string[]> | undefined) ?? {}) };
  const users = reactions[emoji] ?? [];
  const next = users.includes(actor.id) ? users.filter((u) => u !== actor.id) : [...users, actor.id];
  if (next.length) reactions[emoji] = next;
  else delete reactions[emoji];
  m.set('reactions', reactions);
}

/** Visible threads (deleted ones excluded) with their deleted messages stripped. */
export function listThreads(doc: MarkupDoc): CommentThread[] {
  return commentsArr(doc)
    .toArray()
    .map(readThread)
    .filter((t) => !t.deleted)
    .map((t) => ({ ...t, messages: t.messages.filter((m) => !m.deleted) }));
}

export interface ThreadQuery {
  status?: 'open' | 'resolved' | 'all';
  pageId?: string;
  nodeId?: string;
  currentPageOnly?: boolean;
  activePageId: string;
  participantUserId?: string;
  threadAuthorUserId?: string;
  currentUserId: string;
  search?: string;
  searchScope?: 'first-message' | 'all-messages';
  sortField?: 'page' | 'createdAt' | 'updatedAt';
  sortDirection?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  previewLength?: number;
}

export interface ThreadSummary {
  id: string;
  status: 'open' | 'resolved';
  pageId: string;
  nodeId: string | null;
  authorName: string;
  preview: string;
  replyCount: number;
  createdAt: number;
  updatedAt: number;
}

export function queryThreads(doc: MarkupDoc, q: ThreadQuery): { threads: ThreadSummary[]; total: number } {
  const status = q.status ?? 'open';
  const resolveUser = (id: string | undefined) => (id === 'current-user' ? q.currentUserId : id);
  const participant = resolveUser(q.participantUserId);
  const author = resolveUser(q.threadAuthorUserId);
  const pageId = q.pageId ?? (q.currentPageOnly ? q.activePageId : undefined);
  const needle = q.search?.trim().toLowerCase();
  const pageOrder = new Map(doc.pages().filter((p) => p.type === 'page').map((p, i) => [p.id, i]));

  const found = listThreads(doc).filter((t) => {
    if (t.messages.length === 0) return false;
    if (status !== 'all' && t.status !== status) return false;
    if (pageId && t.pageId !== pageId) return false;
    if (q.nodeId && t.nodeId !== q.nodeId) return false;
    if (author && t.messages[0]!.authorId !== author) return false;
    if (participant && !t.messages.some((m) => m.authorId === participant)) return false;
    if (needle) {
      const scope = q.searchScope === 'first-message' ? t.messages.slice(0, 1) : t.messages;
      if (!scope.some((m) => m.body.toLowerCase().includes(needle))) return false;
    }
    return true;
  });

  const dir = q.sortDirection === 'desc' ? -1 : 1;
  const field = q.sortField ?? 'page';
  found.sort((a, b) => {
    const d = field === 'page' ? (pageOrder.get(a.pageId) ?? 0) - (pageOrder.get(b.pageId) ?? 0) || a.createdAt - b.createdAt : a[field] - b[field];
    return d * dir;
  });

  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const previewLength = q.previewLength ?? 240;
  const threads = found.slice(offset, offset + limit).map((t) => {
    const first = t.messages[0]!;
    return {
      id: t.id,
      status: t.status,
      pageId: t.pageId,
      nodeId: t.nodeId,
      authorName: first.authorName,
      preview: first.body.length > previewLength ? `${first.body.slice(0, previewLength)}…` : first.body,
      replyCount: t.messages.length - 1,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });
  return { threads, total: found.length };
}

export interface ThreadAuthor {
  userId: string;
  displayName: string;
  threadsStarted: number;
  messagesWritten: number;
  lastActivityAt: number;
}

export function threadAuthors(doc: MarkupDoc, pageId?: string): ThreadAuthor[] {
  const byUser = new Map<string, ThreadAuthor>();
  for (const t of listThreads(doc)) {
    if (pageId && t.pageId !== pageId) continue;
    t.messages.forEach((m, i) => {
      const a = byUser.get(m.authorId) ?? { userId: m.authorId, displayName: m.authorName, threadsStarted: 0, messagesWritten: 0, lastActivityAt: 0 };
      a.messagesWritten++;
      if (i === 0) a.threadsStarted++;
      if (m.createdAt >= a.lastActivityAt) {
        a.lastActivityAt = m.createdAt;
        a.displayName = m.authorName;
      }
      byUser.set(m.authorId, a);
    });
  }
  return [...byUser.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
