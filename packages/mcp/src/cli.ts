import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BRIDGE_PORT } from '@markup/protocol';
import { connectOrHost, resilientHub, type Hub } from './hub';
import { configPath, defaultServerCommand, detectAgent, entryProblem, install, INSTALL_TARGETS, readConfig, systemEnv, uninstall, type InstallEnv, type InstallTarget } from './install';
import { probeBridge } from './probe';
import { createServer } from './server';
import { AGENT_LABELS, AGENTS, type Agent, type ServerCommand } from './snippets';
import { c, interactive, multiSelect, row, sym, write } from './ui';
import { installCommand, isScriptInstall, latestVersion, SITE, updateCommand } from './update';
import { compareVersions, VERSION } from './version';

const USAGE = `${c.bold('markup')} ${c.dim(VERSION)}
Connects coding agents to the Markup design canvas.

${c.bold('Usage')}
  markup setup [agent...]       Find your agents and connect them to Markup
  markup status                 Check each agent, and whether Markup is open
  markup update                 Install the newest markup CLI
  markup uninstall [agent...]   Remove Markup from your agents
  markup install <agent>        Connect one agent without asking anything
  markup mcp                    Run the MCP server over stdio (your agent starts this)

${c.bold('Options')}
  -y, --yes            setup: connect every agent found, without asking
      --all            setup, uninstall: every supported agent
      --command <path> setup, install: point agents at another markup binary
  -v, --version        Print the version
  -h, --help           Print this help

${c.bold('Agents')}
  ${AGENTS.join(', ')}
  install also accepts "print", which prints every config snippet and changes nothing.`;

const fail = (scope: string, message: string): never => {
  process.stderr.write(`markup ${scope}: ${message}\n`);
  process.exit(1);
};

const home = os.homedir();
const tildify = (p: string) => (p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p);
const LABEL_WIDTH = Math.max(...AGENTS.map((a) => AGENT_LABELS[a].length));

const ALIASES: Record<string, Agent> = { claude: 'claude-code', code: 'vscode', 'vs-code': 'vscode', 'gemini-cli': 'gemini', 'claude-app': 'claude-desktop' };
const toAgent = (name: string): Agent | null => ((AGENTS as readonly string[]).includes(name) ? (name as Agent) : (ALIASES[name] ?? null));

interface Flags {
  yes: boolean;
  all: boolean;
  command?: string;
  agents: Agent[];
}

function parseFlags(scope: string, args: string[], allowed: (keyof Flags)[]): Flags {
  const flags: Flags = { yes: false, all: false, agents: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if ((a === '-y' || a === '--yes') && allowed.includes('yes')) flags.yes = true;
    else if (a === '--all' && allowed.includes('all')) flags.all = true;
    else if (a === '--command' && allowed.includes('command') && args[i + 1]) flags.command = args[++i];
    else if (!a.startsWith('-') && allowed.includes('agents')) {
      const agent = toAgent(a);
      if (!agent) fail(scope, `unknown agent "${a}". Expected one of ${AGENTS.join(', ')}.`);
      else if (!flags.agents.includes(agent)) flags.agents.push(agent);
    } else fail(scope, `unknown option "${a}". Run markup --help.`);
  }
  return flags;
}

/** What agents should start: --command, else this very binary (or node with this script). */
const serverEntry = (commandPath?: string): ServerCommand =>
  commandPath ? { command: commandPath, args: ['mcp'] } : defaultServerCommand(process.execPath, fileURLToPath(import.meta.url));

/** systemEnv without its own logging: the commands here print their own summary. */
const quietEnv = (): InstallEnv => ({ ...systemEnv(home), log: () => {} });

const header = (title: string) => {
  write();
  write(`  ${c.bold('Markup')} ${c.dim(VERSION)}  ${c.dim(sym.dot)}  ${title}`);
  write();
};

/** First line in the row, the rest indented under it. */
function failRow(label: string, message: string) {
  const [first = '', ...more] = message.split('\n');
  row('fail', label, first, LABEL_WIDTH);
  for (const line of more) write(`    ${' '.repeat(LABEL_WIDTH)}  ${c.dim(line)}`);
}

async function runMcp() {
  const port = Number(process.env.MARKUP_BRIDGE_PORT ?? BRIDGE_PORT);
  let first: Hub;
  try {
    // Fail fast on a foreign port owner, and keep this hub open so the editor registers before the first call.
    first = await connectOrHost(port);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return fail('mcp', e.code === 'EACCES' ? `Port ${port} is reserved by the system (EACCES). Free it, then restart your agent.` : e.message);
  }
  const server = createServer(resilientHub(port, {}, first));
  await server.connect(new StdioServerTransport());
}

