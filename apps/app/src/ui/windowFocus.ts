/** Fields whose blur came from the window going inactive, until they are focused again. */
const resuming = new WeakSet<HTMLElement>();

/**
 * Call first in the onBlur of a text edit or rename. When the blur only means the window went inactive
 * (Alt+Tab, a click in another app; Chromium blurs the focused element then), it returns true and the
 * caller must not commit: focus comes back to the field when the window is activated again, so the edit
 * simply continues. A real blur inside the app returns false and commits as before.
 */
export function keepEditingAcrossWindowBlur(el: HTMLElement): boolean {
  if (typeof document.hasFocus !== 'function' || document.hasFocus()) return false;
  resuming.add(el);
  window.addEventListener(
    'focus',
    () => {
      // Chromium usually restores focus by itself; only step in when it did not and nothing else took it.
      const active = document.activeElement;
      if (el.isConnected && active !== el && (!active || active === document.body)) el.focus({ preventScroll: true });
    },
    { once: true },
  );
  return true;
}

/**
 * For onFocus handlers that select the field's text: false when focus is only returning after the window
 * was reactivated, so the caret and partial selection the user left are kept.
 */
export function isFreshFocus(el: HTMLElement): boolean {
  return !resuming.delete(el);
}
