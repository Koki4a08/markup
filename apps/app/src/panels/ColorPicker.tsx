import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { captureWindow, canCaptureWindow, type WindowPixels } from '../desktop/screenCapture';
import { useDismiss } from '../ui/useDismiss';
import { ScreenSampler } from './ScreenSampler';
import { icons } from './icons';
import {
  convertSpace,
  cssStrings,
  fromHsl,
  fromOklch,
  fromRgb,
  hexOf,
  hsvToRgb,
  parseHex,
  parsePicked,
  rgb255,
  rgbOf,
  roundTo,
  sameColor,
  toCss,
  toHsl,
  toOklch,
  type Picked,
  type Space,
} from './colorSpace';

const BLACK: Picked = { space: 'srgb', h: 0, s: 0, v: 0, a: 1 };
const GAP = 8;

interface EyeDropperResult {
  sRGBHex: string;
}
type EyeDropperCtor = new () => { open(): Promise<EyeDropperResult> };
const eyeDropper = (): EyeDropperCtor | undefined => (globalThis as { EyeDropper?: EyeDropperCtor }).EyeDropper;
/** The Windows app samples its own window (see screenCapture.ts); browsers use their EyeDropper. */
const canSample = () => canCaptureWindow() || !!eyeDropper();

/** The opaque colour of a picked colour's channels, as CSS in its own space. */
const solidCss = (space: Space, rgb: [number, number, number], alpha = 1) =>
  space === 'srgb'
    ? `rgb(${rgb.map((c) => Math.round(c * 255)).join(' ')} / ${alpha})`
    : `color(display-p3 ${rgb.map((c) => roundTo(c, 4)).join(' ')} / ${alpha})`;

export interface ColorPickerProps {
  /** The element the picker opens from (the swatch); it is placed beside the panel that holds it. */
  anchor: HTMLElement;
  /** What the colour is for, used in accessible names. */
  label: string;
  /** The current colour as CSS (a token reference already resolved), or null for none. */
  value: string | null;
  /** Offer Display P3 next to sRGB. Default true. */
  p3?: boolean;
  /** Live value while dragging or nudging; the canvas previews it without writing the document. */
  onPreview(css: string): void;
  /** A finished change (end of a drag, a typed value): one history entry. */
  onCommit(css: string): void;
  onClose(): void;
}

/**
 * Colour picker popover: colour space tabs, a saturation/brightness plane with hue and alpha strips,
 * previous/new swatches, and OKLCH, HSL, RGB and hex fields that each copy as CSS.
 */
