import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The private backend's tests run too when its folder is present (it is not in the public repo).
    projects: ['packages/*', 'apps/*', 'supabase/*/vitest.config.ts'],
  },
});
