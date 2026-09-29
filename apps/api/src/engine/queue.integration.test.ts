import { newId } from '@klankish/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePool, query } from '../db/client.js';
import { runMigrations, truncateAll } from '../db/migrate.js';
import { queue } from './queue.js';

/**
 * Queue integration tests — against a REAL Postgres.
 *
 * These cannot be written against a mock. `FOR UPDATE SKIP LOCKED` is the entire mechanism being
 * tested, and a mock would simply do whatever we told it to. A test that passes with a fake and
 * fails against the real database is worse than no test.
 *
 * The concurrency test here is the single most important test in the codebase: it is the one that
 * proves a scheduled task cannot silently execute twice.
 */

let taskId: string;
let versionId: string;
let userId: string;

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await truncateAll();

  userId = newId('user');
  await query(
    `INSERT INTO users (id, email, password_hash, name, role)
     VALUES ($1, $2, 'x', 'Test', 'user')`,
    [userId, `${userId}@test.test`],
  );

  taskId = newId('task');
  await query(
    `INSERT INTO tasks (id, owner_id, name, slug, concurrency_policy, max_concurrent_runs, max_queued)
     VALUES ($1, $2, 'Test Task', 'test-task', 'allow', 10, 10)`,
    [taskId, userId],
  );

  versionId = newId('task_version');
  await query(
    `INSERT INTO task_versions (id, task_id, version, graph)
     VALUES ($1, $2, 1, $3)`,
    [versionId, taskId, JSON.stringify({ version: 1, entry: 'a', steps: [] })],
  );
});

const enqueueOne = (overrides: Partial<Parameters<typeof queue.enqueue>[0]> = {}) =>
  queue.enqueue({
    taskId,
    taskVersionId: versionId,
    trigger: 'manual',
    createdBy: userId,
    ...overrides,
  });

describe('claiming', () => {
  it('claims a due run and marks it running', async () => {
    const run = await enqueueOne();
    expect(run.status).toBe('queued');

    const claimed = await queue.claimNext('worker-1');
    expect(claimed?.id).toBe(run.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.claimed_by).toBe('worker-1');
    expect(claimed?.started_at).not.toBe(null);
    expect(claimed?.lease_expires_at).not.toBe(null);
  });

  it('returns null when nothing is queued', async () => {
    expect(await queue.claimNext('worker-1')).toBe(null);
  });

  it('does not claim a run scheduled in the future', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await enqueueOne({ scheduledFor: future });
    expect(await queue.claimNext('worker-1')).toBe(null);
  });

  it('claims in scheduled order, oldest first', async () => {
    const t = (offset: number) => new Date(Date.now() - offset).toISOString();
    const third = await enqueueOne({ scheduledFor: t(1000) });
    const first = await enqueueOne({ scheduledFor: t(3000) });
    const second = await enqueueOne({ scheduledFor: t(2000) });

    expect((await queue.claimNext('w'))?.id).toBe(first.id);
    expect((await queue.claimNext('w'))?.id).toBe(second.id);
    expect((await queue.claimNext('w'))?.id).toBe(third.id);
  });

  // ---------------------------------------------------------------------
  // THE test. Everything else in the engine assumes this holds.
  // ---------------------------------------------------------------------
  it('never lets two workers claim the same run, under real concurrency', async () => {
    const RUNS = 40;
    const WORKERS = 8;

    const enqueued = await Promise.all(
      Array.from({ length: RUNS }, () => enqueueOne()),
    );
    expect(enqueued).toHaveLength(RUNS);

    // Every worker hammers claimNext simultaneously until the queue is drained. This is the
    // scenario that a naive "SELECT then UPDATE" loses: two workers read the same row before
    // either writes.
    const claimedBy = new Map<string, string>();
    const collisions: string[] = [];

    await Promise.all(
      Array.from({ length: WORKERS }, async (_, w) => {
        const workerId = `worker-${w}`;
        for (;;) {
          const run = await queue.claimNext(workerId);
          if (run === null) break;
          const previous = claimedBy.get(run.id);
          if (previous !== undefined) {
            collisions.push(`${run.id} claimed by both ${previous} and ${workerId}`);
          }
          claimedBy.set(run.id, workerId);
        }
      }),
    );

    expect(collisions).toEqual([]);
    expect(claimedBy.size).toBe(RUNS);

    // And the database agrees: every run is running, each with exactly one owner.
    const rows = await query<{ status: string; claimed_by: string | null }>(
      'SELECT status, claimed_by FROM runs',
    );
    expect(rows).toHaveLength(RUNS);
    expect(rows.every((r) => r.status === 'running')).toBe(true);
    expect(rows.every((r) => r.claimed_by !== null)).toBe(true);
  });
});

