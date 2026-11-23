import { defineConfig } from 'vite';

// Tauri serves the built files from dist; the dev server runs on its own port so
// it never collides with the editor on 5173.
export default defineConfig({
  clearScreen: false,
  server: { port: 5199, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
