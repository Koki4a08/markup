import { icons } from '../panels/icons';
import { useUpdater, type UpdateState } from './updater';
import { changelogUrl, dismissWhatsNew, openChangelog, useWhatsNew, type ChangeKind } from './whatsNew';

const mb = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * The "new version" card. It sits at the bottom right of the canvas (or of the window on the
 * dashboard), never takes focus, and stays until the user updates, closes it, or picks Later.
 */
export function UpdateNotice() {
  const live = useUpdater();
  const whatsNew = useWhatsNew();
  // An offer of a newer version wins; "What's new" for the installed one waits behind it.
  if (!live || !live.shown) return whatsNew.status === 'shown' ? <WhatsNew version={whatsNew.version} changes={whatsNew.changes} /> : null;
  const { updater, state } = live;
  return (
    <section className={`update-notice is-${state.status}`} role="status" aria-live="polite" aria-label="App update">
      <Body state={state} onInstall={() => void updater.install()} onSnooze={() => updater.snooze()} />
    </section>
  );
}

function Body({ state, onInstall, onSnooze }: { state: UpdateState; onInstall(): void; onSnooze(): void }) {
  const close = (
    <button className="icon-button update-notice-close" aria-label="Close, remind me in 30 minutes" data-tip="Remind me in 30 min" onClick={onSnooze}>
      {icons.dismiss}
    </button>
  );
  switch (state.status) {
    case 'available':
      return (
        <>
          <div className="update-notice-head">
            <span className="update-notice-icon">{icons.update}</span>
            <div className="update-notice-text">
              <strong>Update available</strong>
              <span>
                Version {state.version} is out. You have {state.currentVersion}.
              </span>
            </div>
            {close}
          </div>
          <div className="update-notice-actions">
            <button className="update-notice-link" onClick={() => window.open(changelogUrl(state.version), '_blank')}>
              What's new
            </button>
            <span className="update-notice-buttons">
              <button className="update-notice-button" onClick={onSnooze}>
                Later
              </button>
              <button className="update-notice-button is-primary" onClick={onInstall}>
                Update and restart
              </button>
            </span>
          </div>
        </>
      );
    case 'downloading': {
      const pct = state.total ? Math.min(100, Math.round((state.downloaded / state.total) * 100)) : null;
      return (
        <>
          <div className="update-notice-head">
            <span className="update-notice-icon is-spinning">{icons.updating}</span>
            <div className="update-notice-text">
              <strong>Downloading {state.version}</strong>
              <span className="is-numeric">{state.total ? `${mb(state.downloaded)} of ${mb(state.total)}` : mb(state.downloaded)}</span>
            </div>
            {pct !== null && <span className="update-notice-pct">{pct}%</span>}
          </div>
          <div
            className="update-notice-progress"
            role="progressbar"
            aria-label={`Downloading ${state.version}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct ?? undefined}
          >
            <span className={pct === null ? 'is-indeterminate' : undefined} style={pct === null ? undefined : { width: `${pct}%` }} />
          </div>
        </>
      );
    }
    case 'installing':
      return (
        <div className="update-notice-head">
          <span className="update-notice-icon is-success">{icons.updated}</span>
          <div className="update-notice-text">
            <strong>Restarting Markup</strong>
            <span>Installing {state.version}. Markup reopens in a moment.</span>
          </div>
        </div>
      );
    case 'error':
      return (
        <>
          <div className="update-notice-head">
            <span className="update-notice-icon is-danger">{icons.alert}</span>
            <div className="update-notice-text">
              <strong>Update failed</strong>
              <span>Could not install {state.version}. Check your connection.</span>
            </div>
            {close}
          </div>
          <div className="update-notice-actions is-end">
            <button className="update-notice-button" onClick={onInstall}>
              Try again
            </button>
          </div>
        </>
      );
    default:
      return null;
  }
}

/** Shown once after Markup opens on a newer version, until closed or the changelog is opened. */
function WhatsNew({ version, changes }: { version: string; changes: { kind: ChangeKind; text: string }[] | null }) {
  return (
    <section className="update-notice is-whats-new" role="status" aria-live="polite" aria-label="What's new">
      <div className="update-notice-head">
        <span className="update-notice-icon">{icons.whatsNew}</span>
        <div className="update-notice-text">
          <strong>Markup {version} is installed</strong>
          <span>{changes ? 'Here is what changed.' : 'See what changed in this version.'}</span>
        </div>
        <button className="icon-button update-notice-close" aria-label="Close" data-tip="Close" onClick={dismissWhatsNew}>
          {icons.dismiss}
        </button>
      </div>
      {changes && (
        <ul className="update-notice-changes">
          {changes.slice(0, 3).map((change) => (
            <li key={change.text} className={`is-${change.kind}`}>
              {change.text}
            </li>
          ))}
        </ul>
      )}
      <div className="update-notice-actions is-end">
        <button className="update-notice-button is-primary" onClick={() => openChangelog(version)}>
          See the changelog
        </button>
      </div>
    </section>
  );
}