describe('leases and the reaper', () => {
  it('renews a lease for the owning worker', async () => {
    const run = await enqueueOne();
    await queue.claimNext('worker-1');
    expect(await queue.renewLease(run.id, 'worker-1')).toBe(true);
  });

  it('refuses to renew for a worker that does not own the run', async () => {
    // Matters because a worker whose lease was reaped must NOT be able to take it back: the run
    // now belongs to whoever picked it up, and two owners means two executions.
    const run = await enqueueOne();
    await queue.claimNext('worker-1');
    expect(await queue.renewLease(run.id, 'worker-2')).toBe(false);
  });

  it('requeues a run whose lease expired', async () => {
    const run = await enqueueOne();
    await queue.claimNext('dead-worker');

    // Simulate the worker dying: expire the lease directly.
    await query(`UPDATE runs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      run.id,
    ]);

    const reaped = await queue.reapExpiredLeases(3);
    expect(reaped.requeued).toContain(run.id);

    const after = await queue.findById(run.id);
    expect(after?.status).toBe('queued');
    expect(after?.claimed_by).toBe(null);
    expect(after?.attempt).toBe(2); // the recovery is visible in the record

    // And it is claimable again.
    expect((await queue.claimNext('worker-2'))?.id).toBe(run.id);
  });

  it('fails a run that has exhausted its attempts instead of requeueing forever', async () => {
    const run = await enqueueOne();
    await query('UPDATE runs SET attempt = 3 WHERE id = $1', [run.id]);
    await queue.claimNext('dead-worker');
    await query(`UPDATE runs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      run.id,
    ]);

    const reaped = await queue.reapExpiredLeases(3);
    expect(reaped.failed).toContain(run.id);

    const after = await queue.findById(run.id);
    expect(after?.status).toBe('failed');
    expect(after?.error_identity).toBe('lease_expired');
    expect(after?.finished_at).not.toBe(null);
  });

  it('leaves a live lease alone', async () => {
    const run = await enqueueOne();
    await queue.claimNext('worker-1');
    const reaped = await queue.reapExpiredLeases(3);
    expect(reaped.requeued).not.toContain(run.id);
    expect((await queue.findById(run.id))?.status).toBe('running');
  });
});

