import { useEffect, useState } from 'react';
import type { MarkupNode, Styles, StyleValue } from '@markup/doc';
import { icons } from './icons';
import { ColorField, common, MIXED, Section, SelectField, TextField, type FieldValue } from './fields/fields';
import { useDoc } from '../store/DocProvider';
import { useNodes } from '../store/hooks';
import { useSelection } from '../selection';
import { localFontsGranted, requestLocalFonts } from '../fonts/localFonts';

/** Style keys owned by a dedicated section; everything else lands in Other styles. */
const OWNED = new Set([
  'display', 'flexDirection', 'gap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'padding', 'alignItems', 'justifyContent', 'flexWrap',
  'width', 'height', 'flex', 'alignSelf',
  'backgroundColor', 'opacity',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'color',
  'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
  'position', 'left', 'top',
]);

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const;

/** Longhand padding value, falling back to the CSS shorthand. */
function paddingSide(s: Styles, side: (typeof SIDES)[number]): StyleValue | undefined {
  const own = s[`padding${side}`];
  if (own !== undefined) return own;
  if (s.padding === undefined) return undefined;
  const parts = String(s.padding).split(/\s+/);
  const [t, r = t, b = t, l = r] = parts;
  return { Top: t, Right: r, Bottom: b, Left: l }[side];
}

type Sizing = 'fixed' | 'fill' | 'fit';

function sizingOf(node: MarkupNode, parent: MarkupNode | undefined, dim: 'width' | 'height'): Sizing {
  const v = node.styles[dim];
  if (v === 'fit-content') return 'fit';
  const rowParent = parent?.styles.display === 'flex' && String(parent.styles.flexDirection ?? 'row').startsWith('row');
  const mainAxis = (dim === 'width') === rowParent;
  if (parent?.styles.display === 'flex' && ((mainAxis && node.styles.flex !== undefined) || (!mainAxis && node.styles.alignSelf === 'stretch'))) return 'fill';
  if (v === '100%') return 'fill';
  return 'fixed';
}

