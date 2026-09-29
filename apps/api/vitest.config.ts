import { defineConfig } from 'vitest/config';

/**
 * Unit tests only — no database, no network.
 *
 * Integration tests live in vitest.integration.config.ts and run serially against a real
 * Postgres. Keeping them in separate configs means a fast unit run stays fast.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', 'node_modules/**'],
    clearMocks: true,
    globals: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://feranmi@localhost:5432/klankish_test',
    },
  },
  resolve: {
    alias: {
      '@klankish/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
      '@klankish/expr': new URL('../../packages/expr/src/index.ts', import.meta.url).pathname,
    },
  },
});
