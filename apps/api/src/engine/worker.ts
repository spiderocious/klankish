import { hostname } from 'node:os';

import { newId, type TaskGraph } from '@klankish/shared';

import { query, queryOne } from '../db/client.js';
import { runWithContext } from '../platform/context.js';
import { env } from '../platform/env.js';
import { subLogger } from '../platform/logger.js';
import { RunContext } from './context.js';
import { executeRun } from './executor.js';
import { queue, type RunRow } from './queue.js';
import { secretsForOwner } from '../features/secrets/secrets.service.js';

/**
 * The worker loop.
 *
 * Polls for claimable runs, executes them, renews its lease while working, and shuts down
 * gracefully. One instance of this class per process; `WORKER_CONCURRENCY` runs may be in flight
 * within it.
 *
 * Polling rather than LISTEN/NOTIFY deliberately: polling a partial index costs one cheap query
 * per second, and it recovers by itself after a database restart, where a dropped NOTIFY
 * subscription silently stops delivering work — a failure whose symptom is silence.
 */

const log = subLogger('worker');

export class Worker {
  readonly id: string;
  private running = false;
  private stopping = false;
  private inFlight = new Set<string>();
  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private reaperTimer?: NodeJS.Timeout;

  constructor(readonly concurrency: number = env.WORKER_CONCURRENCY) {
    this.id = newId('worker');
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await query(
      `INSERT INTO workers (id, hostname, role, pid, concurrency)
       VALUES ($1, $2, $3, $4, $5)`,
      [this.id, hostname(), env.PROCESS_ROLE, process.pid, this.concurrency],
    );

    log.info({ worker_id: this.id, concurrency: this.concurrency }, 'worker started');

    this.scheduleNextPoll(0);

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, 10_000);
    this.heartbeatTimer.unref();

    // The reaper runs on every worker rather than a designated one: a "leader" that dies takes
    // the recovery mechanism with it, which is precisely when recovery is needed. Concurrent
    // reaping is harmless — the UPDATE is atomic and idempotent.
    this.reaperTimer = setInterval(() => {
      void queue.reapExpiredLeases().catch((err: unknown) => {
        log.error({ err }, 'reaper failed');
      });
    }, Math.max(10_000, env.LEASE_TTL_MS / 2));
    this.reaperTimer.unref();
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.stopping) return;
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, delayMs);
    this.pollTimer.unref();
  }

  private async poll(): Promise<void> {
    if (this.stopping) return;

    try {
      // Fill available capacity in one pass: claiming one run per tick would cap throughput at
      // 1/WORKER_POLL_MS regardless of concurrency.
      while (this.inFlight.size < this.concurrency && !this.stopping) {
        const run = await queue.claimNext(this.id);
        if (run === null) break;
        void this.execute(run);
      }
    } catch (err) {
      log.error({ err }, 'poll failed');
    }

    // Poll fast while saturated (there is probably more waiting), slow when idle.
    this.scheduleNextPoll(this.inFlight.size >= this.concurrency ? 200 : env.WORKER_POLL_MS);
  }

  private async execute(run: RunRow): Promise<void> {
    this.inFlight.add(run.id);

    // Keep the lease alive for the whole run. Without this a step slower than LEASE_TTL_MS gets
    // reaped out from under a worker that is doing fine, and then runs twice.
    const renew = setInterval(() => {
      void queue.renewLease(run.id, this.id).then((held) => {
        if (!held) {
          // Someone else owns this now — most likely the reaper handed it on after a stall. Stop
          // touching it; continuing would mean two workers executing one run.
          log.warn({ run_id: run.id }, 'lost lease while running');
        }
      });
    }, Math.max(5_000, env.LEASE_TTL_MS / 3));
    renew.unref();

    try {
      const loaded = await this.loadRunContext(run);
      if (loaded === null) {
        await queue.complete(run.id, 'failed', {
          identity: 'internal_error',
          message: 'The task definition for this run could not be loaded.',
        });
        return;
      }

      // Seed an async context so services and logs called deep inside the executor still carry
      // the run id, exactly as an HTTP request carries its request id.
      const result = await runWithContext({ request_id: run.id, run_id: run.id }, () =>
        executeRun(loaded),
      );

      await queue.complete(
        run.id,
        result.status,
        result.error === undefined ? undefined : result.error,
      );

      log.info(
        { run_id: run.id, status: result.status, steps: result.stepsRun },
        'run finished',
      );
    } catch (err) {
      log.error({ err, run_id: run.id }, 'run crashed');
      await queue
        .complete(run.id, 'failed', {
          identity: 'internal_error',
          message: 'The run stopped unexpectedly.',
        })
        .catch(() => undefined);
    } finally {
      clearInterval(renew);
      this.inFlight.delete(run.id);
    }
  }

  private async loadRunContext(run: RunRow): Promise<RunContext | null> {
    const row = await queryOne<{
      graph: TaskGraph;
      task_id: string;
      task_name: string;
      owner_id: string;
    }>(
      `SELECT tv.graph, t.id AS task_id, t.name AS task_name, t.owner_id
       FROM task_versions tv
       JOIN tasks t ON t.id = tv.task_id
       WHERE tv.id = $1`,
      [run.task_version_id],
    );

    if (row === null) return null;

    // Secrets are resolved ONCE per run and held only in memory. They reach the database solely
    // as redactions.
    const secrets = await secretsForOwner(row.owner_id);

    return new RunContext(
      run,
      row.graph,
      { id: row.task_id, name: row.task_name, owner_id: row.owner_id },
      secrets,
    );
  }

  private async heartbeat(): Promise<void> {
    try {
      await query(
        'UPDATE workers SET last_heartbeat_at = now(), in_flight = $2 WHERE id = $1',
        [this.id, this.inFlight.size],
      );
    } catch (err) {
      log.warn({ err }, 'heartbeat failed');
    }
  }

  /**
   * Graceful shutdown: stop claiming, let in-flight runs finish, then deregister.
   *
   * In-flight runs are safe either way — the reaper recovers an expired lease — but draining
   * means a redeploy does not leave every active run stalled for a full lease TTL.
   */
  async stop(timeoutMs = 20_000): Promise<void> {
    if (!this.running) return;
    this.stopping = true;

    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.reaperTimer !== undefined) clearInterval(this.reaperTimer);

    log.info({ in_flight: this.inFlight.size }, 'worker draining');

    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    if (this.inFlight.size > 0) {
      // Their leases will expire and the reaper will recover them. Saying so explicitly beats a
      // silent exit that leaves someone wondering what happened to those runs.
      log.warn(
        { in_flight: this.inFlight.size },
        'shutting down with runs still in flight — they will be recovered by the reaper',
      );
    }

    await query('UPDATE workers SET stopped_at = now() WHERE id = $1', [this.id]).catch(
      () => undefined,
    );

    this.running = false;
    log.info('worker stopped');
  }

  get stats(): { id: string; inFlight: number; concurrency: number } {
    return { id: this.id, inFlight: this.inFlight.size, concurrency: this.concurrency };
  }
}
