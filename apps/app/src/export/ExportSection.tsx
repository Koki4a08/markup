import { useEffect, useId, useState } from 'react';
import { DEFAULT_EXPORT, EXPORT_FORMATS, SCALE_PATTERN, type ExportSetting, type MarkupNode } from '@markup/doc';
import { Section } from '../panels/fields/fields';
import { icons } from '../panels/icons';
import { useDoc } from '../store/DocProvider';
import { useDeep } from '../store/hooks';
import { exportNodes } from './actions';

/** Video formats exist in the schema but cannot be rendered yet. */
const FORMATS = EXPORT_FORMATS.filter((f) => f !== 'mp4' && f !== 'webm');
const SCALE_PRESETS = ['0.5x', '1x', '2x', '3x', '4x', '512w', '1080p'];

export function ExportSection({ nodes }: { nodes: MarkupNode[] }) {
  const { doc, actor } = useDoc();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const single = nodes.length === 1 ? nodes[0]! : null;
  const singleId = single?.id;
  const settings = useDeep(doc.nodes, () => (singleId ? doc.exportsOf(singleId) : []), [doc, singleId]);
  const write = (next: ExportSetting[]) => single && doc.setExports(actor, single.id, next);
  const patch = (i: number, change: Partial<ExportSetting>) => write(settings.map((s, j) => (j === i ? { ...s, ...change } : s)));

  const run = async () => {
    setBusy(true);
    setMessage('');
    try {
      const n = await exportNodes(doc, nodes.map((n) => n.id));
      setMessage(n ? `Exported ${n} file${n === 1 ? '' : 's'}` : 'Export cancelled');
    } catch (e) {
      setMessage(`Could not export: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Export">
      {settings.map((s, i) => (
        <ExportRow key={i} index={i + 1} setting={s} onChange={(c) => patch(i, c)} onRemove={() => write(settings.filter((_, j) => j !== i))} />
      ))}
      <div className="field-pair export-actions">
        <button type="button" className="text-button" aria-label="Add export setting" onClick={() => write([...settings, { ...DEFAULT_EXPORT }])}>
          {icons.plus} Add
        </button>
        <button type="button" className="text-button" disabled={busy} onClick={() => void run()}>
          {icons.download} {nodes.length > 1 ? `Export ${nodes.length} layers` : 'Export'}
        </button>
      </div>
      {message && (
        <p className="inline-status" role="status">
          {message}
        </p>
      )}
    </Section>
  );
}

function ExportRow({ index, setting, onChange, onRemove }: { index: number; setting: ExportSetting; onChange(change: Partial<ExportSetting>): void; onRemove(): void }) {
  const listId = useId();
  const [scale, setScale] = useState(setting.scale);
  useEffect(() => setScale(setting.scale), [setting.scale]);
  const commit = () => {
    const v = scale.trim().toLowerCase();
    if (v === setting.scale) return;
    if (SCALE_PATTERN.test(v)) onChange({ scale: v });
    else setScale(setting.scale);
  };
  return (
    <div className="export-row">
      <select aria-label={`Export format ${index}`} className="field-input" value={setting.format} onChange={(e) => onChange({ format: e.target.value as ExportSetting['format'] })}>
        {FORMATS.map((f) => (
          <option key={f} value={f}>
            {f.toUpperCase()}
          </option>
        ))}
      </select>
      <input
        aria-label={`Export scale ${index}`}
        className="field-input"
        list={listId}
        value={scale}
        spellCheck={false}
        data-tip="A multiplier like 2x, or a size like 512w, 512h or 1080p"
        onChange={(e) => setScale(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setScale(setting.scale);
        }}
      />
      <datalist id={listId}>
        {SCALE_PRESETS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <button type="button" className="icon-button" aria-label={`Remove export setting ${index}`} onClick={onRemove}>
        {icons.close}
      </button>
    </div>
  );
}
