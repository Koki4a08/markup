// Compiles `markup` to one native binary named the way Tauri expects a sidecar (markup-<target-triple>[.exe]),
// then copies it to apps/app/src-tauri/binaries for bundle.externalBin.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

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

const triple = process.env.TAURI_TARGET_TRIPLE ?? hostTriple();
const name = `markup-${triple}${triple.includes('windows') ? '.exe' : ''}`;
const outfile = join(here, 'dist', name);
execFileSync('bun', ['build', 'src/cli.ts', '--compile', '--outfile', outfile], { cwd: here, stdio: 'inherit' });
const sidecarDir = join(here, '..', '..', 'apps', 'app', 'src-tauri', 'binaries');
mkdirSync(sidecarDir, { recursive: true });
copyFileSync(outfile, join(sidecarDir, name));
console.log(`compiled ${outfile}\ncopied to ${join(sidecarDir, name)}`);
