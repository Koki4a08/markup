import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/cli.js',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __markupCreateRequire } from 'node:module';\nconst require = __markupCreateRequire(import.meta.url);",
  },
});
