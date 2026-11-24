import { memo, useState, type ReactNode } from 'react';
import { AgentLog } from './AgentLog';
import { icons } from './icons';
import { Inspector } from './Inspector';
import { ThemePanel } from './ThemePanel';
import { CommentsPanel, type CommentsPanelProps } from '../comments/CommentsPanel';
import { useThreads } from '../comments/hooks';
import { SegmentThumb } from '../ui/SegmentThumb';

type Tab = 'design' | 'theme' | 'comments' | 'history';

/**
 * Right panel: Design (the selection's styles) and Theme (the selection's colours and type, and the file's tokens) as the main switch;
 * Comments and History sit beside it as icon tabs.
 */
export const RightPanel = memo(function RightPanel({
  comments,
  resizer,
  pageRootId = '',
  top,
  noSelection,
}: {
  comments: CommentsPanelProps;
  resizer?: ReactNode;
  pageRootId?: string;
  /** Above the tabs: agent status and zoom. */
  top?: ReactNode;
  /** Design tab content while nothing is selected. */
  noSelection?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('design');
  const open = useThreads().filter((t) => t.status === 'open').length;
  const tabProps = (t: Tab) => ({ role: 'tab' as const, 'aria-selected': tab === t, onClick: () => setTab(t) });

  return (
    <aside className="panel inspector" aria-label="Design, theme, comments and history">
      {resizer}
      {top}
      <div className="panel-tabs" role="tablist">
        <div className="segmented">
          <SegmentThumb />
          <button {...tabProps('design')} className={`segment ${tab === 'design' ? 'is-active' : ''}`}>
            Design
          </button>
          <button {...tabProps('theme')} className={`segment ${tab === 'theme' ? 'is-active' : ''}`}>
            Theme
          </button>
        </div>
        <button {...tabProps('comments')} className={`icon-tab ${tab === 'comments' ? 'is-active' : ''}`} aria-label={open ? `Comments, ${open} open` : 'Comments'} data-tip="Comments">
          {icons.comment}
          {open > 0 && (
            <span className="tab-count" aria-hidden>
              {open}
            </span>
          )}
        </button>
        <button {...tabProps('history')} className={`icon-tab ${tab === 'history' ? 'is-active' : ''}`} aria-label="History" data-tip="History">
          {icons.history}
        </button>
      </div>
      <div role="tabpanel" className="panel-body" key={tab}>
        {tab === 'design' ? <Inspector empty={noSelection} /> : tab === 'theme' ? <ThemePanel pageRootId={pageRootId} /> : tab === 'comments' ? <CommentsPanel {...comments} /> : <AgentLog />}
      </div>
    </aside>
  );
});
