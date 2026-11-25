import { useEffect, useRef, useState } from 'react';
import { AGENT_LABELS, AGENTS, INSTALL_COMMANDS, INSTALLED_PATHS, snippets, type Agent } from '@markup/mcp/snippets';
import { copyText, inTauri } from '../export/clipboard';
import { isMacPlatform } from '../commands/keyboard';
import { icons } from './icons';
import { SegmentThumb } from '../ui/SegmentThumb';
import { useDismiss } from '../ui/useDismiss';

type Os = 'mac' | 'linux' | 'windows';

/** The visitor's system, for the right install command and config path. */
function detectOs(): Os {
  if (typeof navigator === 'undefined') return 'mac';
  if (isMacPlatform()) return 'mac';
  return /Win/i.test(navigator.platform || navigator.userAgent) ? 'windows' : 'linux';
}

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

/**
 * "Connect an agent". Desktop: one click per agent through the bundled CLI. Everywhere: the one-line
 * installer for the standalone CLI, and the raw config for people who edit it by hand.
 */
export function McpPanel({ onClose, desktop = inTauri() }: { onClose(): void; desktop?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [runs, setRuns] = useState<Partial<Record<Agent, RunState>>>({});
  const [os, setOs] = useState<Os>(detectOs);
  const [manual, setManual] = useState(false);
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

  const command = os === 'windows' ? INSTALL_COMMANDS.windows : INSTALL_COMMANDS.unix;
  const all = snippets({ command: INSTALLED_PATHS[os], args: ['mcp'] });

  return (
    <div className="mcp-panel" ref={ref} role="region" aria-label="Connect an agent">
      <div className="mcp-panel-head">
        <span className="mcp-panel-title">Connect an agent</span>
        <button className="icon-button" aria-label="Close" data-tip="Close" onClick={onClose}>
          {icons.close}
        </button>
      </div>
      <p className="mcp-panel-note">
        {desktop
          ? 'Add Markup to your agent with one click. It can then read and edit the file you have open.'
          : 'One command installs the markup CLI and asks which of your agents to connect.'}
      </p>

      {desktop && (
        <ul className="mcp-agents" aria-label="Agents">
          {AGENTS.map((agent) => {
            const run = runs[agent];
            const label = AGENT_LABELS[agent];
            return (
              <li key={agent} className="mcp-agent">
                <div className="mcp-agent-row">
                  <span className="mcp-agent-name">{label}</span>
                  {run?.status === 'ok' ? (
                    <span className="mcp-added">
                      {icons.check}
                      Added
                    </span>
                  ) : (
                    <button className="mcp-add" aria-label={`Add to ${label}`} disabled={run?.status === 'running'} onClick={() => void add(agent)}>
                      {run?.status === 'running' ? 'Adding…' : run?.status === 'error' ? 'Try again' : 'Add'}
                    </button>
                  )}
                </div>
                {run && run.status !== 'running' && (
                  <pre className={`mcp-output is-${run.status}`} role="status">
                    {run.status === 'ok' ? `${run.output}\nRestart ${label} so it loads Markup.` : run.output}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <section className="mcp-section" aria-label="Install from a terminal">
        <div className="mcp-section-head">
          <span className="mcp-section-title">{desktop ? 'Or from a terminal' : 'Run in a terminal'}</span>
          <div className="segmented is-small" role="radiogroup" aria-label="System">
            <SegmentThumb />
            {(
              [
                ['unix', 'macOS, Linux'],
                ['windows', 'Windows'],
              ] as const
            ).map(([id, text]) => {
              const on = id === 'windows' ? os === 'windows' : os !== 'windows';
              return (
                <button
                  key={id}
                  role="radio"
                  aria-checked={on}
                  className={`segment ${on ? 'is-active' : ''}`}
                  onClick={() => setOs(id === 'windows' ? 'windows' : isMacPlatform() ? 'mac' : 'linux')}
                >
                  {text}
                </button>
              );
            })}
          </div>
        </div>
        <div className="mcp-command">
          <code>
            <span className="mcp-prompt" aria-hidden>
              {os === 'windows' ? '>' : '$'}
            </span>
            {command}
          </code>
          <CopyButton text={command} label="Copy install command" />
        </div>
        <p className="mcp-hint">
          {os === 'windows' ? 'Paste it in PowerShell.' : 'Paste it in Terminal.'} Then <code>markup status</code> shows what is connected and{' '}
          <code>markup update</code> gets the newest version.
        </p>
      </section>

      <div className="mcp-manual">
        <button type="button" className="mcp-manual-toggle" aria-expanded={manual} onClick={() => setManual((m) => !m)}>
          <span className={`twisty ${manual ? 'is-open' : ''}`} aria-hidden>
            {icons.chevron}
          </span>
          Edit a config by hand
        </button>
        {manual && (
          <ul className="mcp-snippets">
            {AGENTS.map((agent) => {
              const snippet = all[agent];
              const label = AGENT_LABELS[agent];
              return (
                <li key={agent} className="mcp-snippet">
                  <div className="mcp-snippet-head">
                    <span>
                      <strong>{label}</strong> {snippet.where}
                    </span>
                    <CopyButton text={snippet.code} label={`Copy ${label} setup`} />
                  </div>
                  <pre>
                    <code>{snippet.code.trimEnd()}</code>
                  </pre>
                </li>
              );
            })}
            <li className="mcp-hint">Replace “you” with your user name. <code>markup status</code> prints the exact path.</li>
          </ul>
        )}
      </div>

      <p className="mcp-panel-foot">Restart the agent after adding Markup, then ask it to look at your open file.</p>
    </div>
  );
}
