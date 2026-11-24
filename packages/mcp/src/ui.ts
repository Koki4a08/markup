import readline from 'node:readline';
import tty from 'node:tty';

/** Terminal output for people: colour and symbols only when stdout is an interactive terminal. */
const out = process.stdout;
const env = process.env;

// isatty, not process.stdin.isTTY: touching process.stdin opens it, and under Bun an open stdin keeps
// `markup --version` alive forever when PowerShell owns the console.
export const interactive = tty.isatty(0) && tty.isatty(1);
const colour = tty.isatty(1) && !('NO_COLOR' in env) && env.TERM !== 'dumb';
const paint = (open: number, close: number) => (s: string) => (colour ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  green: paint(32, 39),
  red: paint(31, 39),
  yellow: paint(33, 39),
  cyan: paint(36, 39),
};

// The old Windows console host draws boxes for most symbols; Windows Terminal, VS Code and Unix terminals do not.
const unicode = process.platform !== 'win32' || Boolean(env.WT_SESSION || env.TERM_PROGRAM || env.TERM);

export const sym = unicode
  ? { ok: '✓', fail: '✗', warn: '!', off: '·', pointer: '›', on: '◉', unset: '○', up: '↑', down: '↓', dot: '·' }
  : { ok: '+', fail: 'x', warn: '!', off: '-', pointer: '>', on: '(*)', unset: '( )', up: 'up', down: 'down', dot: '|' };

export const write = (line = '') => out.write(`${line}\n`);

/** One aligned result line: symbol, padded label, detail. */
export function row(kind: 'ok' | 'fail' | 'warn' | 'off', label: string, detail: string, width: number) {
  const mark = { ok: c.green(sym.ok), fail: c.red(sym.fail), warn: c.yellow(sym.warn), off: c.dim(sym.off) }[kind];
  write(`  ${mark} ${label.padEnd(width)}  ${kind === 'off' ? c.dim(detail) : detail}`);
}

export interface Choice {
  label: string;
  hint?: string;
  checked: boolean;
}

/**
 * A checkbox list driven by the keyboard. Resolves with the checked state of every choice,
 * or null when cancelled (Esc, q, Ctrl+C). Without a terminal it returns the defaults.
 */
export function multiSelect(choices: Choice[]): Promise<boolean[] | null> {
  const input = process.stdin;
  if (!interactive || choices.length === 0) return Promise.resolve(choices.map((ch) => ch.checked));
  return new Promise((resolve) => {
    const state = choices.map((ch) => ch.checked);
    const width = Math.max(...choices.map((ch) => ch.label.length));
    const help = c.dim(`  ${sym.up}${sym.down} move  ${sym.dot}  space select  ${sym.dot}  a all  ${sym.dot}  enter confirm  ${sym.dot}  esc cancel`);
    let cursor = 0;
    let drawn = 0;

    const clear = () => drawn && out.write(`\x1b[${drawn}A\x1b[0J`);
    const render = () => {
      clear();
      const lines = choices.map((ch, i) => {
        const here = i === cursor;
        const box = state[i] ? c.green(sym.on) : c.dim(sym.unset);
        const label = here ? c.bold(ch.label.padEnd(width)) : ch.label.padEnd(width);
        return `  ${here ? c.cyan(sym.pointer) : ' '} ${box} ${label}  ${c.dim(ch.hint ?? '')}`;
      });
      lines.push('', help);
      out.write(`${lines.join('\n')}\n`);
      drawn = lines.length;
    };
    const showCursor = () => out.write('\x1b[?25h');

    const finish = (value: boolean[] | null) => {
      input.off('keypress', onKey);
      input.setRawMode(false);
      input.pause();
      // Let the process exit once the command is done (Bun keeps a paused stdin open otherwise).
      input.unref();
      clear();
      showCursor();
      process.off('exit', showCursor);
      resolve(value);
    };
    const onKey = (_: string, key: readline.Key | undefined) => {
      if (!key) return;
      if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') return finish(null);
      if (key.name === 'return' || key.name === 'enter') return finish(state);
      if (key.name === 'up' || key.name === 'k') cursor = (cursor - 1 + choices.length) % choices.length;
      else if (key.name === 'down' || key.name === 'j' || key.name === 'tab') cursor = (cursor + 1) % choices.length;
      else if (key.name === 'space') state[cursor] = !state[cursor];
      else if (key.name === 'a') state.fill(!state.every(Boolean));
      else return;
      render();
    };

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    out.write('\x1b[?25l');
    process.on('exit', showCursor);
    input.on('keypress', onKey);
    render();
  });
}
