import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type Side = 'top' | 'right' | 'bottom' | 'left';

interface Tip {
  el: HTMLElement;
  text: string;
  shortcut: string | null;
  side: Side;
}

/** First hover waits this long; once a tooltip has shown, neighbours show at once. */
const DELAY_MS = 380;
/** How long after a tooltip hides the next one still opens without delay. */
const WARM_MS = 700;
const GAP = 8;
const MARGIN = 8;

const tipTarget = (node: EventTarget | null) => (node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null);

function read(el: HTMLElement): Tip {
  return { el, text: el.dataset.tip ?? '', shortcut: el.dataset.tipKey ?? null, side: (el.dataset.tipSide as Side | undefined) ?? 'bottom' };
}

/**
 * One tooltip for the whole UI, driven by `data-tip` (text), `data-tip-key` (shortcut) and
 * `data-tip-side`. Replaces native `title`, whose long fixed delay made moving across a toolbar feel slow:
 * the first tooltip waits briefly, then the next ones follow the pointer with no delay. Keyboard focus
 * shows it too; touch, drags, scrolling, clicks and Escape hide it.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const warmUntil = useRef(0);
  const current = useRef<HTMLElement | null>(null);
  const shown = useRef(false);
  shown.current = !!tip;

  useEffect(() => {
    const clear = () => window.clearTimeout(timer.current);
    const hide = (cool = false) => {
      clear();
      if (current.current) warmUntil.current = cool ? 0 : performance.now() + WARM_MS;
      current.current = null;
      setTip(null);
    };
    const open = (el: HTMLElement, immediate: boolean) => {
      if (current.current === el) return;
      clear();
      current.current = el;
      // Moving straight from one tooltip to the next keeps it warm, as does a recent hide.
      const warm = shown.current || performance.now() < warmUntil.current;
      if (immediate || warm) setTip(read(el));
      else {
        setTip(null);
        timer.current = window.setTimeout(() => current.current === el && el.isConnected && setTip(read(el)), DELAY_MS);
      }
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.buttons) return;
      const el = tipTarget(e.target);
      if (el) open(el, false);
      else if (current.current) hide();
    };
    const onOut = (e: PointerEvent) => {
      if (current.current && !tipTarget(e.relatedTarget)) hide();
    };
    const onFocus = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (el && el.matches(':focus-visible')) open(el, true);
    };
    const onBlur = (e: FocusEvent) => {
      if (current.current && current.current === tipTarget(e.target)) hide();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hide(true);
    const onDown = () => hide(true);
    const onScroll = () => current.current && hide(true);
    // Switching to another app leaves no pointerout behind; the tip would otherwise float over it on return.
    const onWindowBlur = () => hide(true);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', onBlur);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('wheel', onScroll, { passive: true, capture: true });
    return () => {
      clear();
      window.removeEventListener('blur', onWindowBlur);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', onBlur);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('wheel', onScroll, { capture: true });
    };
  }, []);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!tip || !box) return setPos(null);
    const r = tip.el.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    let top = r.bottom + GAP;
    if (tip.side === 'top') top = r.top - GAP - h;
    if (tip.side === 'right' || tip.side === 'left') {
      top = r.top + r.height / 2 - h / 2;
      left = tip.side === 'right' ? r.right + GAP : r.left - GAP - w;
    }
    if (tip.side === 'bottom' && top + h > window.innerHeight - MARGIN) top = r.top - GAP - h;
    setPos({
      left: Math.round(Math.min(Math.max(MARGIN, left), window.innerWidth - w - MARGIN)),
      top: Math.round(Math.min(Math.max(MARGIN, top), window.innerHeight - h - MARGIN)),
    });
  }, [tip]);

  if (!tip?.text) return null;
  return (
    <div ref={ref} className={`tooltip is-${tip.side} ${pos ? 'is-shown' : ''}`} role="tooltip" style={pos ?? { left: -9999, top: -9999 }}>
      <span>{tip.text}</span>
      {tip.shortcut && <kbd className="tooltip-key">{tip.shortcut}</kbd>}
    </div>
  );
}
