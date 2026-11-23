import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  changelogUrl,
  compareVersions,
  fetchChanges,
  resetWhatsNew,
  showWhatsNew,
  takePendingVersion,
  type Change,
} from '../src/desktop/whatsNew';
import { setSharedUpdater } from '../src/desktop/updater';
import { UpdateNotice } from '../src/desktop/UpdateNotice';

const changes: Change[] = [
  { kind: 'new', text: 'Delete a page from the Pages panel.' },
  { kind: 'improved', text: 'Resize several layers together.' },
  { kind: 'fixed', text: 'Snapshots fill their artboard.' },
  { kind: 'fixed', text: 'A fourth change the card leaves out.' },
];

const feed = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as Response) as unknown as typeof fetch;

beforeEach(() => {
  localStorage.clear();
  resetWhatsNew();
});
afterEach(() => {
  act(() => {
    resetWhatsNew();
    setSharedUpdater(null);
  });
  vi.restoreAllMocks();
});

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    expect(compareVersions('0.10.0', '0.9.2')).toBe(1);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.3.0', '0.4.0')).toBe(-1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('takePendingVersion', () => {
  it('shows nothing on a fresh install', () => {
    expect(takePendingVersion('0.4.0')).toBeNull();
    expect(takePendingVersion('0.4.0')).toBeNull();
  });

  it('owes a card after an upgrade, until it is dismissed', () => {
    takePendingVersion('0.4.0');
    expect(takePendingVersion('0.5.0')).toBe('0.5.0');
    // Still owed on the next launch if the user never closed it.
    expect(takePendingVersion('0.5.0')).toBe('0.5.0');
    localStorage.removeItem('markup:whats-new');
    expect(takePendingVersion('0.5.0')).toBeNull();
  });

  it('treats a user of a version without this card (0.3.0 and older) as upgrading', () => {
    localStorage.setItem('markup:tabs', '[]');
    expect(takePendingVersion('0.4.0')).toBe('0.4.0');
  });

  it('shows nothing after a downgrade', () => {
    takePendingVersion('0.5.0');
    expect(takePendingVersion('0.4.0')).toBeNull();
  });
});

describe('fetchChanges', () => {
  it('returns the changes of the matching release', async () => {
    const fetcher = feed({ releases: [{ version: '0.5.0', changes }, { version: '0.4.0', changes: [] }] });
    expect(await fetchChanges('0.5.0', fetcher)).toEqual(changes);
  });

  it('returns null when the site has no entry, answers badly, or is offline', async () => {
    expect(await fetchChanges('0.6.0', feed({ releases: [{ version: '0.5.0', changes }] }))).toBeNull();
    expect(await fetchChanges('0.5.0', feed({}, false))).toBeNull();
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await fetchChanges('0.5.0', offline)).toBeNull();
  });
});

describe("what's new card", () => {
  it('lists the top three changes and opens the changelog at the version', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    localStorage.setItem('markup:whats-new', '0.5.0');
    render(<UpdateNotice />);
    await act(() => showWhatsNew('0.5.0', feed({ releases: [{ version: '0.5.0', changes }] })));

    expect(screen.getByText('Markup 0.5.0 is installed')).toBeTruthy();
    expect(screen.getByText('Delete a page from the Pages panel.')).toBeTruthy();
    expect(screen.queryByText('A fourth change the card leaves out.')).toBeNull();

    fireEvent.click(screen.getByText('See the changelog'));
    expect(open).toHaveBeenCalledWith(changelogUrl('0.5.0'), '_blank');
    expect(changelogUrl('0.5.0')).toBe('https://markup.here/changelog/#v0.5.0');
    expect(screen.queryByRole('status', { name: "What's new" })).toBeNull();
    expect(localStorage.getItem('markup:whats-new')).toBeNull();
  });

  it('still offers the changelog when the site cannot be reached, and closes for good', async () => {
    localStorage.setItem('markup:whats-new', '0.5.0');
    render(<UpdateNotice />);
    await act(() => showWhatsNew('0.5.0', feed({}, false)));

    expect(screen.getByText('See what changed in this version.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('status', { name: "What's new" })).toBeNull();
    expect(localStorage.getItem('markup:whats-new')).toBeNull();
  });
});