function runInstall(rest: string[]) {
  const [target, ...flags] = rest;
  const resolved = target === 'print' ? 'print' : target ? toAgent(target) : null;
  if (!resolved) return fail('install', `expected one of ${INSTALL_TARGETS.join(', ')}${target ? `, got "${target}"` : ''}.\nRun markup --help.`);
  const { command } = parseFlags('install', flags, ['command']);
  const result = install(resolved as InstallTarget, serverEntry(command), systemEnv(home));
  if (!result.ok) return fail('install', result.message);
  if (result.message) process.stdout.write(`${result.message}\n`);
}

async function runSetup(rest: string[]) {
  const flags = parseFlags('setup', rest, ['yes', 'all', 'command', 'agents']);
  const env = quietEnv();
  const entry = serverEntry(flags.command);
  header('Connect your agents');

  let targets: Agent[];
  if (flags.agents.length) targets = flags.agents;
  else if (flags.all) targets = [...AGENTS];
  else {
    const found = AGENTS.map((agent) => ({ agent, via: detectAgent(agent, env) }));
    const present = found.filter((f) => f.via);
    if (flags.yes || !interactive) {
      targets = present.map((f) => f.agent);
      if (!targets.length) {
        write(`  No coding agents found on this computer. Name one to set it up anyway:`);
        write(`    markup setup cursor`);
        write();
        process.exitCode = 1;
        return;
      }
    } else {
      const order = [...present, ...found.filter((f) => !f.via)];
      write(present.length ? `  Found ${present.length} ${present.length === 1 ? 'agent' : 'agents'} on this computer. Choose where to add Markup:` : '  No agents found on this computer. Pick the ones you use:');
      write();
      const picked = await multiSelect(order.map((f) => ({ label: AGENT_LABELS[f.agent], hint: f.via ? tildify(f.via) : 'not found', checked: Boolean(f.via) })));
      if (!picked) return write(`  Cancelled. Nothing changed.\n`);
      targets = order.filter((_, i) => picked[i]).map((f) => f.agent);
      if (!targets.length) return write(`  Nothing selected. Nothing changed.\n`);
    }
  }

  let failed = 0;
  for (const agent of targets) {
    const result = install(agent, entry, env);
    if (result.ok) row('ok', AGENT_LABELS[agent], agent === 'claude-code' ? 'claude mcp add, user scope' : tildify(configPath(agent, env)), LABEL_WIDTH);
    else {
      failed++;
      failRow(AGENT_LABELS[agent], result.message);
    }
  }

  const done = targets.length - failed;
  write();
  if (done) {
    write(`  ${c.bold('Next')}`);
    write(`  1. Open Markup and open a file. No app yet? ${c.cyan(`${SITE}/download/`)}`);
    write(`  2. Restart any agent that was already running, so it loads Markup.`);
    write(`  3. Ask it: ${c.dim('"Read my Markup file and design a pricing section."')}`);
    write();
    write(`  Check your setup anytime with ${c.bold('markup status')}.`);
    write();
  }
  if (failed) process.exitCode = 1;
}

async function runStatus() {
  const env = quietEnv();
  const port = Number(process.env.MARKUP_BRIDGE_PORT ?? BRIDGE_PORT);
  const managed = isScriptInstall(process.execPath, home, process.platform);
  // Both wait on the network or the editor's retry, so run them while the agents are checked.
  const [probe, latest] = [probeBridge(port), managed ? latestVersion() : Promise.resolve(null)];

  header('Status');
  write(`  ${c.bold('Agents')}`);
  let fixable = 0;
  for (const agent of AGENTS) {
    const label = AGENT_LABELS[agent];
    const config = readConfig(agent, env);
    if (config.state === 'unreadable') {
      fixable++;
      row('fail', label, config.message, LABEL_WIDTH);
    } else if (config.state === 'set') {
      const problem = entryProblem(config.entry);
      if (problem) {
        fixable++;
        row('warn', label, problem, LABEL_WIDTH);
      } else row('ok', label, `connected ${c.dim(`(${tildify(config.entry.command)})`)}`, LABEL_WIDTH);
    } else if (detectAgent(agent, env)) {
      fixable++;
      row('off', label, `not connected yet  markup setup ${agent}`, LABEL_WIDTH);
    } else row('off', label, 'not installed', LABEL_WIDTH);
  }

  write();
  write(`  ${c.bold('Markup')}`);
  const bridge = await probe;
  if (bridge.state === 'editor') row('ok', 'Editor', `open, ${bridge.files} ${bridge.files === 1 ? 'file' : 'files'} in tabs`, LABEL_WIDTH);
  else if (bridge.state === 'agent') row('ok', 'Bridge', `running on 127.0.0.1:${port}, an agent is connected`, LABEL_WIDTH);
  else if (bridge.state === 'none') row('off', 'Editor', `not open. Open Markup to let agents in. ${SITE}/download/`, LABEL_WIDTH);
  else row('fail', 'Bridge', bridge.message, LABEL_WIDTH);

  write();
  const newest = await latest;
  if (newest && compareVersions(newest, VERSION) > 0) write(`  ${c.yellow(`markup ${newest} is out.`)} Run ${c.bold('markup update')}.`);
  if (fixable) write(`  Run ${c.bold('markup setup')} to connect or repair agents.`);
  write(`  ${c.dim(`${tildify(process.execPath)}  ${sym.dot}  bridge 127.0.0.1:${port}`)}`);
  write();
}