export function Inspector() {
  const { doc, actor } = useDoc();
  const selection = useSelection();
  const nodes = useNodes(selection.ids);
  const parents = useNodes(nodes.map((n) => n.parentId ?? '').filter(Boolean));
  if (nodes.length === 0) {
    return (
      <div className="inspector-body">
        <p className="empty-hint">Select a layer to edit its styles.</p>
      </div>
    );
  }
  const ids = nodes.map((n) => n.id);
  const parentOf = (n: MarkupNode) => parents.find((p) => p.id === n.parentId);
  const value = (key: string): FieldValue => common(nodes.map((n) => n.styles[key]));
  const set = (styles: Record<string, StyleValue | null>) => doc.updateStyles(actor, [{ nodeIds: ids, styles }]);
  const allText = nodes.every((n) => n.type === 'text');
  const anyFrame = nodes.some((n) => n.type === 'frame');
  const isFlex = value('display') === 'flex';

  const setSizing = (dim: 'width' | 'height', mode: Sizing) => {
    doc.batch(actor, `Set ${dim} to ${mode}`, () => {
      for (const n of nodes) {
        const parent = parentOf(n);
        const flexParent = parent?.styles.display === 'flex';
        const rowParent = flexParent && String(parent.styles.flexDirection ?? 'row').startsWith('row');
        const mainAxis = (dim === 'width') === rowParent;
        const measured = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(n.id)}"]`)?.getBoundingClientRect();
        const styles: Record<string, StyleValue | null> = {};
        if (mode === 'fit') Object.assign(styles, { [dim]: 'fit-content' }, mainAxis ? { flex: null } : { alignSelf: null });
        if (mode === 'fixed') {
          const px = measured ? Math.round(dim === 'width' ? measured.width : measured.height) : 100;
          Object.assign(styles, { [dim]: `${px}px` }, mainAxis ? { flex: null } : { alignSelf: null });
        }
        if (mode === 'fill') {
          if (!flexParent) styles[dim] = '100%';
          else if (mainAxis) Object.assign(styles, { flex: 1, [dim]: null });
          else Object.assign(styles, { alignSelf: 'stretch', [dim]: null });
        }
        doc.updateStyles(actor, [{ nodeIds: [n.id], styles }]);
      }
    });
  };

  const sizing = (dim: 'width' | 'height') => common(nodes.map((n) => sizingOf(n, parentOf(n), dim)));
  const other = [...new Set(nodes.flatMap((n) => Object.keys(n.styles)))].filter((k) => !OWNED.has(k)).sort();

  return (
    <div className="inspector-body">
      <header className="inspector-head">{nodes.length === 1 ? nodes[0]!.name : `${nodes.length} layers`}</header>

      {anyFrame && (
        <Section title="Layout">
          <SelectField label="Display" value={isFlex ? 'flex' : value('display') === MIXED ? MIXED : 'block'} options={[['flex', 'Flex'], ['block', 'Block']]} onChange={(v) => set({ display: v === 'block' ? null : v })} />
          {isFlex && (
            <>
              <SelectField label="Direction" value={value('flexDirection') ?? 'row'} options={[['row', 'Row'], ['column', 'Column'], ['row-reverse', 'Row reverse'], ['column-reverse', 'Column reverse']]} onChange={(v) => set({ flexDirection: v })} />
              <TextField label="Gap" unit="px" value={value('gap')} onCommit={(v) => set({ gap: v || null })} />
              <SelectField label="Align" value={value('alignItems')} options={[['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End'], ['stretch', 'Stretch'], ['baseline', 'Baseline']]} onChange={(v) => set({ alignItems: v })} />
              <SelectField label="Justify" value={value('justifyContent')} options={[['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End'], ['space-between', 'Space between'], ['space-around', 'Space around'], ['space-evenly', 'Space evenly']]} onChange={(v) => set({ justifyContent: v })} />
              <SelectField label="Wrap" value={value('flexWrap') ?? 'nowrap'} options={[['nowrap', 'No wrap'], ['wrap', 'Wrap']]} onChange={(v) => set({ flexWrap: v === 'nowrap' ? null : v })} />
            </>
          )}
          {SIDES.map((side) => (
            <TextField
              key={side}
              label={`Padding ${side.toLowerCase()}`}
              unit="px"
              value={common(nodes.map((n) => paddingSide(n.styles, side)))}
              onCommit={(v) => {
                const longhands: Record<string, StyleValue | null> = { padding: null };
                for (const s of SIDES) longhands[`padding${s}`] = s === side ? v || null : (common(nodes.map((n) => paddingSide(n.styles, s))) as StyleValue | undefined) ?? null;
                set(longhands);
              }}
            />
          ))}
        </Section>
      )}

      <Section title="Size">
        {(['width', 'height'] as const).map((dim) => (
          <div className="field-pair" key={dim}>
            <SelectField label={`${dim === 'width' ? 'Width' : 'Height'} sizing`} value={sizing(dim)} options={[['fixed', 'Fixed'], ['fill', 'Fill'], ['fit', 'Fit']]} onChange={(v) => setSizing(dim, v as Sizing)} />
            <TextField label={dim === 'width' ? 'W' : 'H'} unit="px" value={value(dim)} onCommit={(v) => set({ [dim]: v || null })} />
          </div>
        ))}
      </Section>

      <Section title="Fill">
        <ColorField label="Background" value={value('backgroundColor')} onCommit={(v) => set({ backgroundColor: v || null })} />
        <TextField label="Opacity" value={value('opacity')} placeholder="1" onCommit={(v) => set({ opacity: v === '' ? null : Number(v) })} />
      </Section>

      {allText && (
        <Section title="Text">
          <LocalFontsButton />
          <TextField label="Font" value={value('fontFamily')} placeholder="inherit" onCommit={(v) => set({ fontFamily: v || null })} />
          <TextField label="Size" unit="px" value={value('fontSize')} onCommit={(v) => set({ fontSize: v || null })} />
          <SelectField label="Weight" value={value('fontWeight') === undefined ? undefined : String(value('fontWeight'))} options={['100', '200', '300', '400', '500', '600', '700', '800', '900'].map((w) => [w, w])} onChange={(v) => set({ fontWeight: Number(v) })} />
          <TextField label="Line height" value={value('lineHeight')} placeholder="auto" onCommit={(v) => set({ lineHeight: v || null })} />
          <TextField label="Letter spacing" value={value('letterSpacing')} placeholder="0" onCommit={(v) => set({ letterSpacing: v || null })} />
          <SelectField label="Align text" value={value('textAlign')} options={[['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']]} onChange={(v) => set({ textAlign: v })} />
          <ColorField label="Color" value={value('color')} onCommit={(v) => set({ color: v || null })} />
        </Section>
      )}

      {anyFrame && <RadiusSection value={value} set={set} />}

      <Section title="Other styles">
        {other.map((key) => (
          <div className="field-pair" key={key}>
            <TextField label={key} value={value(key)} onCommit={(v) => set({ [key]: v || null })} />
            <button className="icon-button" aria-label={`Remove ${key}`} onClick={() => set({ [key]: null })}>
              {icons.close}
            </button>
          </div>
        ))}
        <AddStyle onAdd={(k, v) => set({ [k]: v })} />
      </Section>
    </div>
  );
}

