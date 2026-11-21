import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { getThemePreference, resolveTheme, setThemePreference } from '../src/ui/theme';
import { SettingsMenu } from '../src/ui/SettingsMenu';

afterEach(() => {
  setThemePreference('dark');
  vi.unstubAllGlobals();
});

describe('theme', () => {
  it('applies and remembers the chosen theme', () => {
    setThemePreference('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('markup:theme')).toBe('light');
    setThemePreference('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('System follows the operating system', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('light'), addEventListener() {}, removeEventListener() {} }));
    expect(resolveTheme('system')).toBe('light');
  });

  it('the Settings panel switches the theme', () => {
    render(<SettingsMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('radio', { name: /Light/ }));
    expect(getThemePreference()).toBe('light');
    expect(screen.getByRole('radio', { name: /Light/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
  });
});
