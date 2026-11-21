import { memo, useEffect, useMemo, useState } from 'react';
import { resolveTokenValue, TOKEN_TYPES, type Token, type TokenType } from '@markup/doc';
import { icons } from './icons';
import { useDoc } from '../store/DocProvider';
import { useDeep, useNodes } from '../store/hooks';
import { useSelection } from '../canvas/selection';
import { useTokenUsage } from './tokenUsage';
import { contrast, hexLabel } from './color';
import { SelectionColors } from './SelectionColors';
import { useSubtreeTheme, type SubtreeTheme } from './selectionTheme';

const GROUP_LABELS: Record<TokenType, string> = {
  color: 'Colors',
  spacing: 'Spacing',
  radius: 'Radius',
  fontFamily: 'Font families',
  fontSize: 'Font sizes',
  fontWeight: 'Font weights',
  lineHeight: 'Line heights',
  letterSpacing: 'Letter spacing',
  opacity: 'Opacity',
  breakpoint: 'Breakpoints',
  container: 'Containers',
};

const TYPE_LABELS: Record<TokenType, string> = {
  color: 'Color',
  spacing: 'Spacing',
  radius: 'Radius',
  fontFamily: 'Font family',
  fontSize: 'Font size',
  fontWeight: 'Font weight',
  lineHeight: 'Line height',
  letterSpacing: 'Letter spacing',
  opacity: 'Opacity',
  breakpoint: 'Breakpoint',
  container: 'Container',
};

type Filter = 'all' | 'used';

/**
 * Theme: what the selection (or, with nothing selected, the page) is made of — light or dark, its colours,
 * type, radius and spacing — then the file's tokens grouped by type, what uses them, and editing.
 */
