import { useEffect, useRef, useState, type ReactNode } from 'react';
import { icons } from '../panels/icons';
import { setThemePreference, useThemePreference, type ThemePreference } from './theme';
import { useDismiss } from './useDismiss';

const THEMES: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: 'system', label: 'System', icon: icons.monitor },
  { value: 'light', label: 'Light', icon: icons.sun },
  { value: 'dark', label: 'Dark', icon: icons.moon },
];

/** Settings button in the title strip and its panel (appearance for now). */
export function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const theme = useThemePreference();
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
    <div className="settings-anchor">
      <button
        ref={button}
        className={`settings-button ${open ? 'is-open' : ''}`}
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tip="Settings"
        onClick={() => setOpen((o) => !o)}
      >
        {icons.settings}
      </button>
      {open && (
        <div ref={ref} className="settings-panel" role="dialog" aria-label="Settings">
          <div className="settings-head">Settings</div>
          <section className="settings-section" aria-labelledby="settings-appearance">
            <h3 id="settings-appearance" className="settings-title">
              Appearance
            </h3>
            <p className="settings-note">The editor's colours. Designs on the canvas keep their own.</p>
            <div className="theme-options" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === t.value}
                  className={`theme-option ${theme === t.value ? 'is-active' : ''}`}
                  onClick={() => setThemePreference(t.value)}
                >
                  <span className={`theme-preview is-${t.value}`} aria-hidden>
                    <span className="theme-preview-bar" />
                    <span className="theme-preview-panel" />
                    <span className="theme-preview-canvas">
                      <span className="theme-preview-board" />
                    </span>
                  </span>
                  <span className="theme-option-label">
                    {t.icon}
                    {t.label}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
