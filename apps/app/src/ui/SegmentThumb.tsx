import { useLayoutEffect, useRef } from 'react';

/**
 * The highlight behind the active segment of a `.segmented` control. Render it as the control's first
 * child: it measures the active segment and glides to it whenever the active one changes or the
 * control resizes. With no active segment (a mixed value) it fades out.
 */
export function SegmentThumb() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const thumb = ref.current;
    const group = thumb?.parentElement;
    if (!thumb || !group) return;
    const place = () => {
      const on = group.querySelector<HTMLElement>(':scope > .segment.is-active');
      if (!on) {
        thumb.style.opacity = '0';
        return;
      }
      thumb.style.opacity = '1';
      thumb.style.width = `${on.offsetWidth}px`;
      thumb.style.transform = `translateX(${on.offsetLeft}px)`;
    };
    place();
    // Placed before the first paint without a transition; only later moves glide.
    const frame = requestAnimationFrame(() => thumb.classList.add('is-ready'));
    const watch = new MutationObserver(place);
    watch.observe(group, { subtree: true, attributes: true, attributeFilter: ['class'] });
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place);
    resize?.observe(group);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
      resize?.disconnect();
    };
  }, []);
  return <span ref={ref} className="segment-thumb" aria-hidden />;
}
