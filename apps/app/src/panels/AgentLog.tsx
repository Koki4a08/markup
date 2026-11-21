import { memo, useCallback, useMemo, useState } from 'react';
import { useDoc } from '../store/DocProvider';
import { useLog } from '../store/hooks';

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(3, '0');

/** Rows rendered at first; older entries come in pages of this size on request. */
const PAGE = 200;

/** Every change in the file, newest first, attributed to the person or agent that made it. */
export const AgentLog = memo(function AgentLog() {
  const { doc, actor } = useDoc();
  const log = useLog();
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const entries = useMemo(() => log.slice(Math.max(0, log.length - shown)).reverse(), [log, shown]);
  const older = log.length - entries.length;
  const revert = useCallback(
    (seq: number) => {
      try {
        doc.revertEntry(actor, seq);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [doc, actor],
  );

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
          <HistoryRow key={e.seq} seq={e.seq} at={e.at} actorName={e.actor.name} agent={e.actor.kind === 'agent'} summary={e.summary} reverted={!!e.reverted} onRevert={revert} />
        ))}
      </ol>
      {older > 0 && (
        <button className="text-button" onClick={() => setShown((n) => n + PAGE)}>
          Show older ({older})
        </button>
      )}
    </div>
  );
});

interface RowProps {
  seq: number;
  at: number;
  actorName: string;
  agent: boolean;
  summary: string;
  reverted: boolean;
  onRevert(seq: number): void;
}

const HistoryRow = memo(function HistoryRow({ seq, at, actorName, agent, summary, reverted, onRevert }: RowProps) {
  return (
    <li className={`history-row ${reverted ? 'is-reverted' : ''} ${agent ? 'is-agent' : ''}`}>
      <div className="history-meta">
        <span className="history-seq">No. {pad(seq)}</span>
        <span>{time(at)}</span>
        <span className="history-actor">{actorName}</span>
      </div>
      <div className="history-summary">{summary}</div>
      {reverted ? (
        <span className="history-state">Reverted</span>
      ) : (
        <button className="text-button" onClick={() => onRevert(seq)}>
          Revert
        </button>
      )}
    </li>
  );
});
