import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'apps/server/src/**/*.test.ts',
      'packages/shared/src/**/*.test.ts',
      // Pure frontend logic only (coordinate mapping, timeline maths). Kept out
      // of components deliberately so it needs no DOM environment to test.
      'apps/web/src/lib/**/*.test.ts',
    ],
    // Live tests hit real external services and are opt-in only.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
  },
});
