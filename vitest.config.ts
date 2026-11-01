import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['apps/server/src/**/*.test.ts', 'packages/shared/src/**/*.test.ts'],
    // Live tests hit real external services and are opt-in only.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
  },
});