export function ColorPicker({ anchor, label, value, p3 = true, onPreview, onCommit, onClose }: ColorPickerProps) {
  const initial = () => {
    const parsed = parsePicked(value) ?? BLACK;
    return p3 ? parsed : convertSpace(parsed, 'srgb');
  };
  const [picked, setPicked] = useState<Picked>(initial);
  const [previous] = useState<Picked | null>(() => parsePicked(value));
  const cur = useRef(picked);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [sampling, setSampling] = useState(false);
  // Read by the window listeners below, which must not close the picker while the eyedropper is up.
  const samplingRef = useRef(false);
  samplingRef.current = sampling;
  const sampleButton = useRef<HTMLButtonElement>(null);
  const [capture, setCapture] = useState<{ pixels: WindowPixels; start: { x: number; y: number } } | null>(null);
  const callbacks = useRef({ onPreview, onCommit, onClose });
  callbacks.current = { onPreview, onCommit, onClose };

  const update = (next: Picked, commit: boolean) => {
    cur.current = next;
    setPicked(next);
    const css = toCss(next);
    if (commit) callbacks.current.onCommit(css);
    else callbacks.current.onPreview(css);
  };
  const commitCurrent = () => callbacks.current.onCommit(toCss(cur.current));

  // The document changed under the picker (another selection, an agent, undo): follow it.
  useEffect(() => {
    const parsed = parsePicked(value);
    if (!parsed) return;
    const next = p3 ? parsed : convertSpace(parsed, 'srgb');
    if (sameColor(next, cur.current)) return;
    cur.current = next;
    setPicked(next);
  }, [value, p3]);

  // Beside the panel holding the swatch (over the canvas), top-aligned with it, kept inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const panel = anchor.closest('.panel')?.getBoundingClientRect() ?? a;
      const { width, height } = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = panel.left - width - GAP;
      if (left < GAP) left = panel.right + GAP + width <= vw - GAP ? panel.right + GAP : Math.max(GAP, vw - width - GAP);
      const top = Math.min(Math.max(GAP, a.top - 12), Math.max(GAP, vh - height - GAP));
      setPos({ left: Math.round(left), top: Math.round(top) });
    };
    place();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor]);

  useDismiss(() => callbacks.current.onClose(), { ref, enabled: !sampling });

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (samplingRef.current) return;
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) callbacks.current.onClose();
    };
    // Capture: Escape closes the picker instead of also selecting the parent layer.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || samplingRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      callbacks.current.onClose();
      anchor.focus();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchor]);

  const setSpace = (space: Space) => {
    if (space !== cur.current.space) update(convertSpace(cur.current, space), true);
  };

  /** A sampled colour keeps the current alpha and colour space. */
  const pickHex = (value: string) => {
    const hex = parseHex(value);
    if (hex) update(convertSpace(fromRgb('srgb', hex.rgb, cur.current.a), cur.current.space), true);
  };

  const sample = async (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (samplingRef.current) return;
    samplingRef.current = true;
    setSampling(true);
    if (canCaptureWindow()) {
      // From the keyboard there is no pointer: start the loupe on the button.
      const r = e.currentTarget.getBoundingClientRect();
      const start = e.detail ? { x: e.clientX, y: e.clientY } : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      try {
        // Two frames: the tooltip and the button's pressed state are gone from the capture.
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        setCapture({ pixels: await captureWindow(), start });
      } catch {
        samplingRef.current = false;
        setSampling(false);
      }
      return;
    }
    const Ctor = eyeDropper();
    try {
      if (Ctor) pickHex((await new Ctor().open()).sRGBHex);
    } catch {
      // Cancelled with Escape.
    } finally {
      samplingRef.current = false;
      setSampling(false);
    }
  };

  const endCapture = () => {
    setCapture(null);
    samplingRef.current = false;
    setSampling(false);
    sampleButton.current?.focus();
  };

  /** Drag on a plane or strip: previews while moving, commits once on release. */
  const drag = (toPicked: (x: number, y: number) => Picked) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.focus();
    el.setPointerCapture(e.pointerId);
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      update(toPicked(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))), false);
    };
    at(e);
    const move = (ev: PointerEvent) => at(ev);
    const end = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      if (ev.type === 'pointerup') commitCurrent();
      else update(cur.current, true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  /** Arrow keys on a plane or strip: 1% steps, 10% with Shift; each press is one change. */
  const keys = (apply: (dx: number, dy: number) => Picked) => (e: ReactKeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const by = d[e.key];
    if (!by) return;
    e.preventDefault();
    update(apply(by[0], by[1]), true);
  };

  const p = picked;
  const rgb = rgbOf(p);
  const hueRgb = hsvToRgb(p.h, 1, 1);
  const strings = cssStrings(p);
  const oklch = toOklch(p);
  const hsl = toHsl(p);
  const [r255, g255, b255] = rgb255(p);
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const vars = {
    '--cp-hue': solidCss(p.space, hueRgb),
    '--cp-solid': solidCss(p.space, rgb),
    '--cp-clear': solidCss(p.space, rgb, 0),
    '--cp-current': toCss(p),
    '--cp-previous': previous ? toCss(previous) : 'transparent',
  } as CSSProperties;

  const host = anchor.closest('.app-shell') ?? document.body;
  return createPortal(
    <div
      ref={ref}
      className={`color-picker ${p.space === 'display-p3' ? 'is-p3' : ''}`}
      role="dialog"
      aria-label={`${label} colour`}
      style={{ ...vars, left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? undefined : 'hidden' }}
      // Keys stay in the picker: arrows nudge colours here, not layers on the canvas.
      onKeyDown={(e) => {
        if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
      }}
    >
      <div className="cp-head">
        <div className="cp-tabs" role="tablist" aria-label="Colour space">
          {(p3 ? (['srgb', 'display-p3'] as const) : (['srgb'] as const)).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={p.space === s} className={`cp-tab ${p.space === s ? 'is-active' : ''}`} onClick={() => setSpace(s)}>
              {s === 'srgb' ? 'sRGB' : 'Display P3'}
            </button>
          ))}
        </div>
        <div className="cp-head-actions">
          {canSample() && (
            <button ref={sampleButton} type="button" className={`icon-button cp-head-button ${sampling ? 'is-active' : ''}`} aria-label="Pick a colour from the screen" aria-pressed={sampling} data-tip="Pick from screen" onClick={sample}>
              {icons.eyedropper}
            </button>
          )}
          <button
            type="button"
            className="icon-button cp-head-button"
            aria-label="Close colour picker"
            data-tip="Close"
            onClick={() => {
              onClose();
              anchor.focus();
            }}
          >
            {icons.dismiss}
          </button>
        </div>
      </div>

      <div className="cp-body">
        <div className="cp-planes">
          <div
            className="cp-area"
            role="slider"
            tabIndex={0}
            aria-label="Saturation and brightness"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(p.s * 100)}
            aria-valuetext={`Saturation ${Math.round(p.s * 100)}%, brightness ${Math.round(p.v * 100)}%`}
            onPointerDown={drag((x, y) => ({ ...cur.current, s: x, v: 1 - y }))}
            onKeyDown={keys((dx, dy) => ({ ...cur.current, s: clamp01(cur.current.s + dx), v: clamp01(cur.current.v - dy) }))}
          >
            <span className="cp-area-thumb" style={{ left: `${p.s * 100}%`, top: `${(1 - p.v) * 100}%` }} />
          </div>
          <div
            className="cp-strip is-hue"
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(p.h)}
            onPointerDown={drag((_, y) => ({ ...cur.current, h: y * 360 }))}
            onKeyDown={keys((dx, dy) => ({ ...cur.current, h: Math.min(360, Math.max(0, cur.current.h + (dy || dx) * 360)) }))}
          >
            <span className="cp-strip-thumb" style={{ top: `${(p.h / 360) * 100}%` }} />
          </div>
          <div
            className="cp-strip is-alpha"
            role="slider"
            tabIndex={0}
            aria-label="Alpha"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(p.a * 100)}
            aria-valuetext={`${Math.round(p.a * 100)}%`}
            onPointerDown={drag((_, y) => ({ ...cur.current, a: roundTo(1 - y, 2) }))}
            onKeyDown={keys((dx, dy) => ({ ...cur.current, a: roundTo(clamp01(cur.current.a - (dy || -dx)), 2) }))}
          >
            <span className="cp-strip-thumb" style={{ top: `${(1 - p.a) * 100}%` }} />
          </div>
        </div>

        <div className="cp-side">
          <div className="cp-compare">
            <div className="cp-compare-swatches">
              <button
                type="button"
                className={`cp-compare-swatch is-previous ${previous ? '' : 'is-empty'}`}
                aria-label="Restore the previous colour"
                data-tip="Restore previous"
                disabled={!previous}
                onClick={() => previous && update(p3 ? previous : convertSpace(previous, 'srgb'), true)}
              />
              <span className="cp-compare-swatch is-new" aria-hidden />
            </div>
            <div className="cp-compare-labels" aria-hidden>
              <span>Previous</span>
              <span>New</span>
            </div>
          </div>

          <div className="cp-rows">
            <ChannelRow
              name="OKLCH"
              copy={strings.oklch}
              fields={[
                { label: 'L', value: oklch.l * 100, decimals: 1, max: 100, step: 1, set: (v) => fromOklch(p.space, v / 100, oklch.c, oklch.h, p.a, p.h) },
                { label: 'C', value: oklch.c, decimals: 3, max: 0.5, step: 0.005, set: (v) => fromOklch(p.space, oklch.l, v, oklch.h, p.a, p.h) },
                { label: 'H', value: oklch.h, decimals: 1, max: 360, step: 1, set: (v) => fromOklch(p.space, oklch.l, oklch.c, v, p.a, p.h) },
              ]}
              onChange={(next) => update(next, true)}
            />
            <ChannelRow
              name="HSL"
              copy={strings.hsl}
              fields={[
                { label: 'H', value: hsl.h, decimals: 1, max: 360, step: 1, set: (v) => fromHsl(p.space, v, hsl.s, hsl.l, p.a) },
                { label: 'S', value: hsl.s * 100, decimals: 1, max: 100, step: 1, set: (v) => ({ ...fromHsl(p.space, hsl.h, v / 100, hsl.l, p.a), h: p.h }) },
                { label: 'L', value: hsl.l * 100, decimals: 1, max: 100, step: 1, set: (v) => ({ ...fromHsl(p.space, hsl.h, hsl.s, v / 100, p.a), h: p.h }) },
              ]}
              onChange={(next) => update(next, true)}
            />
            <ChannelRow
              name="RGB"
              copy={strings.rgb}
              fields={(['R', 'G', 'B'] as const).map((ch, i) => ({
                label: ch,
                value: [r255, g255, b255][i]!,
                decimals: 0,
                max: 255,
                step: 1,
                set: (v: number) => {
                  const next = [r255, g255, b255].map((c) => c / 255) as [number, number, number];
                  next[i] = v / 255;
                  return fromRgb(p.space, next, p.a, p.h);
                },
              }))}
              onChange={(next) => update(next, true)}
            />
            <div className="cp-row is-hex">
              <div className="cp-group">
                <HexInput
                  value={hexOf(p)}
                  onCommit={(raw) => {
                    const hex = parseHex(raw);
                    if (hex) return update(fromRgb(p.space, hex.rgb, hex.a ?? p.a, p.h), true);
                    // Any other CSS colour typed here (rgb(), a name) is read as sRGB.
                    const other = parsePicked(raw);
                    if (other) update(convertSpace(other, p.space), true);
                  }}
                />
                <span className="cp-group-sep" aria-hidden>
                  /
                </span>
                <NumberInput
                  label="Alpha value"
                  value={p.a * 100}
                  decimals={0}
                  max={100}
                  step={1}
                  suffix="%"
                  onCommit={(v) => update({ ...cur.current, a: v / 100 }, true)}
                />
              </div>
              <CopyButton text={strings.hex} what="hex" />
            </div>
          </div>
        </div>
      </div>
      {capture && (
        <ScreenSampler
          pixels={capture.pixels}
          start={capture.start}
          onPick={(hex) => {
            endCapture();
            pickHex(hex);
          }}
          onCancel={endCapture}
        />
      )}
    </div>,
    host,
  );
}

