// Compiles `markup` to one native binary with Bun.
//
//   node compile.mjs
//     The Tauri sidecar for this machine (markup-<target-triple>[.exe]), copied to apps/app/src-tauri/binaries.
//   node compile.mjs --target bun-darwin-x64 --triple x86_64-apple-darwin
//     The sidecar cross-compiled for another target.
//   node compile.mjs --target bun-linux-arm64 --out dist/release/markup-cli-linux-arm64
//     A standalone CLI for the release assets that the install scripts download. Not copied anywhere.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { version } from './version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { target: { type: 'string' }, triple: { type: 'string' }, out: { type: 'string' } } });

function hostTriple() {
  try {
    const host = /^host: (\S+)$/m.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))?.[1];
    if (host) return host;
  } catch {
    // no rustc: fall back to the platform's usual triple
  }
  const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch] ?? process.arch;
  if (process.platform === 'win32') return `${arch}-pc-windows-msvc`;
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  return `${arch}-unknown-linux-gnu`;
}

const compile = (outfile) => {
  mkdirSync(dirname(outfile), { recursive: true });
  const args = ['build', 'src/cli.ts', '--compile', '--define', `__MARKUP_VERSION__=${JSON.stringify(version)}`, '--outfile', outfile];
  if (values.target) args.push(`--target=${values.target}`);
  execFileSync('bun', args, { cwd: here, stdio: 'inherit' });
  console.log(`compiled ${outfile} (markup ${version})`);
};

if (values.out) {
  compile(resolve(here, values.out));
} else {
  const triple = values.triple ?? process.env.TAURI_TARGET_TRIPLE ?? hostTriple();
  const name = `markup-${triple}${triple.includes('windows') ? '.exe' : ''}`;
  const outfile = join(here, 'dist', name);
  compile(outfile);
  const sidecarDir = join(here, '..', '..', 'apps', 'app', 'src-tauri', 'binaries');
  mkdirSync(sidecarDir, { recursive: true });
  copyFileSync(outfile, join(sidecarDir, name));
  console.log(`copied to ${join(sidecarDir, name)}`);
}
