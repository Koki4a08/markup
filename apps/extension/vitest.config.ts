import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Bundled fonts load as bytes in the build; tests only need the import to resolve.
  plugins: [{ name: 'woff2-bytes', load: (id) => (id.endsWith('.woff2') ? 'export default new Uint8Array(0);' : null) }],
  test: { name: 'extension', environment: 'jsdom' },
});
