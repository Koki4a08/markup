import { useState } from 'react';
import { useDoc } from '../store/DocProvider';
import { useLog } from '../store/hooks';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(3, '0');

/** Every change in the file, newest first, attributed to the person or agent that made it. */
export function AgentLog() {
  const { doc, actor } = useDoc();
  const log = useLog();
  const [error, setError] = useState<string | null>(null);
  const entries = log.slice().reverse();

  return (
    <div className="history">
      {error && (
        <p className="history-error" role="alert">
          {error}
        </p>
      )}
      {entries.length === 0 && <p className="empty-hint">Changes you and connected agents make appear here, newest first.</p>}
      <ol className="history-list">
        {entries.map((e) => (
          <li key={e.seq} className={`history-row ${e.reverted ? 'is-reverted' : ''} ${e.actor.kind === 'agent' ? 'is-agent' : ''}`}>
            <div className="history-meta">
              <span className="history-seq">No. {pad(e.seq)}</span>
              <span>{time(e.at)}</span>
              <span className="history-actor">{e.actor.name}</span>
            </div>
            <div className="history-summary">{e.summary}</div>
            {e.reverted ? (
              <span className="history-state">Reverted</span>
            ) : (
              <button
                className="text-button"
                onClick={() => {
                  try {
                    doc.revertEntry(actor, e.seq);
                    setError(null);
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              >
                Revert
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
