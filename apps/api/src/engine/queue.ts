import { newId, type RunStatus, type RunTrigger } from '@klankish/shared';

import { query, queryOne, transaction, txQuery, txQueryOne } from '../db/client.js';
import { env } from '../platform/env.js';
import { subLogger } from '../platform/logger.js';

/**
 * The run queue.
 *
 * This file is the correctness core of the whole product. Everything else can be wrong in a way
 * that shows up in a test; a queue bug shows up as a task that silently ran twice, three weeks
 * later, in someone's billing system.
 *
 * The mechanism is `SELECT ... FOR UPDATE SKIP LOCKED`, which is the one thing Postgres gives you
 * that makes a correct work queue possible without extra infrastructure: a row locked by another
 * worker's transaction is SKIPPED rather than waited on, so two workers polling simultaneously
 * take different rows or nothing at all.
 *
 * Three invariants, all covered by integration tests:
 *   1. A queued run is claimed by exactly one worker.
 *   2. A worker that dies mid-run has its run recovered (lease expiry + reaper).
 *   3. Concurrency policy is enforced inside the claim transaction, not around it.
 */

const log = subLogger('queue');

export interface RunRow {
  id: string;
  task_id: string;
  task_version_id: string;
  schedule_id: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  claimed_by: string | null;
  claimed_at: string | null;
  lease_expires_at: string | null;
  attempt: number;
  parent_run_id: string | null;
  root_run_id: string | null;
  cancel_requested: boolean;
  error_identity: string | null;
  error_message: string | null;
  vars: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
}

export interface EnqueueInput {
  readonly taskId: string;
  readonly taskVersionId: string;
  readonly trigger: RunTrigger;
  readonly scheduledFor?: string;
  readonly scheduleId?: string | null;
  readonly vars?: Record<string, unknown>;
  readonly createdBy?: string | null;
  readonly parentRunId?: string | null;
  readonly rootRunId?: string | null;
  readonly attempt?: number;
}