interface ChannelField {
  label: string;
  value: number;
  decimals: number;
  max: number;
  step: number;
  set(v: number): Picked;
}

function ChannelRow({ name, fields, copy, onChange }: { name: string; fields: ChannelField[]; copy: string; onChange(next: Picked): void }) {
  return (
    <div className="cp-row" role="group" aria-label={name}>
      <div className="cp-group">
        {fields.map((f) => (
          <NumberInput key={f.label} label={`${name} ${f.label}`} value={f.value} decimals={f.decimals} max={f.max} step={f.step} onCommit={(v) => onChange(f.set(v))} />
        ))}
      </div>
      <CopyButton text={copy} what={name} />
      <div className="cp-row-labels" aria-hidden>
        {fields.map((f) => (
          <span key={f.label}>{f.label}</span>
        ))}
      </div>
    </div>
  );
}

const fmt = (v: number, decimals: number) => String(roundTo(v, decimals));

/** A number cell: Enter or leaving commits, Escape reverts, arrows nudge (Shift ×10). */
function NumberInput({ label, value, decimals, max, step, suffix, onCommit }: { label: string; value: number; decimals: number; max: number; step: number; suffix?: string; onCommit(v: number): void }) {
  const shown = fmt(value, decimals);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    setDraft(null);
    const v = parseFloat(raw);
    if (Number.isNaN(v) || fmt(v, decimals) === shown) return;
    onCommit(Math.min(max, Math.max(0, v)));
  };
  return (
    <label className="cp-cell">
      <input
        className="cp-input"
        aria-label={label}
        inputMode="decimal"
        spellCheck={false}
        value={draft ?? shown}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit(e.currentTarget.value);
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const base = parseFloat(draft ?? shown) || 0;
            const next = base + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            setDraft(null);
            onCommit(Math.min(max, Math.max(0, Number(next.toFixed(4)))));
          }
        }}
      />
      {suffix && <span className="cp-suffix">{suffix}</span>}
    </label>
  );
}

function HexInput({ value, onCommit }: { value: string; onCommit(raw: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    setDraft(null);
    if (raw.trim().replace(/^#/, '').toUpperCase() !== value) onCommit(raw);
  };
  return (
    <label className="cp-cell is-hex">
      <input
        className="cp-input"
        aria-label="Hex"
        spellCheck={false}
        autoCapitalize="characters"
        value={draft ?? value}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget.value)}
      />
    </label>
  );
}

function CopyButton({ text, what }: { text: string; what: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className={`icon-button cp-copy ${done ? 'is-done' : ''}`}
      aria-label={`Copy ${what} as CSS`}
      data-tip={done ? 'Copied' : text}
      onClick={() => navigator.clipboard?.writeText(text).then(() => setDone(true), () => {})}
    >
      {done ? icons.check : icons.copy}
    </button>
  );
}
