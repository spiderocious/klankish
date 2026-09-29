import { defineConfig } from 'vitest/config';

/**
 * Integration tests — against a REAL Postgres.
 *
 * A note on the divergence from the documented Testcontainers setup: this machine has a native
 * Postgres (Postgres.app) and no running Docker daemon, so these point at `klankish_test`
 * directly. The trade-off is that the suite needs a live local Postgres rather than being
 * self-contained. `startContainers()` remains the right approach for CI, where Docker exists, and
 * nothing here depends on how the database got there — only that it is real.
 *
 * `singleFork` + non-concurrent: these tests share one database and truncate between cases, so
 * parallel files would clobber each other.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    fileParallelism: false,
    clearMocks: true,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://feranmi@localhost:5432/klankish_test',
      LOG_LEVEL: 'silent',
      // The executor tests run against a local HTTP server on 127.0.0.1, which the SSRF guard
      // blocks by design. Allowing private targets here is what lets those tests reach it.
      // The guard itself is still proven: `ssrf.test.ts` asserts isBlockedAddress directly, so
      // turning this on cannot mask a regression in the rules.
      HTTP_STEP_ALLOW_PRIVATE: 'true',
      SHELL_STEPS_ENABLED: 'true',
    },
  },
  resolve: {
    alias: {
      '@klankish/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
      '@klankish/expr': new URL('../../packages/expr/src/index.ts', import.meta.url).pathname,
    },
  },
});
