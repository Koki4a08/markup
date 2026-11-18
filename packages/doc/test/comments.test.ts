import { describe, expect, it } from 'vitest';
import { MarkupDoc, queryThreads, runDocTool, threadAuthors, type Actor } from '../src/index';

const ana: Actor = { id: 'local-user', kind: 'human', name: 'Ana' };
const bo: Actor = { id: 'u2', kind: 'human', name: 'Bo' };
const agent: Actor = { id: 'a1', kind: 'agent', name: 'Claude Code' };

function setup() {
  const doc = new MarkupDoc({ name: 'F' });
  const page = doc.pages()[0]!;
  if (page.type !== 'page') throw new Error('unreachable');
  const q = (extra: Record<string, unknown> = {}) => queryThreads(doc, { activePageId: page.id, currentUserId: ana.id, ...extra });
  return { doc, pageId: page.id, q };
}

describe('comments', () => {
  it('create and reply', () => {
    const { doc, pageId } = setup();
    const id = doc.createThread(ana, { pageId, nodeId: null, x: 10, y: 20, body: 'Make it bigger' });
    const mid = doc.reply(bo, id, 'Agreed');
    const [t] = doc.threads();
    expect(t).toMatchObject({ id, pageId, nodeId: null, x: 10, y: 20, status: 'open' });
    expect(t!.messages.map((m) => [m.authorId, m.body])).toEqual([['local-user', 'Make it bigger'], ['u2', 'Agreed']]);
    expect(t!.messages[1]!.id).toBe(mid);
    expect(doc.log().map((e) => e.summary)).toEqual(['Commented', 'Replied to comment']);
    expect(() => doc.reply(ana, 'nope', 'x')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
    expect(doc.threads()).toHaveLength(1);
  });

  it('list defaults to open threads', () => {
    const { doc, pageId, q } = setup();
    const a = doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: 'one' });
    doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: 'two' });
    doc.setThreadStatus(ana, a, 'resolved');
    expect(q().threads.map((t) => t.preview)).toEqual(['two']);
    expect(q({ status: 'resolved' }).total).toBe(1);
    expect(q({ status: 'all' }).total).toBe(2);
    expect(doc.log().map((e) => e.summary)).toContain('Resolved comment');
  });

  it('search all messages vs first message', () => {
    const { doc, pageId, q } = setup();
    const id = doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: 'Spacing looks off' });
    doc.reply(bo, id, 'The Padding is wrong');
    expect(q({ search: 'padding' }).total).toBe(1);
    expect(q({ search: 'padding', searchScope: 'first-message' }).total).toBe(0);
    expect(q({ search: 'spacing', searchScope: 'first-message' }).total).toBe(1);
  });

  it('current-user filter', () => {
    const { doc, pageId, q } = setup();
    doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: 'mine' });
    const other = doc.createThread(bo, { pageId, nodeId: null, x: 0, y: 0, body: 'theirs' });
    doc.reply(ana, other, 'I joined');
    expect(q({ threadAuthorUserId: 'current-user' }).threads.map((t) => t.preview)).toEqual(['mine']);
    expect(q({ participantUserId: 'current-user' }).total).toBe(2);
    expect(q({ participantUserId: 'u2' }).total).toBe(1);
  });

  it('pagination', () => {
    const { doc, pageId, q } = setup();
    for (let i = 0; i < 5; i++) doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: `t${i}` });
    const first = q({ limit: 2, sortField: 'createdAt' });
    expect(first.total).toBe(5);
    expect(first.threads).toHaveLength(2);
    expect(q({ limit: 2, offset: 4, sortField: 'createdAt' }).threads).toHaveLength(1);
    expect(q({ limit: 500 }).threads).toHaveLength(5);
    const long = doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: 'x'.repeat(100) });
    expect(q({ previewLength: 20, search: 'xxx' }).threads.find((t) => t.id === long)!.preview.length).toBeLessThanOrEqual(21);
  });

  it('sorts by page order then createdAt', () => {
    const { doc, pageId, q } = setup();
    const p2 = doc.createPage(ana, { name: 'Two' });
    doc.createThread(ana, { pageId: p2, nodeId: null, x: 0, y: 0, body: 'on two' });
    doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: 'on one' });
    expect(q().threads.map((t) => t.preview)).toEqual(['on one', 'on two']);
    expect(q({ sortDirection: 'desc' }).threads.map((t) => t.preview)).toEqual(['on two', 'on one']);
    expect(q({ currentPageOnly: true }).total).toBe(1);
  });

  it('authors counts exclude deleted', () => {
    const { doc, pageId } = setup();
    const t1 = doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: 'a' });
    const m = doc.reply(bo, t1, 'b');
    doc.reply(bo, t1, 'c');
    const t2 = doc.createThread(bo, { pageId, nodeId: null, x: 0, y: 0, body: 'd' });
    doc.deleteMessage(bo, t1, m);
    let authors = threadAuthors(doc);
    expect(authors.find((a) => a.userId === 'u2')).toMatchObject({ threadsStarted: 1, messagesWritten: 2, displayName: 'Bo' });
    expect(authors.find((a) => a.userId === 'local-user')).toMatchObject({ threadsStarted: 1, messagesWritten: 1 });
    doc.deleteMessage(bo, t2, doc.threads().find((t) => t.id === t2)!.messages[0]!.id);
    authors = threadAuthors(doc);
    expect(authors.find((a) => a.userId === 'u2')).toMatchObject({ threadsStarted: 0, messagesWritten: 1 });
    expect(doc.threads()).toHaveLength(1);
    expect(() => doc.setThreadStatus(ana, t2, 'resolved')).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });

  it('react toggles and comments are undoable per actor', () => {
    const { doc, pageId } = setup();
    const id = doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: 'hi' });
    const mid = doc.threads()[0]!.messages[0]!.id;
    doc.react(bo, id, mid, '👍');
    expect(doc.threads()[0]!.messages[0]!.reactions).toEqual({ '👍': ['u2'] });
    doc.react(bo, id, mid, '👍');
    expect(doc.threads()[0]!.messages[0]!.reactions).toEqual({});
    const entry = doc.log().find((e) => e.summary === 'Commented')!;
    doc.revertEntry(ana, entry.seq);
    expect(doc.threads()).toHaveLength(0);
  });

  it('resolve via tool logs the agent', () => {
    const { doc, pageId } = setup();
    const id = doc.createThread(ana, { pageId, nodeId: null, x: 0, y: 0, body: 'fix the header' });
    const run = (m: Parameters<typeof runDocTool>[2], p: unknown) => runDocTool(doc, agent, m, p, { activePageId: pageId, currentUserId: ana.id });
    expect((run('list_comment_threads', {}) as { total: number }).total).toBe(1);
    expect((run('list_comment_threads', { threadAuthorUserId: 'current-user' }) as { total: number }).total).toBe(1);
    run('set_comment_thread_status', { commentThreadId: id, status: 'resolved' });
    expect((run('list_comment_threads', {}) as { total: number }).total).toBe(0);
    expect(run('get_comment_thread', { commentThreadId: id })).toMatchObject({ id, status: 'resolved', pageName: 'Page 1' });
    expect(run('list_comment_thread_authors', {})).toEqual([expect.objectContaining({ userId: 'local-user', displayName: 'Ana' })]);
    const last = doc.log().at(-1)!;
    expect(last).toMatchObject({ summary: 'Resolved comment', actor: { id: 'a1', kind: 'agent' } });
    expect(() => run('get_comment_thread', { commentThreadId: 'zzz' })).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});
