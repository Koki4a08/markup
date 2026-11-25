import { useEffect, useRef, useState, type ReactNode } from 'react';
import { icons } from '../panels/icons';
import { useDismiss } from '../ui/useDismiss';
import { sharedAccount, useAccount, type AccountState, type AccountUser } from './account';
import { useCloudSync } from './sync';
import { deleteUsageStats, setUsageSyncEnabled, useUsageSyncEnabled } from './usage';
import './account.css';

/**
 * The account, pinned to the bottom of the Files sidebar. Hidden entirely in builds without
 * account settings and in the browser version.
 */
export function AccountCard() {
  const state = useAccount();
  if (state.status === 'off') return null;
  return (
    <div className="dashboard-account">
      <div className={`account-card is-${state.status}`}>
        <CardBody state={state} />
      </div>
    </div>
  );
}

function CardBody({ state }: { state: AccountState }) {
  const account = sharedAccount();
  switch (state.status) {
    case 'off':
      return null;
    case 'loading':
      return <Head icon={<Spinner />} title="Checking your account…" />;
    case 'signedOut':
      return (
        <>
          <Head icon={<Avatar user={null} />} title="Sign in to Markup">
            Optional. Everything works without it.
          </Head>
          {state.error && <ErrorNote message={state.error} />}
          <div className="account-actions is-stacked">
            <button className="account-button-primary" onClick={() => void account?.signIn('login')}>
              Sign in
              {icons.external}
            </button>
            <button className="account-link" onClick={() => void account?.signIn('signup')}>
              Create an account
            </button>
          </div>
        </>
      );
    case 'waiting':
      return (
        <>
          <Head icon={<Spinner />} title="Finish in your browser">
            Sign in on markup.here, then choose Open Markup.
          </Head>
          <div className="account-actions">
            <button className="account-link" onClick={() => account?.reopen()}>
              Open again
            </button>
            <button className="account-button-secondary" onClick={() => account?.cancel()}>
              Cancel
            </button>
          </div>
        </>
      );
    case 'finishing':
      return <Head icon={<Spinner />} title="Signing in…" />;
    case 'signedIn':
      return <SignedIn user={state.user} signingOut={!!state.signingOut} error={state.error} />;
  }
}

/** Signed in: who, and a menu with the usage setting and Sign out. */
function SignedIn({ user, signingOut, error }: { user: AccountUser; signingOut: boolean; error?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(() => setOpen(false), { ref, enabled: open });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        className={`account-identity ${open ? 'is-open' : ''}`}
        aria-label={`Account: ${user.name ?? user.email}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar user={user} />
        <span className="account-identity-text">
          <strong>{user.name ?? user.email}</strong>
          {user.name && <span>{user.email}</span>}
        </span>
        <span className="account-identity-more">{icons.more}</span>
      </button>
      <StorageMeter />
      {error && <ErrorNote message={error} />}
      {open && (
        <div ref={ref} className="account-pop" role="dialog" aria-label="Account">
          <UsageSetting />
          <div className="account-pop-sep" />
          <button className="account-pop-item" onClick={() => void sharedAccount()?.signOut()} disabled={signingOut}>
            {signingOut ? <Spinner bare /> : icons.signOut}
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </>
  );
}

/** Cloud storage used of the plan's quota, once the first count arrives. */
function StorageMeter() {
  const usage = useCloudSync()?.usage();
  if (!usage || usage.quota <= 0) return null;
  const share = Math.min(1, usage.used / usage.quota);
  return (
    <div className="account-storage">
      <div className="account-storage-text">
        <span>Cloud storage</span>
        <span className="is-numeric">
          {formatBytes(usage.used)} of {formatBytes(usage.quota)}
        </span>
      </div>
      <div
        className={`account-storage-bar ${share >= 0.9 ? 'is-near-full' : ''}`}
        role="meter"
        aria-label="Cloud storage used"
        aria-valuemin={0}
        aria-valuemax={usage.quota}
        aria-valuenow={usage.used}
      >
        <span style={{ width: `${Math.max(share * 100, usage.used > 0 ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}

/** 1.2 MB, 500 MB, 20 GB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "Save my usage stats" switch, and deleting what was saved (two clicks). */
function UsageSetting() {
  const enabled = useUsageSyncEnabled();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 4000);
    return () => clearTimeout(timer);
  }, [confirming]);

  async function remove() {
    if (!confirming) return setConfirming(true);
    setBusy(true);
    setNote(null);
    try {
      await deleteUsageStats();
      setNote('Usage stats deleted.');
    } catch {
      setNote('Couldn’t delete them. Check your connection and try again.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="account-pop-section">
      <label className="account-switch">
        <span className="account-switch-text">
          <strong>Save my usage stats</strong>
          <span>Daily counts for your own activity view: active time, edits, agent calls, exports. Never file contents.</span>
        </span>
        <input type="checkbox" role="switch" checked={enabled} onChange={(e) => setUsageSyncEnabled(e.target.checked)} />
      </label>
      <button className={`account-pop-item ${confirming ? 'is-danger' : ''}`} onClick={() => void remove()} disabled={busy}>
        {busy ? <Spinner bare /> : icons.trash}
        {confirming ? 'Click again to delete' : 'Delete saved stats'}
      </button>
      {note && (
        <p className="account-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

function Head({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="account-row" role="status" aria-live="polite">
      {icon}
      <div className="account-row-text">
        <strong>{title}</strong>
        {children && <span>{children}</span>}
      </div>
    </div>
  );
}

function Spinner({ bare }: { bare?: boolean }) {
  if (bare) return <span className="account-spin">{icons.updating}</span>;
  return <span className="account-tile account-spin">{icons.updating}</span>;
}

function ErrorNote({ message }: { message: string }) {
  return (
    <p className="account-error" role="alert">
      {icons.alert}
      {message}
    </p>
  );
}

/** The profile photo when there is one, else the orb (the app's accent, as on the website). */
function Avatar({ user }: { user: AccountUser | null }) {
  const [failed, setFailed] = useState(false);
  if (user?.avatar && !failed) {
    return <img className="account-avatar" src={user.avatar} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  }
  return <span className="account-avatar account-orb" aria-hidden />;
}
