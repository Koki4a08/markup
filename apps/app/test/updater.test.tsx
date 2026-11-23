import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createUpdater, isVisible, setSharedUpdater, SNOOZE_MS, type DownloadEvent, type FoundUpdate } from '../src/desktop/updater';
import { UpdateNotice } from '../src/desktop/UpdateNotice';

const release = (version = '0.5.0', install?: FoundUpdate['downloadAndInstall']): FoundUpdate => ({
  version,
  currentVersion: '0.4.2',
  downloadAndInstall: install ?? (async () => undefined),
});

/** Lets pending promises (the check, the install) settle. */
const settle = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

let clock = 0;
beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
  localStorage.clear();
});
afterEach(() => {
  act(() => setSharedUpdater(null));
  vi.useRealTimers();
});

function start(check: () => Promise<FoundUpdate | null>, relaunch = vi.fn(async () => undefined)) {
  const updater = createUpdater({ check, relaunch, now: () => clock });
  act(() => setSharedUpdater(updater));
  render(<UpdateNotice />);
  return { updater, relaunch };
}

describe('isVisible', () => {
  it('hides a snoozed version until the snooze runs out, and never hides a newer one', () => {
    const snooze = { version: '0.5.0', until: 100 };
    expect(isVisible('0.5.0', null, 0)).toBe(true);
    expect(isVisible('0.5.0', snooze, 99)).toBe(false);
    expect(isVisible('0.5.0', snooze, 100)).toBe(true);
    expect(isVisible('0.6.0', snooze, 0)).toBe(true);
  });
});

describe('update notice', () => {
  it('checks on start and every 30 seconds', async () => {
    const check = vi.fn(async () => null);
    start(check);
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(check).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status', { name: 'App update' })).toBeNull();
  });

  it('shows a found release, and closing it brings it back after 30 minutes', async () => {
    start(async () => release());
    await settle();
    expect(screen.getByText('Update available')).toBeTruthy();
    expect(screen.getByText('Version 0.5.0 is out. You have 0.4.2.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(screen.queryByText('Update available')).toBeNull();
    expect(JSON.parse(localStorage.getItem('markup:update-snooze')!)).toEqual({ version: '0.5.0', until: clock + SNOOZE_MS });

    // Still snoozed a minute before the end, even though checks keep running.
    clock += SNOOZE_MS - 60_000;
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(screen.queryByText('Update available')).toBeNull();

    clock += 60_000;
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(screen.getByText('Update available')).toBeTruthy();
  });

  it('Later snoozes too, and a newer release ignores the snooze', async () => {
    let latest = '0.5.0';
    start(async () => release(latest));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByText('Update available')).toBeNull();

    latest = '0.6.0';
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(screen.getByText('Version 0.6.0 is out. You have 0.4.2.')).toBeTruthy();
  });

  it('a snooze survives a restart', async () => {
    localStorage.setItem('markup:update-snooze', JSON.stringify({ version: '0.5.0', until: clock + 1000 }));
    start(async () => release());
    await settle();
    expect(screen.queryByText('Update available')).toBeNull();
  });

  it('downloads with progress, then restarts', async () => {
    let emit: (e: DownloadEvent) => void = () => undefined;
    let finish: () => void = () => undefined;
    const install = (onEvent?: (e: DownloadEvent) => void) =>
      new Promise<void>((resolve) => {
        emit = onEvent!;
        finish = resolve;
      });
    const { relaunch } = start(async () => release('0.5.0', install));
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Update and restart' }));
    act(() => {
      emit({ event: 'Started', data: { contentLength: 40_000_000 } });
      emit({ event: 'Progress', data: { chunkLength: 10_000_000 } });
    });
    expect(screen.getByText('Downloading 0.5.0')).toBeTruthy();
    expect(screen.getByText('10.0 MB of 40.0 MB')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');

    await act(async () => {
      emit({ event: 'Finished' });
      finish();
    });
    expect(screen.getByText('Restarting Markup')).toBeTruthy();
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('a failed install offers Try again', async () => {
    let attempts = 0;
    const install = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('network down');
    };
    const { relaunch } = start(async () => release('0.5.0', install));
    await settle();

    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Update and restart' })));
    expect(screen.getByText('Update failed')).toBeTruthy();
    // A check landing meanwhile does not wipe the error.
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(screen.getByText('Update failed')).toBeTruthy();

    await act(async () => void fireEvent.click(screen.getByRole('button', { name: 'Try again' })));
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the check fails', async () => {
    start(async () => {
      throw new Error('offline');
    });
    await settle();
    expect(screen.queryByRole('status', { name: 'App update' })).toBeNull();
  });
});
