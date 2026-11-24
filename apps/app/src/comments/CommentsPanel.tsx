import { useMemo } from 'react';
import { queryThreads } from '@markup/doc';
import { useDoc } from '../store/DocProvider';
import { usePages } from '../store/hooks';
import { timeAgo, useThreads } from './hooks';
import { isUnread, markSeen, useSeen, type CommentFilter, type SortKey, type StatusFilter } from './state';

export interface CommentsPanelProps {
  activePageId: string;
  filter: CommentFilter;
  onFilter(next: CommentFilter): void;
  selectedId: string | null;
  onSelect(threadId: string): void;
}

const SORTS: { id: SortKey; label: string }[] = [
  { id: 'page', label: 'Page order' },
  { id: 'newest', label: 'Newest' },
  { id: 'activity', label: 'Last activity' },
];

export function CommentsPanel({ activePageId, filter, onFilter, selectedId, onSelect }: CommentsPanelProps) {
  const { doc, actor } = useDoc();
  const threads = useThreads();
  const pages = usePages();
  const seen = useSeen(doc.fileId);
  const set = (patch: Partial<CommentFilter>) => onFilter({ ...filter, ...patch });

  const rows = useMemo(() => {
    const { threads: found } = queryThreads(doc, {
      status: filter.status,
      currentPageOnly: filter.currentPageOnly,
      activePageId,
      currentUserId: actor.id,
      search: filter.search,
      sortField: filter.sort === 'page' ? 'page' : filter.sort === 'newest' ? 'createdAt' : 'updatedAt',
      sortDirection: filter.sort === 'page' ? 'asc' : 'desc',
      limit: 200,
    });
    const byId = new Map(threads.map((t) => [t.id, t]));
    return found.flatMap((s) => byId.get(s.id) ?? []);
  }, [doc, threads, filter, activePageId, actor.id]);

  const pageName = (id: string) => {
    const p = pages.find((x) => x.id === id);
    return p?.type === 'page' ? p.name : 'Page';
  };

  return (
    <div className="comments-panel">
      <div className="comments-tools">
        <label className="search comments-search">
          <input type="search" aria-label="Search comments" placeholder="Search comments" value={filter.search} onChange={(e) => set({ search: e.target.value })} />
        </label>
        <div className="comments-filters">
          <select className="field-input" aria-label="Show" value={filter.status} onChange={(e) => set({ status: e.target.value as StatusFilter })}>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
          <select className="field-input" aria-label="Sort by" value={filter.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <label className="comments-check">
          <input type="checkbox" className="checkbox" checked={filter.currentPageOnly} onChange={(e) => set({ currentPageOnly: e.target.checked })} />
          Current page only
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="empty-hint">{threads.length === 0 ? 'No comments yet. Press C and click the canvas to add one.' : 'No comments match these filters.'}</p>
      ) : (
        <ul className="comment-list" aria-label="Comment threads">
          {rows.map((t) => {
            const first = t.messages[0]!;
            const unread = isUnread(t, seen, actor.id);
            return (
              <li key={t.id}>
                <button
                  className={`comment-row ${t.id === selectedId ? 'is-active' : ''}`}
                  onClick={() => {
                    markSeen(doc.fileId, t);
                    onSelect(t.id);
                  }}
                >
                  <span className="comment-row-head">
                    {unread && <span className="unread-dot" role="img" aria-label="Unread" />}
                    <strong>{first.authorName}</strong>
                    <span className="comment-time">{timeAgo(t.updatedAt)}</span>
                    {t.status === 'resolved' && <span className="comment-status">Resolved</span>}
                  </span>
                  <span className="comment-row-body">{first.body}</span>
                  <span className="comment-row-foot">
                    {t.messages.length > 1 ? `${t.messages.length - 1} ${t.messages.length === 2 ? 'reply' : 'replies'} · ` : ''}
                    {pageName(t.pageId)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
