import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Token } from '@markup/doc';
import { icons } from './icons';
import { formatColor, hexLabel, parseColor, type RGBA } from './color';
import { previewColor, replaceColor, type ColorGroup } from './selectionTheme';
import { endPreview } from '../canvas/preview';
import { useDoc } from '../store/DocProvider';
import { useSelection } from '../canvas/selection';

/**
 * Figma's "Selection colors": every colour the selected layers and their children use, how often, and
 * edits that recolour all of those uses at once (a token-backed colour edits the token).
 */
export function SelectionColors({ groups, initial = 10 }: { groups: ColorGroup[]; initial?: number }) {
  const [all, setAll] = useState(false);
  if (!groups.length) return <p className="section-note is-wide">No colours in this selection.</p>;
  const shown = all ? groups : groups.slice(0, initial);
  return (
    <ul className="sel-colors is-wide" aria-label="Selection colors">
      {shown.map((g) => (
        <ColorRow key={g.id} group={g} />
      ))}
      {groups.length > initial && (
        <li>
          <button type="button" className="sel-colors-more" onClick={() => setAll((a) => !a)}>
            {all ? 'Show fewer colors' : `Show all ${groups.length} colors`}
          </button>
        </li>
      )}
    </ul>
  );
}

function ColorRow({ group }: { group: ColorGroup }) {
  const { doc, actor } = useDoc();
  const selection = useSelection();
  const { color, token, uses } = group;
  const label = token ? token.replace(/^--/, '') : hexLabel(color);
  const percent = String(Math.round(color.a * 100));
  const [hex, setHex] = useState(label);
  const [alpha, setAlpha] = useState(percent);
  useEffect(() => setHex(label), [label]);
  useEffect(() => setAlpha(percent), [percent]);

  // Edits show on the canvas while typed or picked (a preview), and commit once.
  const apply = (next: RGBA) => {
    endPreview();
    const value = formatColor(next);
    if (token) doc.setTokens(actor, [{ name: token, value }], `Changed ${token}`);
    else replaceColor(doc, actor, uses, value);
  };
  const preview = (next: RGBA | null) => {
    endPreview();
    if (next) previewColor(doc, uses, formatColor(next));
  };
  const hexColor = (raw: string): RGBA | null => {
    const parsed = parseColor(/^([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw.trim()) ? `#${raw.trim()}` : raw);
    return parsed && { ...parsed, a: parsed.a < 1 ? parsed.a : color.a };
  };
  const alphaColor = (raw: string): RGBA | null => {
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? { ...color, a: Math.min(100, Math.max(0, n)) / 100 } : null;
  };
  const commitHex = () => {
    const next = hexColor(hex);
    if (!next || hex.trim().toUpperCase() === label) {
      endPreview();
      return setHex(label);
    }
    apply(next);
  };
  const commitAlpha = () => {
    const next = alphaColor(alpha);
    if (!next || String(Math.round(next.a * 100)) === percent) {
      endPreview();
      return setAlpha(percent);
    }
    apply(next);
  };
  const toToken = () => {
    const tokens = doc.getTokens() as Token[];
    const base = `--color-${hexLabel(color).toLowerCase()}${color.a < 1 ? `-${percent}` : ''}`;
    let name = base;
    for (let i = 2; tokens.some((t) => t.name === name); i++) name = `${base}-${i}`;
    doc.batch(actor, `Created ${name} from a selection colour`, () => {
      doc.createTokens(actor, [{ name, type: 'color', value: formatColor(color) }]);
      replaceColor(doc, actor, uses, `var(${name})`);
    });
  };
  const keys = (e: KeyboardEvent<HTMLInputElement>, reset: () => void) => {
    const el = e.currentTarget;
    if (e.key === 'Enter') el.blur();
    if (e.key === 'Escape') {
      endPreview();
      reset();
      requestAnimationFrame(() => el.blur());
    }
  };
  const layers = [...new Set(uses.map((u) => u.nodeId))];

  return (
    <li className="sel-color">
      <div className="sel-color-chip">
        <Picker color={color} label={`${label} picker`} onPreview={(c) => {
            if (!token) setHex(hexLabel(c));
            preview({ ...c, a: color.a });
          }} onPick={(c) => apply({ ...c, a: color.a })} />
        {token ? (
          <span className="sel-color-token" data-tip={`Token ${token}`}>
            {label}
          </span>
        ) : (
          <input className="sel-color-hex" aria-label={`${label} hex`} value={hex} spellCheck={false} onFocus={(e) => e.currentTarget.select()} onChange={(e) => {
              setHex(e.target.value);
              preview(hexColor(e.target.value));
            }}
            onBlur={commitHex} onKeyDown={(e) => keys(e, () => setHex(label))} />
        )}
        <span className="sel-color-alpha">
          <input aria-label={`${label} opacity`} value={alpha} inputMode="numeric" onFocus={(e) => e.currentTarget.select()} onChange={(e) => {
              setAlpha(e.target.value);
              preview(alphaColor(e.target.value));
            }}
            onBlur={commitAlpha} onKeyDown={(e) => keys(e, () => setAlpha(percent))} />%
        </span>
      </div>
      {token ? (
        <span className="icon-button sel-color-action is-token" aria-label={`Uses token ${token}`} data-tip={`Token ${token}`}>
          {icons.token}
        </span>
      ) : (
        <button type="button" className="icon-button sel-color-action" aria-label={`Create token from ${label}`} data-tip="Create token" onClick={toToken}>
          {icons.token}
        </button>
      )}
      <button type="button" className="sel-color-uses" aria-label={`Select ${layers.length} layer${layers.length === 1 ? '' : 's'} using ${label}`} data-tip="Select layers with this colour" onClick={() => selection.set(layers)}>
        {icons.target}
        <span>{uses.length}</span>
      </button>
    </li>
  );
}

/** Swatch that opens the system picker: it previews while dragging and commits once, when the picker closes. */
function Picker({ color, label, onPick, onPreview }: { color: RGBA; label: string; onPick(c: RGBA): void; onPreview(c: RGBA): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const [live, setLive] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => {
      const c = parseColor(el.value);
      setLive(null);
      if (c) pick.current(c);
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);
  return (
    <label className="swatch sel-color-swatch" data-tip="Pick a colour">
      <span className="swatch-fill" style={{ background: live ?? formatColor(color) }} />
      <input
        ref={ref}
        type="color"
        className="sr-only"
        aria-label={label}
        value={live ?? `#${hexLabel(color).toLowerCase()}`}
        onChange={(e) => {
          setLive(e.target.value);
          const c = parseColor(e.target.value);
          if (c) onPreview(c);
        }}
      />
    </label>
  );
}
