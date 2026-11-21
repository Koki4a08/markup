import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

export interface PanelWidths {
  left: number;
  right: number;
}

/** Each side panel widens a little, never so far that the canvas loses its room. */
export const PANEL_LIMITS = {
  left: { min: 200, max: 380, initial: 240 },
  right: { min: 248, max: 420, initial: 272 },
} as const;

const STORAGE_KEY = 'markup:panel-widths';
const STEP = 16;

const clamp = (side: keyof PanelWidths, w: number) => Math.round(Math.min(PANEL_LIMITS[side].max, Math.max(PANEL_LIMITS[side].min, w)));

function restore(): PanelWidths {
  const fallback = { left: PANEL_LIMITS.left.initial, right: PANEL_LIMITS.right.initial };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<PanelWidths> | null;
    if (!saved) return fallback;
    return { left: clamp('left', Number(saved.left) || fallback.left), right: clamp('right', Number(saved.right) || fallback.right) };
  } catch {
    return fallback;
  }
}

/** Side panel widths, remembered on this machine. */
export function usePanelWidths(): [PanelWidths, Dispatch<SetStateAction<PanelWidths>>] {
  const [widths, setWidths] = useState(restore);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // Storage unavailable (private window, blocked site data): widths just reset next time.
    }
  }, [widths]);
  return [widths, setWidths];
}

/**
 * Drag handle on a side panel's inner edge. Drag to resize within PANEL_LIMITS, double-click to reset,
 * or focus it and use the arrow keys (Shift for bigger steps, Home/End for the limits).
 */
export function PanelResizer({ side, width, onWidth }: { side: keyof PanelWidths; width: number; onWidth(width: number): void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [active, setActive] = useState(false);
  const limits = PANEL_LIMITS[side];
  // Dragging away from the panel's own edge widens it: rightwards for the left panel, leftwards for the right.
  const sign = side === 'left' ? 1 : -1;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={side === 'left' ? 'Resize layers panel' : 'Resize design panel'}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={width}
      tabIndex={0}
      className={`panel-resizer is-${side} ${active ? 'is-active' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
        setActive(true);
        document.documentElement.classList.add('is-resizing-panel');
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (start) onWidth(clamp(side, start.width + sign * (e.clientX - start.x)));
      }}
      onPointerUp={() => {
        drag.current = null;
        setActive(false);
        document.documentElement.classList.remove('is-resizing-panel');
      }}
      onPointerCancel={() => {
        drag.current = null;
        setActive(false);
        document.documentElement.classList.remove('is-resizing-panel');
      }}
      onDoubleClick={() => onWidth(limits.initial)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? STEP * 4 : STEP;
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = width - sign * step;
        if (e.key === 'ArrowRight') next = width + sign * step;
        if (e.key === 'Home') next = limits.min;
        if (e.key === 'End') next = limits.max;
        if (next === null) return;
        // Keep arrows from also nudging the canvas selection.
        e.preventDefault();
        e.stopPropagation();
        onWidth(clamp(side, next));
      }}
    />
  );
}
