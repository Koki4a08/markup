import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ShareButton, ShareLinksView, type ShareLinksViewProps } from '../src/cloud/ShareButton';
import { setSharedAccount, type Account, type AccountState } from '../src/cloud/account';
import type { FileShare } from '../src/cloud/share';

function fakeAccount(state: AccountState): Account {
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    init: vi.fn(async () => undefined),
    signIn: vi.fn(async () => undefined),
    reopen: vi.fn(),
    cancel: vi.fn(),
    handleUrls: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    uploadUsage: vi.fn(async () => undefined),
    deleteUsage: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

afterEach(() => act(() => setSharedAccount(null)));

const base: FileShare = { loading: false, links: [], preview: 'idle', previewAt: null, error: null };
const link = { id: 'l1', createdAt: '2026-11-26T10:00:00Z', expiresAt: null, revokedAt: null, url: 'https://markup.here/s/#abc' };

function view(over: Partial<ShareLinksViewProps> = {}) {
  const props: ShareLinksViewProps = {
    head: null,
    state: base,
    inCloud: true,
    expiry: 'never',
    onExpiry: vi.fn(),
    busy: null,
    adding: false,
    onAdding: vi.fn(),
    copied: null,
    error: null,
    manageUrl: 'https://markup.here/dashboard/shared/',
    onCreate: vi.fn(),
    onCopy: vi.fn(),
    onRevoke: vi.fn(),
    onRetry: vi.fn(),
    ...over,
  };
  render(<ShareLinksView {...props} />);
  return props;
}

describe('share button', () => {
  it('is hidden in builds without accounts', () => {
    const { container } = render(<ShareButton />);
    expect(container.innerHTML).toBe('');
  });

  it('asks to sign in first', () => {
    const account = fakeAccount({ status: 'signedOut' });
    act(() => setSharedAccount(account));
    render(<ShareButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByRole('dialog', { name: 'Share this file' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Sign in to share/ }));
    expect(account.signIn).toHaveBeenCalledWith('login');
  });
});

describe('share menu', () => {
  it('offers to keep the file in the cloud when it is not there yet', () => {
    const p = view({ inCloud: false });
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    expect(p.onExpiry).toHaveBeenCalledWith('7d');
    fireEvent.click(screen.getByRole('button', { name: /Keep in cloud and create link/ }));
    expect(p.onCreate).toHaveBeenCalled();
  });

  it('lists links with copy and turn off; links made elsewhere cannot be copied', () => {
    const p = view({ state: { ...base, links: [link, { ...link, id: 'l2', url: null }], previewAt: new Date().toISOString() } });
    expect(screen.getAllByRole('button', { name: 'Copy link' })).toHaveLength(1);
    expect(screen.getByText('Made on another device')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(p.onCopy).toHaveBeenCalledWith({ id: 'l1', url: link.url });
    fireEvent.click(screen.getAllByRole('button', { name: 'Turn off' })[0]!);
    expect(p.onRevoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'l1' }));
    expect(screen.getByText(/The link shows this file as of just now/)).toBeTruthy();
  });

  it('shows a failed update with a retry', () => {
    const p = view({ state: { ...base, links: [link], preview: 'failed', error: 'Your cloud storage is full.' } });
    expect(screen.getByRole('alert').textContent).toContain('storage is full');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(p.onRetry).toHaveBeenCalled();
  });
});
