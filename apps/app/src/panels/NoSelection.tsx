import { memo, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { announceLive, endPreview } from '../canvas/preview';
import { useDoc } from '../store/DocProvider';
import { useNode } from '../store/hooks';
import { ColorField, Section } from './fields/fields';
import { McpPanel } from './McpPanel';

/** The canvas colour a page shows when it has no background of its own (the editor theme's). */
const themeCanvas = () => (typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim());

/** Design tab with nothing selected: the page's own settings and the way in for agents. */
export const NoSelection = memo(function NoSelection({ pageRootId }: { pageRootId: string }) {
  return (
    <div className="inspector-body">
      <PageSection rootId={pageRootId} />
      <McpSection />
    </div>
  );
});

function PageSection({ rootId }: { rootId: string }) {
  const { doc, actor } = useDoc();
  const root = useNode(rootId);
  const value = root?.styles.backgroundColor;
  return (
    <Section title="Page">
      <ColorField
        label="Page background"
        value={value}
        placeholder="Default"
        fallback={themeCanvas()}
        // The canvas draws the preview itself (see Canvas): the page root has no element of its own.
        onPreview={(v) => announceLive([rootId], { backgroundColor: v || null })}
        onCommit={(v) => {
          endPreview();
          if ((v || undefined) === value) return;
          doc.updateStyles(actor, [{ nodeIds: [rootId], styles: { backgroundColor: v || null } }], v ? 'Changed the page background' : 'Reset the page background');
        }}
      />
    </Section>
  );
}

function McpSection() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });

  // Beside the right panel, top-aligned with the button, kept inside the window.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const panel = button.current.closest('.panel')?.getBoundingClientRect() ?? r;
    setPos({ top: Math.max(8, Math.min(r.top - 12, window.innerHeight - 480)), right: Math.round(window.innerWidth - panel.left + 8) });
  }, [open]);

  return (
    <Section title="MCP">
      <button ref={button} type="button" className="section-button is-wide" data-mcp-toggle aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Connect your agent
      </button>
      {open &&
        createPortal(
          <div className="mcp-side" style={pos}>
            <McpPanel onClose={() => setOpen(false)} />
          </div>,
          button.current?.closest('.app-shell') ?? document.body,
        )}
    </Section>
  );
}
