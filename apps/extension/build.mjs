import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/background.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  outfile: 'dist/background.js',
});
await build({
  entryPoints: ['src/content.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  outfile: 'dist/content.js',
});
await cp('manifest.json', 'dist/manifest.json');
await cp('icons', 'dist/icons', { recursive: true });
