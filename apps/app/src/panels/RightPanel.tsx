import { useState } from 'react';
import { AgentLog } from './AgentLog';
import { Inspector } from './Inspector';
import { CommentsPanel, type CommentsPanelProps } from '../comments/CommentsPanel';
import { useThreads } from '../comments/hooks';

type Tab = 'design' | 'comments' | 'history';
const LABELS: Record<Tab, string> = { design: 'Design', comments: 'Comments', history: 'History' };

export function RightPanel({ comments }: { comments: CommentsPanelProps }) {
  const [tab, setTab] = useState<Tab>('design');
  const open = useThreads().filter((t) => t.status === 'open').length;
  return (
    <aside className="panel inspector" aria-label="Design, comments and history">
      <div className="tabs" role="tablist">
        {(['design', 'comments', 'history'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
            {LABELS[t]}
            {t === 'comments' && open > 0 ? ` (${open})` : ''}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tab === 'design' ? <Inspector /> : tab === 'comments' ? <CommentsPanel {...comments} /> : <AgentLog />}</div>
    </aside>
  );
}
