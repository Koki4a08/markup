import { useSyncExternalStore } from 'react';
import { setWindowTheme } from '../desktop/native';

/**
 * The editor's colour theme: dark, light, or following the system. A per-machine preference kept in
 * localStorage and applied as `data-theme` on <html>, which swaps the UI tokens in styles.css. Design
 * content on the canvas keeps its own colours whatever the theme.
 */
export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'markup:theme';
const listeners = new Set<() => void>();

function stored(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

let preference: ThemePreference = typeof window === 'undefined' ? 'dark' : stored();

const systemQuery = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null);

export function resolveTheme(pref: ThemePreference = preference): Theme {
  if (pref !== 'system') return pref;
  return systemQuery()?.matches ? 'light' : 'dark';
}

function apply(): void {
  if (typeof document === 'undefined') return;
  const theme = resolveTheme();
  document.documentElement.setAttribute('data-theme', theme);
  setWindowTheme(theme, preference === 'system');
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
  apply();
  listeners.forEach((l) => l());
}

/** Applies the stored theme before the first render and follows system changes while "System" is chosen. */
export function initTheme(): void {
  apply();
  systemQuery()?.addEventListener?.('change', () => {
    if (preference !== 'system') return;
    apply();
    listeners.forEach((l) => l());
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, () => preference, () => preference);
}
