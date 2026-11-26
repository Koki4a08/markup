import { useEffect, useRef, useState } from 'react';
import { AGENT_LABELS, AGENTS, INSTALL_COMMANDS, INSTALLED_PATHS, snippets, type Agent, type AgentReport, type AgentsReport } from '@markup/mcp/snippets';
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

type Scan = { status: 'loading' } | { status: 'ok'; report: AgentsReport } | { status: 'error' };

/** Asks the bundled `markup` sidecar which agents are on this computer and what their configs say. */
async function scanWithSidecar(): Promise<AgentsReport> {
  const { Command } = await import('@tauri-apps/plugin-shell');
  const result = await Command.sidecar('binaries/markup', ['agents', '--json']).execute();
  if (result.code !== 0) throw new Error(result.stderr.trim() || `markup exited with code ${result.code}.`);
  const report = JSON.parse(result.stdout) as AgentsReport;
  if (!Array.isArray(report?.agents)) throw new Error('markup agents returned no list.');
  return report;
}

/** A path under the home folder written from `~`. */
const tildify = (file: string, home: string) => (home && file.toLowerCase().startsWith(home.toLowerCase()) ? `~${file.slice(home.length)}` : file);

/** Where the agent's entry lives, for the line under its name. */
const configLabel = (a: AgentReport, home: string) => (a.agent === 'claude-code' ? 'claude mcp, user scope' : tildify(a.config, home));

/** Runs the bundled `markup` sidecar. The capability only allows `install <agent>` and `agents --json`. */
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
  const [scan, setScan] = useState<Scan>({ status: desktop ? 'loading' : 'error' });

  const rescan = async () => {
    try {
      setScan({ status: 'ok', report: await scanWithSidecar() });
    } catch {
      setScan({ status: 'error' });
    }
  };

  useEffect(() => {
    if (desktop) void rescan();
  }, [desktop]);
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
    if (next.status === 'ok') void rescan();
  };

  const command = os === 'windows' ? INSTALL_COMMANDS.windows : INSTALL_COMMANDS.unix;
  const report = scan.status === 'ok' ? scan.report : null;
  // Desktop: this computer's real paths. Elsewhere: the standalone CLI's, for a placeholder user.
  const all = snippets(report?.command ?? { command: INSTALLED_PATHS[os], args: ['mcp'] });
  const byAgent = new Map(report?.agents.map((a) => [a.agent, a]));
  // Without a scan (an older sidecar) every agent stays listed, and install itself refuses the missing ones.
  const listed = report ? AGENTS.filter((a) => byAgent.get(a)?.found) : [...AGENTS];
  const missing = report ? AGENTS.filter((a) => !byAgent.get(a)?.found) : [];

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

      {desktop && scan.status === 'loading' && (
        <p className="mcp-agents-empty" role="status">
          Looking for agents on this computer…
        </p>
      )}

      {desktop && scan.status !== 'loading' && listed.length === 0 && (
        <p className="mcp-agents-empty">No coding agents found on this computer. Install one, then open this again.</p>
      )}

      {desktop && scan.status !== 'loading' && listed.length > 0 && (
        <ul className="mcp-agents" aria-label="Agents">
          {listed.map((agent) => {
            const run = runs[agent];
            const label = AGENT_LABELS[agent];
            const found = byAgent.get(agent);
            const connected = run?.status === 'ok' || (!run && found?.state === 'set' && !found.problem);
            return (
              <li key={agent} className="mcp-agent">
                <div className="mcp-agent-row">
                  <span className="mcp-agent-text">
                    <span className="mcp-agent-name">{label}</span>
                    {found && report && (
                      <span className={`mcp-agent-path ${found.problem ? 'is-warn' : ''}`} title={found.problem ?? found.config}>
                        {found.problem ?? configLabel(found, report.home)}
                      </span>
                    )}
                  </span>
                  {connected ? (
                    <span className="mcp-added">
                      {icons.check}
                      {run?.status === 'ok' ? 'Added' : 'Connected'}
                    </span>
                  ) : (
                    <button className="mcp-add" aria-label={`Add to ${label}`} disabled={run?.status === 'running'} onClick={() => void add(agent)}>
                      {run?.status === 'running' ? 'Adding…' : run?.status === 'error' ? 'Try again' : found?.problem ? 'Repair' : 'Add'}
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

      {desktop && missing.length > 0 && <p className="mcp-agents-missing">Not found on this computer: {missing.map((a) => AGENT_LABELS[a]).join(', ')}.</p>}

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
                      <strong>{label}</strong> {report && agent !== 'claude-code' ? tildify(byAgent.get(agent)?.config ?? snippet.where, report.home) : snippet.where}
                    </span>
                    <CopyButton text={snippet.code} label={`Copy ${label} setup`} />
                  </div>
                  <pre>
                    <code>{snippet.code.trimEnd()}</code>
                  </pre>
                </li>
              );
            })}
            {!report && (
              <li className="mcp-hint">
                Replace “you” with your user name. <code>markup status</code> prints the exact path.
              </li>
            )}
          </ul>
        )}
      </div>

      <p className="mcp-panel-foot">Restart the agent after adding Markup, then ask it to look at your open file.</p>
    </div>
  );
}