function RadiusSection({ value, set }: { value: (k: string) => FieldValue; set: (s: Record<string, StyleValue | null>) => void }) {
  const corners = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const;
  const [perCorner, setPerCorner] = useState(corners.some((c) => value(`border${c}Radius`) !== undefined));
  return (
    <Section title="Radius">
      {perCorner ? (
        corners.map((c) => <TextField key={c} label={c.replace(/([A-Z])/g, ' $1').trim()} unit="px" value={value(`border${c}Radius`) ?? value('borderRadius')} onCommit={(v) => set({ [`border${c}Radius`]: v || null })} />)
      ) : (
        <TextField label="Radius" unit="px" value={value('borderRadius')} placeholder="0" onCommit={(v) => set({ borderRadius: v || null })} />
      )}
      <button className="text-button" onClick={() => setPerCorner((p) => !p)}>
        {perCorner ? 'Same for all corners' : 'Per corner'}
      </button>
    </Section>
  );
}

function AddStyle({ onAdd }: { onAdd(key: string, value: string): void }) {
  const [key, setKey] = useState('');
  const [val, setVal] = useState('');
  const submit = () => {
    const k = key.trim().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (k && val.trim()) onAdd(k, val.trim());
    setKey('');
    setVal('');
  };
  return (
    <form
      className="field-pair add-style"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input className="field-input" aria-label="New property" placeholder="property" value={key} onChange={(e) => setKey(e.target.value)} />
      <input className="field-input" aria-label="New value" placeholder="value" value={val} onChange={(e) => setVal(e.target.value)} />
      <button type="submit" className="text-button">
        Add
      </button>
    </form>
  );
}

/** Asks for access to the fonts installed on this machine; only a click may trigger the browser prompt. */
function LocalFontsButton() {
  const [state, setState] = useState<'unknown' | 'granted' | 'unavailable'>('unknown');
  useEffect(() => {
    let live = true;
    void localFontsGranted().then((ok) => live && ok && setState('granted'));
    return () => {
      live = false;
    };
  }, []);
  if (state === 'granted') return null;
  return (
    <button
      type="button"
      className="field-input"
      onClick={() => void requestLocalFonts().then((ok) => setState(ok ? 'granted' : 'unavailable'))}
      title={state === 'unavailable' ? 'Local fonts are not available or access was denied' : 'Let Markup see the fonts installed on this computer'}
    >
      Use local fonts
    </button>
  );
}