export const queue = {
  /**
   * Enqueue a run, honouring the task's concurrency policy.
   *
   * The policy check and the insert happen in ONE transaction with the task row locked. Checking
   * "is something already running?" outside a transaction is a classic TOCTOU: two schedulers
   * both see zero in flight, and both enqueue.
   *
   * A skipped run is still RECORDED, with status `skipped`. Silently dropping it would make a
   * task that never runs look identical to a task that runs fine.
   */
  async enqueue(input: EnqueueInput): Promise<RunRow> {
    return transaction(async (client) => {
      // Lock the task row so concurrent enqueues for the same task serialise here.
      const task = await txQueryOne<{
        id: string;
        concurrency_policy: 'skip' | 'queue' | 'allow';
        max_concurrent_runs: number;
        max_queued: number;
        status: string;
      }>(
        client,
        `SELECT id, concurrency_policy, max_concurrent_runs, max_queued, status
         FROM tasks WHERE id = $1 AND is_deleted = FALSE FOR UPDATE`,
        [input.taskId],
      );

      if (task === null) throw new Error(`task ${input.taskId} not found`);

      const counts = await txQueryOne<{ running: string; queued: string }>(
        client,
        `SELECT
           count(*) FILTER (WHERE status = 'running')::text AS running,
           count(*) FILTER (WHERE status = 'queued')::text  AS queued
         FROM runs WHERE task_id = $1`,
        [input.taskId],
      );

      const running = Number(counts?.running ?? '0');
      const queued = Number(counts?.queued ?? '0');

      let status: RunStatus = 'queued';
      let errorIdentity: string | null = null;
      let errorMessage: string | null = null;

      // A manual or retry run deliberately bypasses the policy: the user is standing there asking
      // for it, and refusing would be baffling. Only scheduled runs are policed.
      const policed = input.trigger === 'schedule' || input.trigger === 'webhook';

      if (policed) {
        if (task.concurrency_policy === 'skip' && running + queued > 0) {
          status = 'skipped';
          errorIdentity = 'concurrency_skipped';
          errorMessage = 'A previous run of this task was still going.';
        } else if (task.concurrency_policy === 'queue' && queued >= task.max_queued) {
          // An unbounded backlog is worse than a visible refusal: it hides a task that has been
          // broken for a week behind a thousand pending runs.
          status = 'skipped';
          errorIdentity = 'max_queued_exceeded';
          errorMessage = `Already ${queued} runs waiting (limit ${task.max_queued}).`;
        } else if (
          task.concurrency_policy === 'allow' &&
          running >= task.max_concurrent_runs
        ) {
          status = 'skipped';
          errorIdentity = 'concurrency_skipped';
          errorMessage = `Already at the limit of ${task.max_concurrent_runs} concurrent runs.`;
        }
      }

      const id = newId('run');
      const rows = await txQuery<RunRow>(
        client,
        `INSERT INTO runs (
           id, task_id, task_version_id, schedule_id, trigger, status,
           scheduled_for, attempt, parent_run_id, root_run_id,
           error_identity, error_message, vars, created_by,
           finished_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           COALESCE($7::timestamptz, now()), $8, $9, $10,
           $11, $12, $13, $14,
           CASE WHEN $6::run_status = 'skipped' THEN now() ELSE NULL END
         )
         RETURNING *`,
        [
          id,
          input.taskId,
          input.taskVersionId,
          input.scheduleId ?? null,
          input.trigger,
          status,
          input.scheduledFor ?? null,
          input.attempt ?? 1,
          input.parentRunId ?? null,
          input.rootRunId ?? id,
          errorIdentity,
          errorMessage,
          JSON.stringify(input.vars ?? {}),
          input.createdBy ?? null,
        ],
      );

      const row = rows[0];
      if (row === undefined) throw new Error('insert returned no row');
      return row;
    });
  },

  /**
   * Claim the next due run for this worker.
   *
   * `FOR UPDATE SKIP LOCKED` inside the subquery is what makes this safe under concurrency. The
   * ORDER BY is inside the subquery too — ordering the outer UPDATE would not choose which row
   * to lock.
   *
   * Returns null when nothing is due, which is the common case on an idle instance.
   */
  async claimNext(workerId: string): Promise<RunRow | null> {
    return queryOne<RunRow>(
      `UPDATE runs r
       SET status = 'running',
           claimed_by = $1,
           claimed_at = now(),
           started_at = COALESCE(r.started_at, now()),
           lease_expires_at = now() + ($2 || ' milliseconds')::interval
       WHERE r.id = (
         SELECT id FROM runs
         WHERE status = 'queued'
           AND scheduled_for <= now()
         ORDER BY scheduled_for, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING r.*`,
      [workerId, String(env.LEASE_TTL_MS)],
    );
  },

  /**
   * Extend the lease on a run this worker is executing.
   *
   * Called periodically during a long run. Scoped to `claimed_by` so a worker that lost its lease
   * to the reaper cannot reclaim it by renewing — the row now belongs to whoever picked it up.
   * A false return means "you no longer own this", and the worker must stop.
   */
  async renewLease(runId: string, workerId: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE runs
       SET lease_expires_at = now() + ($3 || ' milliseconds')::interval
       WHERE id = $1 AND claimed_by = $2 AND status = 'running'
       RETURNING id`,
      [runId, workerId, String(env.LEASE_TTL_MS)],
    );
    return rows.length > 0;
  },

  /**
   * Recover runs whose worker died.
   *
   * A crashed process cannot clean up after itself, so the lease is the only signal that a run is
   * abandoned. Runs under the attempt cap go back to `queued`; the rest fail with a truthful
   * identity rather than sitting in `running` forever.
   *
   * THIS is why every step handler must be idempotent or explicitly marked otherwise: a recovered
   * run re-executes, and the engine cannot know how far the dead worker got.
   */
  async reapExpiredLeases(maxAttempts = 3): Promise<{ requeued: string[]; failed: string[] }> {
    const requeued = await query<{ id: string }>(
      `UPDATE runs
       SET status = 'queued',
           claimed_by = NULL,
           claimed_at = NULL,
           lease_expires_at = NULL,
           attempt = attempt + 1
       WHERE status = 'running'
         AND lease_expires_at < now()
         AND attempt < $1
       RETURNING id`,
      [maxAttempts],
    );

    const failed = await query<{ id: string }>(
      `UPDATE runs
       SET status = 'failed',
           finished_at = now(),
           duration_ms = CASE
             WHEN started_at IS NOT NULL
             THEN EXTRACT(EPOCH FROM (now() - started_at))::int * 1000
             ELSE NULL END,
           error_identity = 'lease_expired',
           error_message = 'The worker running this stopped responding.',
           claimed_by = NULL,
           lease_expires_at = NULL
       WHERE status = 'running'
         AND lease_expires_at < now()
         AND attempt >= $1
       RETURNING id`,
      [maxAttempts],
    );

    if (requeued.length > 0 || failed.length > 0) {
      log.warn(
        { requeued: requeued.length, failed: failed.length },
        'reaped runs from expired leases',
      );
    }

    return {
      requeued: requeued.map((r) => r.id),
      failed: failed.map((r) => r.id),
    };
  },

  /** Mark a run finished. `duration_ms` is computed by the DB from its own clock. */
  async complete(
    runId: string,
    status: Extract<RunStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>,
    error?: { identity: string; message: string },
  ): Promise<void> {
    await query(
      `UPDATE runs
       SET status = $2,
           finished_at = now(),
           duration_ms = CASE
             WHEN started_at IS NOT NULL
             THEN (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int
             ELSE NULL END,
           error_identity = $3,
           error_message = $4,
           claimed_by = NULL,
           lease_expires_at = NULL
       WHERE id = $1`,
      [runId, status, error?.identity ?? null, error?.message ?? null],
    );
  },

  /**
   * Request cancellation.
   *
   * Cooperative: it sets a flag the executor checks between steps. Killing a worker mid-step
   * would leave a half-written record, which is precisely what this product exists to avoid.
   */
  async requestCancel(runId: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE runs SET cancel_requested = TRUE
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING id`,
      [runId],
    );
    return rows.length > 0;
  },

  async isCancelRequested(runId: string): Promise<boolean> {
    const row = await queryOne<{ cancel_requested: boolean }>(
      'SELECT cancel_requested FROM runs WHERE id = $1',
      [runId],
    );
    return row?.cancel_requested ?? false;
  },

  /** Cancel a queued run outright — it has not started, so there is nothing to unwind. */
  async cancelQueued(runId: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE runs
       SET status = 'cancelled', finished_at = now(), cancel_requested = TRUE
       WHERE id = $1 AND status = 'queued'
       RETURNING id`,
      [runId],
    );
    return rows.length > 0;
  },

  async findById(runId: string): Promise<RunRow | null> {
    return queryOne<RunRow>('SELECT * FROM runs WHERE id = $1', [runId]);
  },

  async stats(): Promise<{
    queued: number;
    running: number;
    oldest_queued_at: string | null;
    stuck_leases: number;
  }> {
    const row = await queryOne<{
      queued: string;
      running: string;
      oldest_queued_at: string | null;
      stuck_leases: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status = 'queued')::text  AS queued,
         count(*) FILTER (WHERE status = 'running')::text AS running,
         min(scheduled_for) FILTER (WHERE status = 'queued') AS oldest_queued_at,
         count(*) FILTER (WHERE status = 'running' AND lease_expires_at < now())::text
           AS stuck_leases
       FROM runs`,
    );

    return {
      queued: Number(row?.queued ?? '0'),
      running: Number(row?.running ?? '0'),
      oldest_queued_at: row?.oldest_queued_at ?? null,
      stuck_leases: Number(row?.stuck_leases ?? '0'),
    };
  },
};
