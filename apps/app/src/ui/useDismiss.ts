import { useEffect, useRef, type RefObject } from 'react';

export interface DismissOptions {
  /** Wheel events inside this element (scrolling a long menu) keep it open. */
  ref?: RefObject<HTMLElement | null>;
  /** Close when the window loses focus. Default true. */
  blur?: boolean;
  /** Close when the window is resized. Default true. */
  resize?: boolean;
  /** Close on a wheel outside ref. Default true. */
  wheel?: boolean;
  /** Listen only while true (for popups that stay mounted). Default true. */
  enabled?: boolean;
}

/**
 * Closes a popup the way native menus close: when the app loses focus (Alt+Tab, a click in another app),
 * when the window resizes under it, or when the user scrolls somewhere else. Pointer-down-outside and Escape
 * stay with each popup, which knows its own trigger and focus rules.
 */
export function useDismiss(onClose: () => void, { ref, blur = true, resize = true, wheel = true, enabled = true }: DismissOptions = {}): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!enabled) return;
    const dismiss = () => close.current();
    const onWheel = (e: WheelEvent) => {
      if (!ref?.current?.contains(e.target as Node)) close.current();
    };
    if (blur) window.addEventListener('blur', dismiss);
    if (resize) window.addEventListener('resize', dismiss);
    // Capture phase: the canvas stops wheel events it turns into pans and zooms.
    if (wheel) window.addEventListener('wheel', onWheel, { capture: true, passive: true });
    return () => {
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [ref, blur, resize, wheel, enabled]);
}
