import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { copyText } from '../export/clipboard';
import { icons } from '../panels/icons';
import { useDoc } from '../store/DocProvider';
import { SegmentThumb } from '../ui/SegmentThumb';
import { useDismiss } from '../ui/useDismiss';
import { sharedAccount, sharedCloudClient, useAccount } from './account';
import { useShareSync, type FileShare, type ShareExpiry, type ShareLink } from './share';
import { useCloudSync } from './sync';
import './share.css';

const EXPIRIES: { id: ShareExpiry; label: string }[] = [
  { id: 'never', label: 'No expiry' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

/**
 * Share in the top of the right panel: view-only links to the open file. Hidden in builds without
 * accounts (the browser version, forks), like the account card.
 */
export function ShareButton() {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  useDismiss(() => setOpen(false), { ref: menu, enabled: open, blur: false });

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setPos({ top: Math.round(r.bottom + 6), right: Math.max(8, Math.round(window.innerWidth - r.right)) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (account.status === 'off') return null;

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`share-button ${open ? 'is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip={open ? undefined : 'Share a view-only link'}
        onClick={() => setOpen((o) => !o)}
      >
        Share
      </button>
      {open && (
        <div ref={menu} className="share-menu" role="dialog" aria-label="Share this file" style={pos}>
          <ShareBody />
        </div>
      )}
    </>
  );
}

function ShareBody() {
  const account = useAccount();
  const head = (
    <div className="share-head">
      <p className="share-title">Share this file</p>
      <p className="share-sub">Anyone with the link can view every artboard. They can’t edit it or see comments.</p>
    </div>
  );

  if (account.status === 'signedIn') return <SignedIn head={head} />;
  if (account.status === 'signedOut') {
    return (
      <>
        {head}
        <div className="share-section">
          <p className="share-note">Links need a free Markup account, so you can turn them off later.</p>
          <button type="button" className="account-button-primary share-wide" onClick={() => void sharedAccount()?.signIn('login')}>
            Sign in to share
            {icons.external}
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      {head}
      <div className="share-section">
        <p className="share-status">
          <span className="account-spin">{icons.updating}</span>
          {account.status === 'waiting' ? 'Finish signing in in your browser.' : 'Checking your account…'}
        </p>
      </div>
    </>
  );
}

function SignedIn({ head }: { head: ReactNode }) {
  const { doc } = useDoc();
  const fileId = doc.fileId;
  const share = useShareSync();
  const cloud = useCloudSync();
  const state = share?.get(fileId);
  const [expiry, setExpiry] = useState<ShareExpiry>('never');
  const [busy, setBusy] = useState<'create' | string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const inCloud = cloud?.isInCloud(fileId) ?? false;

  useEffect(() => {
    void share?.load(fileId);
  }, [share, fileId, inCloud]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  if (!share || !cloud || !state) {
    return (
      <>
        {head}
        <div className="share-section">
          <p className="share-status">
            <span className="account-spin">{icons.updating}</span>
            Loading…
          </p>
        </div>
      </>
    );
  }

  const copy = async (link: { id: string; url: string }) => {
    try {
      await copyText(link.url);
      setCopied(link.id);
    } catch {
      setError('Could not copy. Select the link and copy it by hand.');
    }
  };

  const create = async () => {
    setBusy('create');
    setError(null);
    try {
      // A link points at the cloud copy, so the file is kept in the cloud first.
      if (!cloud.isInCloud(fileId)) await cloud.enable(fileId);
      if (cloud.status(fileId) === 'full') throw new Error('Your cloud storage is full. Free some space on markup.here to share this file.');
      if (cloud.status(fileId) === 'too-large') throw new Error('This file is too large to keep in the cloud, so it can’t be shared.');
      const url = await share.create(fileId, expiry);
      setAdding(false);
      const id = share.get(fileId).links[0]?.id;
      try {
        await copyText(url);
        if (id) setCopied(id);
      } catch {
        // The link is on screen with its own Copy button.
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the link. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (link: ShareLink) => {
    setBusy(link.id);
    setError(null);
    try {
      await share.revoke(fileId, link.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not turn the link off. Try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ShareLinksView
      head={head}
      state={state}
      inCloud={inCloud}
      expiry={expiry}
      onExpiry={setExpiry}
      busy={busy}
      adding={adding}
      onAdding={setAdding}
      copied={copied}
      error={error}
      manageUrl={`${sharedCloudClient()?.config.siteUrl ?? 'https://markup.here'}/dashboard/shared/`}
      onCreate={() => void create()}
      onCopy={(l) => void copy(l)}
      onRevoke={(l) => void revoke(l)}
      onRetry={() => void share.publish(fileId).catch(() => undefined)}
    />
  );
}

export interface ShareLinksViewProps {
  head: ReactNode;
  state: FileShare;
  inCloud: boolean;
  expiry: ShareExpiry;
  onExpiry(e: ShareExpiry): void;
  /** 'create', a link id being turned off, or null. */
  busy: string | null;
  adding: boolean;
  onAdding(on: boolean): void;
  copied: string | null;
  error: string | null;
  manageUrl: string;
  onCreate(): void;
  onCopy(link: { id: string; url: string }): void;
  onRevoke(link: ShareLink): void;
  onRetry(): void;
}

/** The signed-in share menu, without the wiring: links, the shared view's status, a new link. */
export function ShareLinksView({ head, state, inCloud, expiry, onExpiry, busy, adding, onAdding, copied, error, manageUrl, onCreate, onCopy, onRevoke, onRetry }: ShareLinksViewProps) {
  const showCreate = state.links.length === 0 || adding;
  return (
    <>
      {head}
      {state.loading && inCloud ? (
        <div className="share-section" aria-busy="true">
          <div className="share-skeleton" />
        </div>
      ) : (
        <>
          {state.links.length > 0 && (
            <ul className="share-links" aria-label="Links">
              {state.links.map((link) => (
                <LinkRow key={link.id} link={link} copied={copied === link.id} busy={busy === link.id} onCopy={onCopy} onRevoke={onRevoke} />
              ))}
            </ul>
          )}
          {state.links.length > 0 && <PreviewStatus state={state} onRetry={onRetry} />}
          {showCreate ? (
            <div className="share-section">
              {!inCloud && <p className="share-note">Sharing keeps this file in your cloud, so the link shows your latest changes.</p>}
              <div className="share-field">
                <span className="share-label" id="share-expiry">
                  Link expires
                </span>
                <div className="segmented is-small" role="radiogroup" aria-labelledby="share-expiry">
                  <SegmentThumb />
                  {EXPIRIES.map((e) => (
                    <button key={e.id} type="button" role="radio" aria-checked={expiry === e.id} className={`segment ${expiry === e.id ? 'is-active' : ''}`} onClick={() => onExpiry(e.id)}>
                      {e.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="share-row-actions">
                {adding && (
                  <button type="button" className="account-button-secondary" onClick={() => onAdding(false)} disabled={busy === 'create'}>
                    Cancel
                  </button>
                )}
                <button type="button" className="account-button-primary share-wide" onClick={onCreate} disabled={busy === 'create'} aria-busy={busy === 'create'}>
                  {busy === 'create' ? (
                    <>
                      <span className="account-spin">{icons.updating}</span>
                      {inCloud ? 'Creating link…' : 'Uploading file…'}
                    </>
                  ) : (
                    <>
                      {icons.link}
                      {inCloud ? 'Create link' : 'Keep in cloud and create link'}
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="share-section is-tight">
              <button type="button" className="account-link share-add" onClick={() => onAdding(true)}>
                New link
              </button>
            </div>
          )}
        </>
      )}
      {(error ?? (state.preview !== 'failed' ? state.error : null)) && (
        <p className="share-error" role="alert">
          {icons.alert}
          <span>{error ?? state.error}</span>
        </p>
      )}
      <div className="share-foot">
        <a className="share-manage" href={manageUrl} target="_blank" rel="noreferrer">
          Manage all links
          {icons.external}
        </a>
      </div>
    </>
  );
}

function LinkRow({ link, copied, busy, onCopy, onRevoke }: { link: ShareLink; copied: boolean; busy: boolean; onCopy(l: { id: string; url: string }): void; onRevoke(l: ShareLink): void }) {
  const expires = link.expiresAt ? `Expires ${shortDate(link.expiresAt)}` : 'No expiry';
  return (
    <li className="share-link">
      <span className="share-link-icon">{icons.globe}</span>
      <div className="share-link-text">
        {link.url ? (
          <input className="share-url" value={link.url.replace(/^https:\/\//, '')} readOnly aria-label="Link" onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
        ) : (
          <span className="share-url is-muted">Made on another device</span>
        )}
        <span className="share-link-meta">View only · {expires}</span>
      </div>
      {link.url && (
        <button type="button" className={`share-copy ${copied ? 'is-done' : ''}`} onClick={() => onCopy({ id: link.id, url: link.url! })} aria-label={copied ? 'Link copied' : 'Copy link'}>
          {copied ? icons.check : icons.copy}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      )}
      <button type="button" className="share-off" onClick={() => onRevoke(link)} disabled={busy} data-tip="Turn off. The link stops working right away.">
        {busy ? <span className="account-spin">{icons.updating}</span> : 'Turn off'}
      </button>
    </li>
  );
}

function PreviewStatus({ state, onRetry }: { state: FileShare; onRetry(): void }) {
  if (state.preview === 'failed') {
    return (
      <p className="share-preview is-failed" role="alert">
        {icons.alert}
        <span>{state.error ?? 'The shared view could not be updated.'}</span>
        <button type="button" className="account-link" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  }
  const text =
    state.preview === 'updating'
      ? 'Updating the shared view…'
      : state.preview === 'pending'
        ? 'Your changes show in the link in a few seconds.'
        : state.previewAt
          ? `The link shows this file as of ${timeAgo(state.previewAt)}.`
          : 'Preparing the shared view…';
  return (
    <p className="share-preview" aria-live="polite">
      {state.preview === 'updating' || (!state.previewAt && state.preview === 'idle') ? <span className="account-spin">{icons.updating}</span> : <span className="share-dot" aria-hidden />}
      <span>{text}</span>
    </p>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return shortDate(iso);
}
