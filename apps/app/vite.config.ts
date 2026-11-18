import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  clearScreen: false,
  // The AVIF encoder loads its wasm relative to its own module; pre-bundling would break that URL.
  optimizeDeps: { exclude: ['@jsquash/avif'] },
  test: { name: 'app', environment: 'jsdom', setupFiles: ['./test/setup.ts'] },
});
