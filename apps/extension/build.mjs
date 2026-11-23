import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

/**
 * Builds the extension twice from the same code:
 *   dist/          Chrome, Edge and other Chromium browsers (load unpacked, or the zip in releases)
 *   dist-firefox/  Firefox, which runs MV3 background code as a script, not a service worker
 */
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
// Releases stamp their own version (EXTENSION_VERSION=0.2.0); local builds keep manifest.json's.
if (process.env.EXTENSION_VERSION) manifest.version = process.env.EXTENSION_VERSION;

/** Firefox-only manifest keys. The add-on ID must never change once it is signed. */
const firefoxManifest = {
  ...manifest,
  background: { scripts: ['background.js'], type: 'module' },
  commands: {
    'toggle-snapshot': {
      ...manifest.commands['toggle-snapshot'],
      // Ctrl+Shift+P opens a private window in Firefox.
      suggested_key: { default: 'Alt+Shift+M', mac: 'Alt+Shift+M' },
    },
  },
  browser_specific_settings: {
    gecko: {
      id: 'snapshot@markup-design',
      strict_min_version: '128.0',
      data_collection_permissions: { required: ['none'] },
    },
  },
};

async function bundle(outdir, manifestJson) {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await build({
    entryPoints: ['src/background.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: ['chrome120', 'firefox128'],
    outfile: `${outdir}/background.js`,
  });
  await build({
    entryPoints: ['src/content.ts'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['chrome120', 'firefox128'],
    outfile: `${outdir}/content.js`,
  });
  await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifestJson, null, 2)}\n`);
  await cp('icons', `${outdir}/icons`, { recursive: true });
}

await bundle('dist', manifest);
await bundle('dist-firefox', firefoxManifest);
console.log('built dist/ (Chromium) and dist-firefox/ (Firefox)');
