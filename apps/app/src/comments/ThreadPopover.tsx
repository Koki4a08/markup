import { useEffect, useRef, useState } from 'react';
import type { CommentThread } from '@markup/doc';
import { useDoc } from '../store/DocProvider';
import { timeAgo } from './hooks';
import { lastMessage, markSeen } from './state';
import { icons } from '../panels/icons';

const QUICK_REACTIONS = ['👍', '❤️', '🎉'];

interface Props {
  /** Existing thread, or null for a draft pin that has no message yet. */
  thread: CommentThread | null;
  /** Screen-space position of the pin it hangs off. */
  left: number;
  top: number;
  onClose(): void;
  onCreate(body: string): void;
}

export function ThreadPopover({ thread, left, top, onClose, onCreate }: Props) {
  const { doc, actor } = useDoc();
  const [body, setBody] = useState('');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const lastAt = thread ? lastMessage(thread)?.createdAt : undefined;

  useEffect(() => {
    boxRef.current?.focus();
  }, [thread?.id]);
  // Reading the thread while it is open keeps new replies from turning into unread dots.
  useEffect(() => {
    if (thread) markSeen(doc.fileId, thread);
  }, [doc, thread, lastAt]);

  const send = () => {
    const text = body.trim();
    if (!text) return;
    if (thread) doc.reply(actor, thread.id, text);
    else onCreate(text);
    setBody('');
  };

  return (
    <div
      className="comment-popover"
      role="dialog"
      aria-label={thread ? 'Comment thread' : 'New comment'}
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="comment-popover-head">
        <span className="comment-popover-title">{thread ? (thread.status === 'resolved' ? 'Resolved' : 'Comment') : 'New comment'}</span>
        {thread && (
          <button className="comment-button" onClick={() => {
              const resolving = thread.status === 'open';
              doc.setThreadStatus(actor, thread.id, resolving ? 'resolved' : 'open');
              if (resolving) onClose();
            }}>
            {thread.status === 'open' ? 'Resolve' : 'Reopen'}
          </button>
        )}
        <button className="icon-button" aria-label="Close comment" onClick={onClose}>
          {icons.close}
        </button>
      </div>
      {thread && (
        <ul className="comment-messages">
          {thread.messages.map((m) => (
            <li key={m.id} className="comment-message">
              <div className="comment-meta">
                <strong>{m.authorName}</strong>
                <span className="comment-time">{timeAgo(m.createdAt)}</span>
                {m.authorId === actor.id && (
                  <button className="icon-button" aria-label="Delete message" title="Delete message" onClick={() => doc.deleteMessage(actor, thread.id, m.id)}>
                    {icons.trash}
                  </button>
                )}
              </div>
              <p className="comment-body">{m.body}</p>
              <div className="comment-reactions">
                {QUICK_REACTIONS.map((emoji) => {
                  const users = m.reactions[emoji] ?? [];
                  const mine = users.includes(actor.id);
                  return (
                    <button key={emoji} className={`reaction ${mine ? 'is-mine' : ''}`} aria-pressed={mine} aria-label={`React ${emoji}`} onClick={() => doc.react(actor, thread.id, m.id, emoji)}>
                      {emoji}
                      {users.length > 0 && <span className="reaction-count">{users.length}</span>}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="comment-composer">
        <textarea
          ref={boxRef}
          aria-label={thread ? 'Reply' : 'Add a comment'}
          placeholder={thread ? 'Reply…' : 'Add a comment…'}
          rows={2}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="comment-button is-primary" disabled={!body.trim()} onClick={send}>
          {thread ? 'Reply' : 'Comment'}
        </button>
      </div>
    </div>
  );
}
