import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The language server over stdio: needs `dist/server.js`, so `npm run build` first
    // (`pretest:server` does it).
    include: ['test/server/**/*.test.ts'],
  },
});