describe('concurrency policy', () => {
  const setPolicy = (policy: 'skip' | 'queue' | 'allow', max = 1, maxQueued = 10) =>
    query(
      `UPDATE tasks SET concurrency_policy = $2, max_concurrent_runs = $3, max_queued = $4
       WHERE id = $1`,
      [taskId, policy, max, maxQueued],
    );

  it('skip: records a skipped run rather than dropping it', async () => {
    // Recording the skip is the point — a task that never runs must not look identical to a task
    // that runs fine.
    await setPolicy('skip');
    const first = await enqueueOne({ trigger: 'schedule' });
    expect(first.status).toBe('queued');

    const second = await enqueueOne({ trigger: 'schedule' });
    expect(second.status).toBe('skipped');
    expect(second.error_identity).toBe('concurrency_skipped');
    expect(second.finished_at).not.toBe(null);

    // It is in the record, visible.
    const all = await query<{ status: string }>('SELECT status FROM runs ORDER BY created_at');
    expect(all.map((r) => r.status)).toEqual(['queued', 'skipped']);
  });

  it('skip: does not police a MANUAL run', async () => {
    // The user is standing there asking for it; refusing would be baffling.
    await setPolicy('skip');
    await enqueueOne({ trigger: 'schedule' });
    const manual = await enqueueOne({ trigger: 'manual' });
    expect(manual.status).toBe('queued');
  });

  it('queue: allows a backlog up to max_queued, then refuses visibly', async () => {
    await setPolicy('queue', 1, 3);
    const results = [];
    for (let i = 0; i < 5; i += 1) {
      results.push((await enqueueOne({ trigger: 'schedule' })).status);
    }
    expect(results.filter((s) => s === 'queued')).toHaveLength(3);
    expect(results.filter((s) => s === 'skipped')).toHaveLength(2);
  });

  it('allow: permits parallel runs up to the limit', async () => {
    await setPolicy('allow', 3);
    const a = await enqueueOne({ trigger: 'schedule' });
    await queue.claimNext('w1');
    const b = await enqueueOne({ trigger: 'schedule' });
    await queue.claimNext('w2');
    const c = await enqueueOne({ trigger: 'schedule' });
    await queue.claimNext('w3');

    expect([a.status, b.status, c.status]).toEqual(['queued', 'queued', 'queued']);

    // Fourth exceeds max_concurrent_runs while three are running.
    const d = await enqueueOne({ trigger: 'schedule' });
    expect(d.status).toBe('skipped');
  });

  it('enforces the policy correctly under concurrent enqueues', async () => {
    // The TOCTOU case: two schedulers both check "is anything running?" and both see zero.
    // The task row lock inside the transaction is what prevents it.
    await setPolicy('skip');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => enqueueOne({ trigger: 'schedule' })),
    );
    const queued = results.filter((r) => r.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(results.filter((r) => r.status === 'skipped')).toHaveLength(9);
  });
});

describe('completion and cancellation', () => {
  it('records duration on completion', async () => {
    const run = await enqueueOne();
    await queue.claimNext('w1');
    await queue.complete(run.id, 'succeeded');

    const after = await queue.findById(run.id);
    expect(after?.status).toBe('succeeded');
    expect(after?.finished_at).not.toBe(null);
    expect(after?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(after?.claimed_by).toBe(null); // lease released
  });

  it('records a failure identity and message', async () => {
    const run = await enqueueOne();
    await queue.claimNext('w1');
    await queue.complete(run.id, 'failed', {
      identity: 'step_failed',
      message: 'The fetch step failed.',
    });

    const after = await queue.findById(run.id);
    expect(after?.status).toBe('failed');
    expect(after?.error_identity).toBe('step_failed');
    expect(after?.error_message).toBe('The fetch step failed.');
  });

  it('cancels a queued run outright', async () => {
    const run = await enqueueOne();
    expect(await queue.cancelQueued(run.id)).toBe(true);
    expect((await queue.findById(run.id))?.status).toBe('cancelled');
  });

  it('cannot cancel-as-queued a run that is already running', async () => {
    const run = await enqueueOne();
    await queue.claimNext('w1');
    expect(await queue.cancelQueued(run.id)).toBe(false);

    // A running run is cancelled cooperatively instead — the executor checks the flag between
    // steps, so the record is never left half-written.
    expect(await queue.requestCancel(run.id)).toBe(true);
    expect(await queue.isCancelRequested(run.id)).toBe(true);
  });

  it('will not request cancellation on a finished run', async () => {
    const run = await enqueueOne();
    await queue.claimNext('w1');
    await queue.complete(run.id, 'succeeded');
    expect(await queue.requestCancel(run.id)).toBe(false);
  });
});

describe('stats', () => {
  it('reports queue depth and the oldest queued run', async () => {
    await enqueueOne();
    await enqueueOne();
    const running = await enqueueOne();
    await query('UPDATE runs SET status = $2 WHERE id = $1', [running.id, 'running']);

    const stats = await queue.stats();
    expect(stats.queued).toBe(2);
    expect(stats.running).toBe(1);
    expect(stats.oldest_queued_at).not.toBe(null);
  });

  it('counts stuck leases', async () => {
    const run = await enqueueOne();
    await queue.claimNext('w1');
    await query(`UPDATE runs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      run.id,
    ]);
    expect((await queue.stats()).stuck_leases).toBe(1);
  });
});
