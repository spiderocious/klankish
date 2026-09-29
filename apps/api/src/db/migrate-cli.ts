/**
 * Migration CLI — `pnpm migrate`.
 *
 * Deliberately a separate entrypoint from the server: migrations run as a release step, so that N
 * booting replicas never race each other through the same DDL.
 */

import { closePool } from './client.js';
import { runMigrations } from './migrate.js';
import { logger } from '../platform/logger.js';

async function main(): Promise<void> {
  const result = await runMigrations();

  if (result.applied.length === 0) {
    logger.info({ skipped: result.skipped.length }, 'database already up to date');
  } else {
    logger.info(
      { applied: result.applied, skipped: result.skipped.length },
      `applied ${result.applied.length} migration(s)`,
    );
  }
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    logger.error({ err }, 'migration failed');
    await closePool().catch(() => undefined);
    process.exit(1);
  });
