import { memo, useEffect, useState, type ReactNode } from 'react';
import { resolveTokenValue, type MarkupNode, type Styles, type StyleValue } from '@markup/doc';
import { glyphs, icons } from './icons';
import { common, MIXED, Section, SegmentedField, SelectField, type FieldValue } from './fields/fields';
import { ColorField, TextField } from './previewFields';
import { BorderSection, FiltersSection, OutlineSection, ShadowSection } from './EffectSections';
import { SelectionColors } from './SelectionColors';
import { useSubtreeTheme } from './selectionTheme';
import { useDoc } from '../store/DocProvider';
import { useDeep, useNodes } from '../store/hooks';
import { useSelection } from '../canvas/selection';
import { ExportSection } from '../export/ExportSection';
import { InlineRename } from '../ui/InlineRename';
import { isPreviewing, previewStyles, useLiveStyles } from '../canvas/preview';
import { localFontsGranted, requestLocalFonts } from '../fonts/localFonts';
import { stripInline, textStyles, weightValue } from './textStyles';
import { resolveConflicts } from './conflicts';
import { canvasNodeElement } from '../canvas/registry';

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

/** Background colour, falling back to a `background` shorthand that is only a colour. */
function backgroundOf(n: MarkupNode): StyleValue | undefined {
  const { backgroundColor, background } = n.styles;
  if (backgroundColor !== undefined) return backgroundColor;
  if (typeof background !== 'string' || /(url|gradient|image)\(|\//i.test(background)) return undefined;
  return background.trim().split(/\s+(?![^(]*\))/).length === 1 ? background.trim() : undefined;
}

/** Gap, falling back to equal row and column gaps (captured pages write the longhands). */
function gapOf(n: MarkupNode): StyleValue | undefined {
  const { gap, rowGap, columnGap } = n.styles;
  if (gap !== undefined) return gap;
  return rowGap !== undefined && rowGap === columnGap ? rowGap : undefined;
}

const isFlexDisplay = (v: StyleValue | undefined | typeof MIXED) => typeof v === 'string' && /^(inline-)?flex$/.test(v.trim());
const pxOf = (v: StyleValue | undefined): number | undefined => {
  if (typeof v === 'number') return v;
  const m = typeof v === 'string' ? /^(-?\d+(?:\.\d+)?)(px)?$/.exec(v.trim()) : null;
  return m ? Number(m[1]) : undefined;
};

/** A bare line height is a multiple of the font size; one too big to mean that (24) is taken as px. */
const lineHeightValue = (v: string): StyleValue | null => (!v ? null : /^\d+(\.\d+)?$/.test(v) && Number(v) >= 5 ? `${v}px` : v);

type Sizing = 'fixed' | 'fill' | 'fit';

function sizingOf(node: MarkupNode, parent: MarkupNode | undefined, dim: 'width' | 'height'): Sizing {
  const v = node.styles[dim];
  if (v === 'fit-content') return 'fit';
  const rowParent = isFlexDisplay(parent?.styles.display) && String(parent!.styles.flexDirection ?? 'row').startsWith('row');
  const mainAxis = (dim === 'width') === rowParent;
  const grows = node.styles.flex !== undefined || Number(node.styles.flexGrow ?? 0) > 0;
  if (isFlexDisplay(parent?.styles.display) && ((mainAxis && grows) || (!mainAxis && node.styles.alignSelf === 'stretch'))) return 'fill';
  if (v === '100%') return 'fill';
  return 'fixed';
}

/**
 * Memoized so the right panel's own re-renders (tab badge, resizer) skip it. `empty` replaces the
 * no-selection hint (the editor shows page settings there).
 */
export const Inspector = memo(function Inspector({ empty }: { empty?: ReactNode }) {
  const { doc, actor } = useDoc();
  const selection = useSelection();
  const nodes = useNodes(selection.ids);
  const parents = useNodes(nodes.map((n) => n.parentId ?? '').filter(Boolean));
  const live = useLiveStyles();
  // Swatches resolve var(--token) values, so token edits must re-render the fields.
  const tokens = useDeep(doc.ydoc.getArray('tokens'), () => doc.getTokens(), [doc]);
  const theme = useSubtreeTheme(selection.ids, tokens);
  if (nodes.length === 0) {
    if (empty) return empty;
    return (
      <div className="inspector-body">
        <div className="panel-empty">
          <span className="panel-empty-icon">{icons.move}</span>
          <p className="empty-hint">Select a layer to edit its styles.</p>
          <p className="panel-empty-text">Click a layer on the canvas or in Layers. Shift-click adds to the selection.</p>
        </div>
      </div>
    );
  }
  const parentOf = (n: MarkupNode) => parents.find((p) => p.id === n.parentId);
  // While a canvas gesture (a resize) runs, fields mirror its live values.
  const value = (key: string): FieldValue => common(nodes.map((n) => (live[n.id] && key in live[n.id]! ? (live[n.id]![key] ?? undefined) : n.styles[key])));
  const frames = nodes.filter((n) => n.type === 'frame');
  /**
   * Writes one edit per node, each made to show over what that node already stores (see resolveConflicts), as one
   * history entry. Inside runPreview (a field being typed or scrubbed) writes become canvas previews instead.
   */
  const write = (targets: MarkupNode[], editFor: (n: MarkupNode) => Record<string, StyleValue | null>) => {
    const updates = targets.map((n) => {
      const el = canvasNodeElement(n.id);
      return { nodeIds: [n.id], styles: resolveConflicts(n.styles, editFor(n), el ? getComputedStyle(el) : null) };
    });
    if (isPreviewing()) for (const u of updates) previewStyles(u.nodeIds, u.styles);
    else if (updates.length) doc.updateStyles(actor, updates);
  };
  const set = (styles: Record<string, StyleValue | null>) => write(nodes, () => styles);
  // Layout properties belong to frames: in a mixed selection, text and images keep their own flow.
  const setLayout = (styles: Record<string, StyleValue | null>) => write(frames, () => styles);
  // Text properties cover the whole layer: inline runs lose their own value and an inherited text fill gives way.
  const setText = (styles: Record<string, StyleValue | null>) => {
    if (isPreviewing()) return write(nodes, (n) => textStyles(doc, n, styles));
    doc.batch(actor, `Updated text styles on ${nodes.length} node${nodes.length === 1 ? '' : 's'}`, () => {
      write(nodes, (n) => textStyles(doc, n, styles));
      for (const n of nodes) {
        const html = n.type === 'text' ? stripInline(n.text ?? '', Object.keys(styles).filter((k) => styles[k] !== null)) : null;
        if (html !== null) doc.setText(actor, [{ nodeId: n.id, html }]);
      }
    });
  };
  /** A typed W or H is a fixed size: it ends Fill sizing on that axis and lifts a min/max that would clamp it. */
  const setDim = (dim: 'width' | 'height', v: string) =>
    write(nodes, (n) => {
      const styles: Record<string, StyleValue | null> = { [dim]: v || null };
      if (!v) return styles;
      const parent = parentOf(n);
      const flexParent = isFlexDisplay(parent?.styles.display);
      const mainAxis = flexParent && (dim === 'width') === String(parent!.styles.flexDirection ?? 'row').startsWith('row');
      if (mainAxis && (n.styles.flex !== undefined || Number(n.styles.flexGrow ?? 0) > 0)) Object.assign(styles, { flex: null, flexGrow: null, flexBasis: null });
      if (flexParent && !mainAxis && n.styles.alignSelf === 'stretch') styles.alignSelf = null;
      const size = pxOf(v);
      const cap = dim === 'width' ? { min: 'minWidth', max: 'maxWidth' } : { min: 'minHeight', max: 'maxHeight' };
      if (size !== undefined) {
        const min = pxOf(n.styles[cap.min]);
        const max = pxOf(n.styles[cap.max]);
        if (min !== undefined && min > size) styles[cap.min] = null;
        if (max !== undefined && max < size) styles[cap.max] = null;
      }
      return styles;
    });
  const allText = nodes.every((n) => n.type === 'text');
  const anyFrame = frames.length > 0;
  const display = common(frames.map((n) => n.styles.display));
  const isFlex = display !== MIXED && isFlexDisplay(display);
  const displayMode: FieldValue = display === MIXED ? MIXED : isFlex ? 'flex' : display === undefined || display === 'block' ? 'block' : undefined;
  const layoutValue = (key: string): FieldValue => common(frames.map((n) => n.styles[key]));

  const setSizing = (dim: 'width' | 'height', mode: Sizing) => {
    doc.batch(actor, `Set ${dim} to ${mode}`, () => {
      write(nodes, (n) => {
        const parent = parentOf(n);
        const flexParent = isFlexDisplay(parent?.styles.display);
        const rowParent = flexParent && String(parent!.styles.flexDirection ?? 'row').startsWith('row');
        const mainAxis = (dim === 'width') === rowParent;
        // Layout size (offsetWidth), not the on-screen box, which the canvas zoom scales.
        const el = canvasNodeElement(n.id);
        const styles: Record<string, StyleValue | null> = {};
        if (mode === 'fit') Object.assign(styles, { [dim]: 'fit-content' }, mainAxis ? { flex: null } : { alignSelf: null });
        if (mode === 'fixed') {
          const px = el ? Math.round(dim === 'width' ? el.offsetWidth : el.offsetHeight) : 100;
          Object.assign(styles, { [dim]: `${px}px` }, mainAxis ? { flex: null } : { alignSelf: null });
        }
        if (mode === 'fill') {
          if (!flexParent) styles[dim] = '100%';
          else if (mainAxis) Object.assign(styles, { flex: 1, [dim]: null });
          else Object.assign(styles, { alignSelf: 'stretch', [dim]: null });
        }
        // Captured pages spell flex as its longhands, which would override the shorthand.
        if ('flex' in styles) Object.assign(styles, { flexGrow: null, flexShrink: null, flexBasis: null });
        return styles;
      });
    });
  };

  // An artboard sits on the page, not in a container it could fill.
  const artboard = nodes.some((n) => parentOf(n)?.type === 'root');
  const sizing = (dim: 'width' | 'height') => common(nodes.map((n) => sizingOf(n, parentOf(n), dim)));

  const single = nodes.length === 1 ? nodes[0]! : null;
  const resolveColor = (v: string) => resolveTokenValue(doc, v);
  const direction = String(layoutValue('flexDirection') === MIXED ? 'row' : (layoutValue('flexDirection') ?? 'row'));

  return (
    <div className="inspector-body">
      <header className="inspector-head">
        {single ? (
          <InlineRename className="inspector-name" label="Layer name" tip="Double-click to rename" value={single.name} onCommit={(name) => doc.renameNodes(actor, [{ nodeId: single.id, name }])} />
        ) : (
          <span className="inspector-name">{`${nodes.length} layers`}</span>
        )}
        <span className="inspector-kind">{single ? KIND[single.type] : 'Mixed'}</span>
      </header>

      {anyFrame && (
        <Section title="Layout">
          <SegmentedField
            label="Display"
            value={displayMode}
            options={[
              { value: 'block', label: 'Block' },
              { value: 'flex', label: 'Flex' },
            ]}
            onChange={(v) => setLayout({ display: v === 'block' ? null : v })}
          />
          {isFlex && (
            <>
              <div className="layout-direction is-wide">
                <SegmentedField
                  label="Direction"
                  span={1}
                  value={layoutValue('flexDirection') ?? 'row'}
                  options={[
                    { value: 'row', label: 'Row', icon: icons.arrowRight },
                    { value: 'column', label: 'Column', icon: icons.arrowDown },
                    { value: 'row-reverse', label: 'Row reverse', icon: icons.arrowLeft },
                    { value: 'column-reverse', label: 'Column reverse', icon: icons.arrowUp },
                  ]}
                  onChange={(v) => setLayout({ flexDirection: v })}
                />
                <button
                  type="button"
                  className={`toggle-button ${layoutValue('flexWrap') === 'wrap' ? 'is-on' : ''}`}
                  aria-pressed={layoutValue('flexWrap') === 'wrap'}
                  aria-label="Wrap"
                  data-tip={layoutValue('flexWrap') === 'wrap' ? 'Wrap: on' : 'Wrap: off'}
                  onClick={() => setLayout({ flexWrap: layoutValue('flexWrap') === 'wrap' ? null : 'wrap' })}
                >
                  {icons.wrap}
                </button>
              </div>
              <div className="layout-align is-wide">
                <AlignGrid direction={direction} justify={layoutValue('justifyContent')} align={layoutValue('alignItems')} onPick={(justifyContent, alignItems) => setLayout({ justifyContent, alignItems })} />
                <div className="layout-align-fields">
                  <TextField label="Gap" unit="px" prefix={glyphs.gap} placeholder="0" value={common(frames.map(gapOf))} onCommit={(v) => setLayout({ gap: v || null, rowGap: null, columnGap: null })} />
                  <SelectField label="Justify" hideLabel value={layoutValue('justifyContent')} options={[['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End'], ['space-between', 'Space between'], ['space-around', 'Space around'], ['space-evenly', 'Space evenly']]} onChange={(v) => setLayout({ justifyContent: v })} />
                  <SelectField label="Align" hideLabel value={layoutValue('alignItems')} options={[['flex-start', 'Start'], ['center', 'Center'], ['flex-end', 'End'], ['stretch', 'Stretch'], ['baseline', 'Baseline']]} onChange={(v) => setLayout({ alignItems: v })} />
                </div>
              </div>
            </>
          )}
          <span className="field-caption is-wide">Padding</span>
          {SIDES.map((side) => (
            <TextField
              key={side}
              label={`Padding ${side.toLowerCase()}`}
              unit="px"
              prefix={glyphs[`pad${side}`]}
              placeholder="0"
              value={common(frames.map((n) => paddingSide(n.styles, side)))}
              onCommit={(v) =>
                // Each frame keeps its own other sides (a mixed selection has no shared value to copy).
                write(frames, (n) => {
                  const longhands: Record<string, StyleValue | null> = { padding: null };
                  for (const s of SIDES) longhands[`padding${s}`] = s === side ? v || null : (paddingSide(n.styles, s) ?? null);
                  return longhands;
                })
              }
            />
          ))}
        </Section>
      )}

      <Section title="Size">
        <TextField label="W" unit="px" prefix="W" placeholder="Auto" value={value('width')} onCommit={(v) => setDim('width', v)} />
        <TextField label="H" unit="px" prefix="H" placeholder="Auto" value={value('height')} onCommit={(v) => setDim('height', v)} />
        {(['width', 'height'] as const).map((dim) => (
          <SelectField key={dim} label={`${dim === 'width' ? 'Width' : 'Height'} sizing`} hideLabel value={sizing(dim)} options={artboard ? [['fixed', 'Fixed'], ['fit', 'Fit content']] : [['fixed', 'Fixed'], ['fill', 'Fill container'], ['fit', 'Fit content']]} onChange={(v) => setSizing(dim, v as Sizing)} />
        ))}
      </Section>

      <Section title="Fill">
        <div className="fill-row is-wide">
          <ColorField label="Background" span={1} resolve={resolveColor} value={common(nodes.map(backgroundOf))} onCommit={(v) => set({ backgroundColor: v || null })} />
          <TextField label="Opacity" prefix={glyphs.opacity} step={0.01} value={value('opacity')} placeholder="1" onCommit={(v) => set({ opacity: v === '' ? null : Number(v) })} />
        </div>
      </Section>

      {allText && (
        <Section title="Text" actions={<LocalFontsButton />}>
          <TextField label="Font" span={2} value={value('fontFamily')} placeholder="Inherited" onCommit={(v) => setText({ fontFamily: v || null })} />
          <SelectField label="Weight" hideLabel value={value('fontWeight') === MIXED ? MIXED : weightValue(value('fontWeight') as StyleValue | undefined)} options={WEIGHTS} onChange={(v) => setText({ fontWeight: Number(v) })} />
          <TextField label="Size" unit="px" prefix={glyphs.fontSize} value={value('fontSize')} placeholder="12" onCommit={(v) => setText({ fontSize: v || null })} />
          <TextField label="Line height" prefix={glyphs.lineHeight} value={value('lineHeight')} placeholder="Auto" onCommit={(v) => setText({ lineHeight: lineHeightValue(v) })} />
          <TextField label="Letter spacing" unit="px" prefix={glyphs.letterSpacing} value={value('letterSpacing')} placeholder="0" onCommit={(v) => setText({ letterSpacing: v || null })} />
          <SegmentedField
            label="Align text"
            value={value('textAlign')}
            options={[
              { value: 'left', label: 'Align left', icon: icons.alignTextLeft },
              { value: 'center', label: 'Align center', icon: icons.alignTextCenter },
              { value: 'right', label: 'Align right', icon: icons.alignTextRight },
              { value: 'justify', label: 'Justify', icon: icons.alignTextJustify },
            ]}
            onChange={(v) => setText({ textAlign: v })}
          />
          <ColorField label="Color" resolve={resolveColor} value={value('color')} onCommit={(v) => setText({ color: v || null })} />
        </Section>
      )}

      {nodes.every((n) => n.type === 'svg') && (
        <Section title="Vector">
          <ColorField label="Icon color" resolve={resolveColor} value={value('color')} onCommit={(v) => set({ color: v || null })} />
          <p className="section-note is-wide">Paints the parts drawn with currentColor. Fixed colours are under Selection colors.</p>
        </Section>
      )}

      <RadiusSection value={value} set={set} />

      <OutlineSection nodes={nodes} set={set} resolve={resolveColor} />
      <BorderSection nodes={nodes} set={set} resolve={resolveColor} />
      <ShadowSection nodes={nodes} set={set} resolve={resolveColor} inset={false} text={allText} />
      {!allText && <ShadowSection nodes={nodes} set={set} resolve={resolveColor} inset />}
      <FiltersSection nodes={nodes} set={set} />

      <Section title="Selection colors">
        <SelectionColors groups={theme.colors} />
      </Section>

      <ExportSection nodes={nodes} />
    </div>
  );
});

const KIND: Record<MarkupNode['type'], string> = { root: 'Page', frame: 'Frame', text: 'Text', image: 'Image', svg: 'Vector' };
const WEIGHTS: [string, string][] = [
  ['100', 'Thin'],
  ['200', 'Extra light'],
  ['300', 'Light'],
  ['400', 'Regular'],
  ['500', 'Medium'],
  ['600', 'Semibold'],
  ['700', 'Bold'],
  ['800', 'Extra bold'],
  ['900', 'Black'],
];

const POSITIONS = ['flex-start', 'center', 'flex-end'] as const;
const norm = (v: FieldValue) => (v === 'start' ? 'flex-start' : v === 'end' ? 'flex-end' : v === undefined ? 'flex-start' : v);
const ROW_NAMES = ['top', 'middle', 'bottom'];
const COL_NAMES = ['left', 'center', 'right'];

/**
 * 3×3 alignment pad: the cell is where children sit in the frame. For a row the columns pick
 * justify-content and the rows pick align-items; a column swaps the two.
 */
function AlignGrid({ direction, justify, align, onPick }: { direction: string; justify: FieldValue; align: FieldValue; onPick(justify: string, align: string): void }) {
  const column = direction.startsWith('column');
  const j = norm(justify);
  const a = norm(align);
  return (
    <div className="align-grid" role="group" aria-label="Alignment">
      {ROW_NAMES.map((rowName, r) =>
        COL_NAMES.map((colName, c) => {
          const cellJustify = POSITIONS[column ? r : c]!;
          const cellAlign = POSITIONS[column ? c : r]!;
          const on = j === cellJustify && a === cellAlign;
          const name = rowName === 'middle' && colName === 'center' ? 'Align center' : `Align ${rowName} ${colName}`;
          return (
            <button key={`${r}${c}`} type="button" className={`align-cell ${on ? 'is-on' : ''} ${column ? 'is-column' : ''}`} aria-label={name} aria-pressed={on} data-tip={name} onClick={() => onPick(cellJustify, cellAlign)}>
              <span className="align-mark" />
            </button>
          );
        }),
      )}
    </div>
  );
}

function RadiusSection({ value, set }: { value: (k: string) => FieldValue; set: (s: Record<string, StyleValue | null>) => void }) {
  const corners = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'] as const;
  const cornerGlyph = { TopLeft: glyphs.cornerTL, TopRight: glyphs.cornerTR, BottomRight: glyphs.cornerBR, BottomLeft: glyphs.cornerBL };
  const corner = (c: (typeof corners)[number]) => value(`border${c}Radius`) ?? value('borderRadius');
  // Captured pages write the four corners; equal ones read as one radius.
  const sameCorners = () => {
    const all = corners.map((c) => value(`border${c}Radius`));
    return all.every((v) => v !== undefined && v === all[0]) ? all[0] : undefined;
  };
  const [perCorner, setPerCorner] = useState(corners.some((c) => value(`border${c}Radius`) !== undefined) && sameCorners() === undefined);
  return (
    <Section
      title="Radius"
      actions={
        <button type="button" className={`toggle-button is-small ${perCorner ? 'is-on' : ''}`} aria-pressed={perCorner} aria-label="Per corner" data-tip={perCorner ? 'Same for all corners' : 'Per corner'} onClick={() => setPerCorner((p) => !p)}>
          {icons.corners}
        </button>
      }
    >
      {perCorner ? (
        corners.map((c) => (
          <TextField
            key={c}
            label={c.replace(/([A-Z])/g, ' $1').trim()}
            unit="px"
            prefix={cornerGlyph[c]}
            placeholder="0"
            value={corner(c)}
            // A stored shorthand is split per node so the other corners keep their radius (see resolveConflicts).
            onCommit={(v) => set({ [`border${c}Radius`]: v || null })}
          />
        ))
      ) : (
        <TextField label="Radius" unit="px" prefix={glyphs.radius} value={value('borderRadius') ?? sameCorners()} placeholder="0" onCommit={(v) => set({ borderRadius: v || null })} />
      )}
    </Section>
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
      className="text-button section-text-action"
      onClick={() => void requestLocalFonts().then((ok) => setState(ok ? 'granted' : 'unavailable'))}
      data-tip={state === 'unavailable' ? 'Local fonts are not available or access was denied' : 'Let Markup see the fonts installed on this computer'}
    >
      Use local fonts
    </button>
  );
}
