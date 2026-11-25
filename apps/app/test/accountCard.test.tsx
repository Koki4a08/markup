import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AccountCard } from '../src/cloud/AccountCard';
import { setSharedAccount, type Account, type AccountState } from '../src/cloud/account';
import { usageSyncEnabled } from '../src/cloud/usage';

/** An Account whose state the test sets by hand. */
function fakeAccount(initial: AccountState) {
  let state = initial;
  const listeners = new Set<() => void>();
  const account: Account = {
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
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
  const set = (next: AccountState) => {
    state = next;
    listeners.forEach((l) => l());
  };
  return { account, set };
}

const JANE: AccountState = { status: 'signedIn', user: { id: 'u1', email: 'jane@example.com', name: 'Jane Doe', avatar: null } };

beforeEach(() => localStorage.clear());
afterEach(() => act(() => setSharedAccount(null)));

describe('account card', () => {
  it('renders nothing when accounts are off (browser, or a build without settings)', () => {
    const { container } = render(<AccountCard />);
    expect(container.innerHTML).toBe('');
  });

  it('offers browser sign-in and sign-up when signed out', () => {
    const { account } = fakeAccount({ status: 'signedOut' });
    act(() => setSharedAccount(account));
    render(<AccountCard />);
    expect(screen.getByText('Sign in to Markup')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Sign in/ }));
    expect(account.signIn).toHaveBeenCalledWith('login');
    fireEvent.click(screen.getByRole('button', { name: 'Create an account' }));
    expect(account.signIn).toHaveBeenCalledWith('signup');
  });

  it('shows the wait for the browser, with open again and cancel', () => {
    const { account } = fakeAccount({ status: 'waiting', url: 'https://markup.here/login/?client=desktop' });
    act(() => setSharedAccount(account));
    render(<AccountCard />);
    expect(screen.getByText('Finish in your browser')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open again' }));
    expect(account.reopen).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(account.cancel).toHaveBeenCalled();
  });

  it('shows who is signed in; the menu signs out', () => {
    const { account, set } = fakeAccount(JANE);
    act(() => setSharedAccount(account));
    render(<AccountCard />);
    expect(screen.getByText('jane@example.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Account: Jane Doe' }));
    fireEvent.click(screen.getByRole('button', { name: /Sign out/ }));
    expect(account.signOut).toHaveBeenCalled();
    act(() => set({ status: 'signedOut', error: 'Sign-in timed out. Try again.' }));
    expect(screen.getByRole('alert').textContent).toContain('Sign-in timed out');
  });

  it('turns saving usage stats off and on', () => {
    const { account } = fakeAccount(JANE);
    act(() => setSharedAccount(account));
    render(<AccountCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Account: Jane Doe' }));
    const toggle = screen.getByRole('switch', { name: /Save my usage stats/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(usageSyncEnabled()).toBe(false);
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(usageSyncEnabled()).toBe(true);
  });

  it('deletes saved stats only on the second click', async () => {
    const { account } = fakeAccount(JANE);
    act(() => setSharedAccount(account));
    render(<AccountCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Account: Jane Doe' }));
    fireEvent.click(screen.getByRole('button', { name: /Delete saved stats/ }));
    expect(account.deleteUsage).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(screen.getByRole('button', { name: /Click again to delete/ })));
    expect(account.deleteUsage).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Usage stats deleted.')).toBeTruthy();
  });

  it('closes the menu on Escape and gives focus back', () => {
    const { account } = fakeAccount(JANE);
    act(() => setSharedAccount(account));
    render(<AccountCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Account: Jane Doe' }));
    expect(screen.getByRole('dialog', { name: 'Account' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Account' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Account: Jane Doe' }));
  });
});