async function runUninstall(rest: string[]) {
  const flags = parseFlags('uninstall', rest, ['all', 'agents']);
  const env = quietEnv();
  header('Remove Markup from agents');

  let targets: Agent[];
  if (flags.agents.length) targets = flags.agents;
  else {
    const connected = AGENTS.filter((agent) => readConfig(agent, env).state === 'set');
    if (flags.all) targets = connected;
    else if (!interactive) return fail('uninstall', 'name the agents to remove, or pass --all.');
    else {
      if (!connected.length) return write(`  Markup is not set up in any agent. Nothing to remove.\n`);
      write('  Markup is set up in these agents. Choose the ones to remove it from:');
      write();
      const picked = await multiSelect(connected.map((agent) => ({ label: AGENT_LABELS[agent], hint: agent === 'claude-code' ? 'user scope' : tildify(configPath(agent, env)), checked: true })));
      if (!picked) return write(`  Cancelled. Nothing changed.\n`);
      targets = connected.filter((_, i) => picked[i]);
    }
  }
  if (!targets.length) return write(`  Nothing to remove.\n`);

  let failed = 0;
  for (const agent of targets) {
    const result = uninstall(agent, env);
    if (!result.ok) {
      failed++;
      failRow(AGENT_LABELS[agent], result.message);
    } else if (result.message.startsWith('markup was not set up')) row('off', AGENT_LABELS[agent], 'was not set up', LABEL_WIDTH);
    else row('ok', AGENT_LABELS[agent], agent === 'claude-code' ? 'removed' : `removed, old file kept as ${path.basename(configPath(agent, env))}.bak`, LABEL_WIDTH);
  }
  write();
  if (failed) process.exitCode = 1;
}

async function runUpdate() {
  header('Update');
  if (!isScriptInstall(process.execPath, home, process.platform)) {
    write(`  This markup runs from ${tildify(process.execPath)}, which the installer does not manage.`);
    write(`  The desktop app updates its own copy. For the standalone CLI, run:`);
    write(`    ${installCommand(process.platform)}`);
    write();
    process.exitCode = 1;
    return;
  }
  const newest = await latestVersion();
  if (newest && compareVersions(newest, VERSION) <= 0) return write(`  ${c.green(sym.ok)} markup ${VERSION} is the newest version.\n`);
  write(`  Updating markup ${VERSION} to ${newest ?? 'the newest version'}...`);
  write();
  const { command, args } = updateCommand(process.platform);
  const r = spawnSync(command, args, { stdio: 'inherit' });
  if (r.error) return fail('update', `${r.error.message}\nRun this yourself: ${installCommand(process.platform)}`);
  process.exitCode = r.status ?? 1;
}

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'mcp':
      return runMcp();
    case 'install':
      return runInstall(rest);
    case 'setup':
    case 'connect':
      return runSetup(rest);
    case 'status':
    case 'doctor':
      return runStatus();
    case 'uninstall':
    case 'remove':
      return runUninstall(rest);
    case 'update':
    case 'upgrade':
      return runUpdate();
    case '-v':
    case '--version':
    case 'version':
      return write(VERSION);
    case '-h':
    case '--help':
    case 'help':
      return write(USAGE);
    case undefined:
      // Typed bare in a terminal: walk through setup. Without one (piped, spawned), print the help.
      if (interactive) return runSetup([]);
      return write(USAGE);
    default:
      process.stderr.write(`markup: unknown command "${command}".\n\n${USAGE}\n`);
      process.exit(1);
  }
}

main(process.argv.slice(2)).catch((err: Error) => fail(process.argv[2] ?? 'mcp', err.message));
