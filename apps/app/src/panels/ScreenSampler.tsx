import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pixelHex, type WindowPixels } from '../desktop/screenCapture';
import { useDismiss } from '../ui/useDismiss';

/** Pixels across the loupe (odd, so one sits in the middle) and the size each is drawn at. */
const CELLS = 11;
const CELL = 10;
const HALF = (CELLS - 1) / 2;

export interface ScreenSamplerProps {
  /** The capture of the window taken just before the sampler opened. */
  pixels: WindowPixels;
  /** Where the loupe starts, in CSS pixels (the pointer, or the button that opened it). */
  start: { x: number; y: number };
  onPick(hex: string): void;
  onCancel(): void;
}

/**
 * The desktop app's eyedropper: a loupe over the window that magnifies the pixels under the pointer.
 * Click or Enter picks the middle pixel; Escape, a right click or leaving the app cancels.
 * Arrow keys move it one pixel at a time (ten with Shift).
 */
export function ScreenSampler({ pixels, start, onPick, onCancel }: ScreenSamplerProps) {
  const [at, setAt] = useState(start);
  const loupe = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onPick, onCancel });
  callbacks.current = { onPick, onCancel };

  // Physical pixels per CSS pixel, read from the capture itself rather than trusting devicePixelRatio.
  const scale = pixels.width / Math.max(1, window.innerWidth);
  const physical = (p: { x: number; y: number }) => ({ x: Math.floor(p.x * scale), y: Math.floor(p.y * scale) });
  const hex = pixelHex(pixels, physical(at).x, physical(at).y);
  const atRef = useRef(at);
  atRef.current = at;

  const source = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = pixels.width;
    canvas.height = pixels.height;
    canvas.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
    return canvas;
  }, [pixels]);

  useLayoutEffect(() => {
    const ctx = loupe.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = physical(at);
    const size = ctx.canvas.width;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(source, x - HALF, y - HALF, CELLS, CELLS, 0, 0, size, size);
  });

  useDismiss(() => callbacks.current.onCancel(), { wheel: false });

  useEffect(() => {
    layer.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const step = (e.shiftKey ? 10 : 1) / scale;
      const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (e.key === 'Escape') callbacks.current.onCancel();
      else if (e.key === 'Enter' || e.key === ' ') {
        const p = atRef.current;
        callbacks.current.onPick(pixelHex(pixels, Math.floor(p.x * scale), Math.floor(p.y * scale)));
      } else if (e.key in move) {
        const [dx, dy] = move[e.key] ?? [0, 0];
        setAt((p) => ({ x: Math.min(window.innerWidth - 1, Math.max(0, p.x + dx)), y: Math.min(window.innerHeight - 1, Math.max(0, p.y + dy)) }));
      } else return;
      // Keys stay with the sampler: Escape must not also close the picker, arrows must not nudge layers.
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pixels, scale]);

  const dpr = window.devicePixelRatio || 1;
  const side = CELLS * CELL;
  // The value stays inside the window: under the loupe, or over it near the bottom edge.
  const below = at.y + side / 2 + 10 + 24 <= window.innerHeight - 8;
  const valueAt = {
    left: Math.min(window.innerWidth - 48, Math.max(48, at.x)),
    top: below ? at.y + side / 2 + 10 : at.y - side / 2 - 10 - 24,
  };
  return createPortal(
    <div
      ref={layer}
      className="screen-sampler"
      tabIndex={-1}
      role="application"
      aria-label={`Eyedropper, ${hex}. Click or press Enter to pick, Escape to cancel.`}
      onPointerMove={(e) => setAt({ x: e.clientX, y: e.clientY })}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.button === 0) callbacks.current.onPick(pixelHex(pixels, Math.floor(e.clientX * scale), Math.floor(e.clientY * scale)));
        else callbacks.current.onCancel();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="screen-sampler-loupe" style={{ left: at.x, top: at.y, width: side, height: side }}>
        <canvas ref={loupe} width={Math.round(side * dpr)} height={Math.round(side * dpr)} />
        <span className="screen-sampler-grid" style={{ backgroundSize: `${CELL}px ${CELL}px` }} />
        <span className="screen-sampler-target" style={{ width: CELL, height: CELL }} />
      </div>
      <div className="screen-sampler-value" style={valueAt}>
        <span className="screen-sampler-swatch" style={{ background: hex }} />
        {hex.slice(1).toUpperCase()}
      </div>
    </div>,
    document.body,
  );
}