export const ThemePanel = memo(function ThemePanel({ pageRootId = '' }: { pageRootId?: string }) {
  const { doc } = useDoc();
  const tokens = useDeep(doc.ydoc.getArray('tokens'), () => doc.getTokens() as Token[], [doc]);
  const selection = useSelection();
  const scope = selection.ids.length ? selection.ids : pageRootId ? [pageRootId] : [];
  const theme = useSubtreeTheme(scope, tokens);
  const [only] = useNodes(selection.ids.length === 1 ? selection.ids : []);
  const scopeName = !selection.ids.length || only?.type === 'root' ? 'Page' : only ? only.name : `${selection.ids.length} layers`;
  // Kept incrementally from doc.nodes changes, so neither renders nor unrelated edits re-scan every node.
  const usage = useTokenUsage(doc);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const shown = tokens.filter((t) => (filter === 'all' || usage[t.name]) && (!q || t.name.toLowerCase().includes(q) || String(t.value).toLowerCase().includes(q)));
    return TOKEN_TYPES.map((type) => ({ type, items: shown.filter((t) => t.type === type) })).filter((g) => g.items.length);
  }, [tokens, usage, filter, q]);
  const usedCount = tokens.filter((t) => usage[t.name]).length;

  return (
    <div className="theme-panel">
      {scope.length > 0 && <ScopeTheme name={scopeName} theme={theme} />}
      <h3 className="theme-heading">File tokens</h3>
      <div className="theme-tools">
        <label className="search theme-search">
          <span className="row-icon">{icons.search}</span>
          <input type="search" aria-label="Search tokens" placeholder="Search tokens" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <div className="theme-tools-row">
          <div className="segmented is-small" role="radiogroup" aria-label="Show tokens">
            {(['all', 'used'] as const).map((f) => (
              <button key={f} role="radio" aria-checked={filter === f} className={`segment ${filter === f ? 'is-active' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? `All ${tokens.length}` : `In use ${usedCount}`}
              </button>
            ))}
          </div>
          <button className="icon-button" aria-label="Add token" data-tip="Add token" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
            {icons.plus}
          </button>
        </div>
        {adding && (
          <NewToken
            onDone={() => setAdding(false)}
            onError={setError}
          />
        )}
        {error && (
          <p className="theme-error" role="alert">
            {error}
          </p>
        )}
      </div>

      {tokens.length === 0 ? (
        <div className="panel-empty">
          <span className="panel-empty-icon">{icons.theme}</span>
          <p className="panel-empty-title">No tokens yet</p>
          <p className="panel-empty-text">Tokens are CSS variables shared by every layer in this file. Agents create them with create_tokens, or add one here.</p>
          {!adding && (
            <button className="topbar-button" onClick={() => setAdding(true)}>
              Add token
            </button>
          )}
        </div>
      ) : groups.length === 0 ? (
        <p className="empty-hint">{filter === 'used' && !q ? 'No layer uses a token yet. Reference one as var(--name) in a style.' : 'No tokens match this search.'}</p>
      ) : (
        groups.map((g) => (
          <section key={g.type} className="token-group" aria-label={GROUP_LABELS[g.type]}>
            <h3 className="token-group-title">
              {GROUP_LABELS[g.type]}
              <span className="token-group-count">{g.items.length}</span>
            </h3>
            <ul className="token-list">
              {g.items.map((t) => (
                <TokenRow key={t.name} token={t} uses={usage[t.name] ?? 0} onError={setError} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
});

function TokenRow({ token, uses, onError }: { token: Token; uses: number; onError(message: string | null): void }) {
  const { doc, actor } = useDoc();
  const [draft, setDraft] = useState(String(token.value));
  useEffect(() => setDraft(String(token.value)), [token.value]);
  const resolved = token.type === 'color' ? resolveTokenValue(doc, String(token.value)) : '';

  const commit = () => {
    const v = draft.trim();
    if (!v || v === String(token.value)) return setDraft(String(token.value));
    const value = typeof token.value === 'number' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    const [r] = doc.setTokens(actor, [{ name: token.name, value }]);
    onError(r?.result === 'error' ? (r.message ?? 'Could not update the token.') : null);
  };

  return (
    <li className="token-row">
      {token.type === 'color' ? <span className="token-swatch" style={{ background: resolved }} aria-hidden /> : <span className="token-type-dot" aria-hidden />}
      <span className="token-name" data-tip={token.description}>{token.name.replace(/^--/, '')}</span>
      <input
        className="token-value"
        aria-label={`${token.name} value`}
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraft(String(token.value));
            e.currentTarget.blur();
          }
        }}
      />
      <span className={`token-uses ${uses ? '' : 'is-unused'}`} data-tip={uses ? `Used by ${uses} layer${uses === 1 ? '' : 's'}` : 'Not used yet'}>
        {uses}
      </span>
      <button
        className="icon-button token-delete"
        aria-label={`Delete ${token.name}`}
        data-tip="Delete token"
        onClick={() => {
          const [r] = doc.setTokens(actor, [{ name: token.name, delete: true }]);
          onError(r?.result === 'error' ? (r.message ?? 'Could not delete the token.') : null);
        }}
      >
        {icons.trash}
      </button>
    </li>
  );
}

function NewToken({ onDone, onError }: { onDone(): void; onError(message: string | null): void }) {
  const { doc, actor } = useDoc();
  const [name, setName] = useState('');
  const [type, setType] = useState<TokenType>('color');
  const [value, setValue] = useState('');
  return (
    <form
      className="token-new"
      onSubmit={(e) => {
        e.preventDefault();
        const n = name.trim().replace(/^-*/, '--');
        const v = value.trim();
        if (n === '--' || !v) return onError('A token needs a name and a value.');
        const [r] = doc.createTokens(actor, [{ name: n, type, value: v }]);
        if (r?.result === 'error') return onError(r.message ?? 'Could not create the token.');
        onError(null);
        onDone();
      }}
    >
      <input className="field-input" aria-label="Token name" placeholder="brand-primary" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      <select className="field-input" aria-label="Token type" value={type} onChange={(e) => setType(e.target.value as TokenType)}>
        {TOKEN_TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      <input className="field-input" aria-label="Token value" placeholder={type === 'color' ? '#2f6fe8' : type === 'fontFamily' ? 'Inter, sans-serif' : '16px'} value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="token-new-actions">
        <button type="button" className="comment-button" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="comment-button is-primary">
          Add token
        </button>
      </div>
    </form>
  );
}

const ratioLabel = (r: number) => (r >= 7 ? 'AAA' : r >= 4.5 ? 'AA' : r >= 3 ? 'AA large' : 'Low');

/** The selection's theme, read from its layers: mode, background and text, colours, type, radius, spacing. */
function ScopeTheme({ name, theme }: { name: string; theme: SubtreeTheme }) {
  const { mode, background, text, colors, fonts, radii, spacing } = theme;
  const ratio = background && text ? contrast(background, text) : null;
  return (
    <section className="theme-scope" aria-label={`Theme of ${name}`}>
      <div className="theme-scope-head">
        <h3 className="theme-scope-title">{name}</h3>
        {mode && (
          <span className={`theme-mode is-${mode}`} data-tip={mode === 'dark' ? 'Dark background' : 'Light background'}>
            {mode === 'dark' ? icons.moon : icons.sun}
            {mode === 'dark' ? 'Dark' : 'Light'}
          </span>
        )}
      </div>
      {(background || text) && (
        <div className="theme-pair">
          <span className="theme-pair-sample" style={{ background: background ? `rgb(${background.r} ${background.g} ${background.b})` : 'transparent', color: text ? `rgb(${text.r} ${text.g} ${text.b})` : 'inherit' }} aria-hidden>
            Aa
          </span>
          <dl className="theme-pair-values">
            <dt>Background</dt>
            <dd>{background ? hexLabel(background) : '—'}</dd>
            <dt>Text</dt>
            <dd>{text ? hexLabel(text) : '—'}</dd>
          </dl>
          {ratio && (
            <span className={`theme-contrast ${ratio < 4.5 ? 'is-low' : ''}`} data-tip="WCAG contrast of the text on the background">
              {ratio.toFixed(1)}:1
              <small>{ratioLabel(ratio)}</small>
            </span>
          )}
        </div>
      )}
      <h4 className="theme-sub">
        Colors <span className="token-group-count">{colors.length}</span>
      </h4>
      <SelectionColors groups={colors} initial={8} />
      {fonts.length > 0 && (
        <>
          <h4 className="theme-sub">Typography</h4>
          <ul className="theme-fonts">
            {fonts.map((f) => (
              <li key={`${f.family}|${f.weight}|${f.size}`} className="theme-font">
                <span className="theme-font-name" style={{ fontFamily: f.family === 'Default' ? undefined : f.family, fontWeight: Number(f.weight) || undefined }}>
                  {f.family}
                </span>
                <span className="theme-font-meta">
                  {WEIGHT_NAMES[f.weight] ?? f.weight} · {f.size.replace(/px$/, '')}
                </span>
                <span className="token-uses" data-tip={`${f.count} text layer${f.count === 1 ? '' : 's'}`}>
                  {f.count}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {radii.length > 0 && <Scale title="Radius" items={radii} />}
      {spacing.length > 0 && <Scale title="Spacing" items={spacing} />}
    </section>
  );
}

function Scale({ title, items }: { title: string; items: SubtreeTheme['radii'] }) {
  return (
    <>
      <h4 className="theme-sub">{title}</h4>
      <ul className="theme-scale">
        {items.map((s) => (
          <li key={s.value} className="theme-chip" data-tip={`Used ${s.count} time${s.count === 1 ? '' : 's'}`}>
            {s.value.replace(/px$/, '')}
            <span>{s.count}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

const WEIGHT_NAMES: Record<string, string> = { '100': 'Thin', '200': 'Extra light', '300': 'Light', '400': 'Regular', '500': 'Medium', '600': 'Semibold', '700': 'Bold', '800': 'Extra bold', '900': 'Black', normal: 'Regular', bold: 'Bold' };
