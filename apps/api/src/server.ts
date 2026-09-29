import { buildApp } from './app.js';
import { closePool, healthCheck } from './db/client.js';
import { Scheduler } from './engine/scheduler.js';
import { Worker } from './engine/worker.js';
import { assertProductionReady, env, runsApi, runsScheduler, runsWorker } from './platform/env.js';
import { logger } from './platform/logger.js';

/**
 * Process entrypoint.
 *
 * One image, several roles, selected by PROCESS_ROLE. Splitting the worker onto its own Railway
 * service later is a config change rather than a rewrite, because the queue lives in Postgres and
 * not in this process.
 */

let shuttingDown = false;

async function main(): Promise<void> {
  // Production-only assertions live here, not in env.ts, so `pnpm dev` boots from a clean
  // checkout while production refuses to start on a placeholder secret.
  assertProductionReady();

  if (!(await healthCheck())) {
    logger.error(
      { database_url: env.DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@') },
      'cannot reach the database — refusing to start',
    );
    process.exit(1);
  }

  const app = await buildApp();

  // The engine. Which halves run is decided by PROCESS_ROLE, so the same image serves as API,
  // worker, scheduler, or all three.
  const worker = runsWorker ? new Worker() : null;
  const scheduler = runsScheduler ? new Scheduler() : null;

  if (worker !== null) await worker.start();
  if (scheduler !== null) scheduler.start();

  /**
   * Even in worker/scheduler mode an HTTP listener is bound.
   *
   * Without it, the platform's TCP health check fails and the deploy is marked unhealthy — a
   * worker that is running perfectly gets killed because nothing answered on the port.
   */
  await app.listen({ port: env.PORT, host: env.HOST });

  logger.info(
    {
      port: env.PORT,
      role: env.PROCESS_ROLE,
      api: runsApi,
      worker: runsWorker,
      scheduler: runsScheduler,
      env: env.NODE_ENV,
    },
    'klankish started',
  );

  /**
   * Graceful shutdown.
   *
   * Stop accepting, let in-flight work finish, release the pool. In-flight RUNS are safe either
   * way — the reaper recovers an expired lease — but releasing cleanly means a redeploy does not
   * leave every active run stalled for a full lease TTL.
   */
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.error('shutdown took too long — forcing exit');
      process.exit(1);
    }, 25_000);
    forceExit.unref();

    void (async () => {
      try {
        // Order matters: stop the scheduler first so no new runs are created, then drain the
        // worker, then close HTTP, then the pool the others were using.
        scheduler?.stop();
        if (worker !== null) await worker.stop();
        await app.close();
        await closePool();
        logger.info('shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection means a promise escaped without a catch. Log it loudly rather than
  // letting Node's default behaviour decide the process's fate silently.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
