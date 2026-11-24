import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useZoomPercent, type ViewportStore } from '../canvas/store';
import { isMacPlatform, shortcutLabel, type Command } from '../commands/keyboard';
import { useDismiss } from '../ui/useDismiss';

type ZoomCommand = Extract<Command, 'zoomIn' | 'zoomOut' | 'zoomToFit' | 'zoomTo100'>;

const ZOOM_ITEMS: { command: ZoomCommand; label: string }[] = [
  { command: 'zoomIn', label: 'Zoom in' },
  { command: 'zoomOut', label: 'Zoom out' },
  { command: 'zoomToFit', label: 'Zoom to fit' },
  { command: 'zoomTo100', label: 'Zoom to 100%' },
];

/** Top of the right panel: whether agents can reach this file, and the zoom level with its menu. */
export const PanelTop = memo(function PanelTop({ bridgeStatus, viewport, onZoom }: { bridgeStatus: string; viewport: ViewportStore; onZoom(command: ZoomCommand): void }) {
  const connected = bridgeStatus === 'connected';
  return (
    <div className="panel-top">
      <span className={`bridge-status is-${bridgeStatus}`} data-tip={connected ? 'Agents can reach this file through markup mcp' : 'Run markup mcp from an agent to connect'}>
        {connected ? 'Agents connected' : 'Agents offline'}
      </span>
      <ZoomMenu viewport={viewport} onZoom={onZoom} />
    </div>
  );
});

function ZoomMenu({ viewport, onZoom }: { viewport: ViewportStore; onZoom(command: ZoomCommand): void }) {
  const percent = useZoomPercent(viewport);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });
  const mac = isMacPlatform();
  useDismiss(() => setOpen(false), { ref: menu, enabled: open });

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    setPos({ top: Math.round(r.bottom + 4), right: Math.round(window.innerWidth - r.right) });
    menu.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role=menuitem]') ?? [])];
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        button.current?.focus();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const i = items.indexOf(document.activeElement as HTMLElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`zoom-menu-button ${open ? 'is-open' : ''}`}
        aria-label={`Zoom ${percent}%`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : 'Zoom'}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{percent}%</span>
        <svg width="8" height="6" viewBox="0 0 8 6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M1 1.75 4 4.5l3-2.75" />
        </svg>
      </button>
      {open && (
        <div ref={menu} className="canvas-menu zoom-menu" role="menu" aria-label="Zoom" style={pos}>
          {ZOOM_ITEMS.map((item) => (
            <button
              key={item.command}
              type="button"
              role="menuitem"
              className="canvas-menu-item"
              onMouseEnter={(e) => e.currentTarget.focus()}
              onClick={() => {
                setOpen(false);
                onZoom(item.command);
              }}
            >
              <span className="canvas-menu-label">{item.label}</span>
              <kbd>{shortcutLabel(item.command, mac)}</kbd>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
