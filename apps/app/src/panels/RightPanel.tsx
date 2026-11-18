import { useState } from 'react';
import { AgentLog } from './AgentLog';
import { Inspector } from './Inspector';

type Tab = 'design' | 'history';

export function RightPanel() {
  const [tab, setTab] = useState<Tab>('design');
  return (
    <aside className="panel inspector" aria-label="Design and history">
      <div className="tabs" role="tablist">
        {(['design', 'history'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'is-active' : ''}`} onClick={() => setTab(t)}>
            {t === 'design' ? 'Design' : 'History'}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tab === 'design' ? <Inspector /> : <AgentLog />}</div>
    </aside>
  );
}
