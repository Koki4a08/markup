import { useEffect, useRef, useState } from 'react';
import { AGENT_LABELS, AGENTS, snippets, type Agent } from '@markup/mcp/snippets';
import { copyText, inTauri } from '../export/clipboard';
import { icons } from './icons';
import { useDismiss } from '../ui/useDismiss';

/** What the snippets show for the server binary: the editor cannot know where the user keeps `markup`. */
export const PLACEHOLDER_PATH = '<path to markup>';

interface RunState {
  status: 'running' | 'ok' | 'error';
  output: string;
}

/** Runs the bundled `markup` sidecar. The capability only allows `install <agent>`. */
async function installWithSidecar(agent: Agent): Promise<RunState> {
  const { Command } = await import('@tauri-apps/plugin-shell');
  const result = await Command.sidecar('binaries/markup', ['install', agent]).execute();
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  return { status: result.code === 0 ? 'ok' : 'error', output: output || (result.code === 0 ? 'Done.' : `markup exited with code ${result.code}.`) };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className="icon-button"
      data-tip={copied ? 'Copied' : label}
      aria-label={label}
      onClick={() => copyText(text).then(() => setCopied(true), () => setCopied(false))}
    >
      {copied ? icons.check : icons.copy}
    </button>
  );
}

/** "Connect an agent": one-click installs on desktop, copyable setup everywhere. */
export function McpPanel({ onClose, desktop = inTauri() }: { onClose(): void; desktop?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [runs, setRuns] = useState<Partial<Record<Agent, RunState>>>({});
  const all = snippets({ command: PLACEHOLDER_PATH, args: ['mcp'] });
  // Resize only: it holds install output, which switching apps to check on the agent must not throw away.
  useDismiss(onClose, { ref, blur: false, wheel: false });

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as Element | null)?.closest?.('[data-mcp-toggle]')) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        // Back to the toggle that opened it, as the settings menu does.
        document.querySelector<HTMLElement>('[data-mcp-toggle]')?.focus();
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const add = async (agent: Agent) => {
    setRuns((r) => ({ ...r, [agent]: { status: 'running', output: '' } }));
    let next: RunState;
    try {
      next = await installWithSidecar(agent);
    } catch (err) {
      next = { status: 'error', output: err instanceof Error ? err.message : String(err) };
    }
    setRuns((r) => ({ ...r, [agent]: next }));
  };

  return (
    <div className="mcp-panel" ref={ref} role="region" aria-label="Connect an agent">
      <div className="mcp-panel-head">
        <span className="mcp-panel-title">Connect an agent</span>
        <button className="icon-button" aria-label="Close" data-tip="Close" onClick={onClose}>
          {icons.close}
        </button>
      </div>
      <p className="mcp-panel-note">
        {desktop ? 'Add Markup to an agent with one click, or set it up by hand.' : 'Agents reach this editor through the markup command. Add it to your agent:'}
      </p>
      <ul className="mcp-agents">
        {AGENTS.map((agent) => {
          const run = runs[agent];
          const snippet = all[agent];
          const label = AGENT_LABELS[agent];
          return (
            <li key={agent} className="mcp-agent">
              <div className="mcp-agent-row">
                <span className="mcp-agent-name">{label}</span>
                {desktop && (
                  <button className="mcp-add" disabled={run?.status === 'running'} onClick={() => void add(agent)}>
                    {run?.status === 'running' ? 'Adding…' : `Add to ${label}`}
                  </button>
                )}
              </div>
              {run && run.status !== 'running' && (
                <pre className={`mcp-output is-${run.status}`} role="status">
                  {run.output}
                </pre>
              )}
              <div className="mcp-snippet">
                <div className="mcp-snippet-head">
                  <span>{snippet.where}</span>
                  <CopyButton text={snippet.code} label={`Copy ${label} setup`} />
                </div>
                <pre>
                  <code>{snippet.code.trimEnd()}</code>
                </pre>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
