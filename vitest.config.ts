import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Database tests loop over every tenant table x role on a real Postgres; 5s is too tight under parallel load.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
