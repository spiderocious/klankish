import { newId } from '@klankish/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { closePool, query } from '../db/client.js';
import { runMigrations, truncateAll } from '../db/migrate.js';
import { Scheduler, initialNextFire } from './scheduler.js';

/**
 * Scheduler integration tests.
 *
 * Written after a live bug: a task created with an every-15-minutes schedule sat with a
 * `next_fire_at` two hours in the past and never fired. These tests pin down the behaviours that
 * were unverified — advancing the schedule, enqueueing a run, bounded catch-up, and not firing a
 * paused task.
 */

let userId: string;
let taskId: string;
let versionId: string;

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
  versionId = newId('task_version');
  await query(
    `INSERT INTO tasks (id, owner_id, name, slug, status, concurrency_policy)
     VALUES ($1, $2, 'Scheduled', 'scheduled', 'active', 'allow')`,
    [taskId, userId],
  );
  await query(
    'INSERT INTO task_versions (id, task_id, version, graph) VALUES ($1, $2, 1, $3)',
    [
      versionId,
      taskId,
      JSON.stringify({
        version: 1,
        entry: 'a',
        steps: [{ kind: 'noop', key: 'a', next: null }],
      }),
    ],
  );
  await query('UPDATE tasks SET current_version_id = $2 WHERE id = $1', [taskId, versionId]);
});

async function makeSchedule(opts: {
  cron?: string;
  nextFireAt: Date;
  enabled?: boolean;
  timezone?: string;
}): Promise<string> {
  const id = newId('schedule');
  await query(
    `INSERT INTO schedules (id, task_id, kind, cron_expr, timezone, enabled, next_fire_at)
     VALUES ($1, $2, 'cron', $3, $4, $5, $6)`,
    [
      id,
      taskId,
      opts.cron ?? '*/15 * * * *',
      opts.timezone ?? 'UTC',
      opts.enabled ?? true,
      opts.nextFireAt.toISOString(),
    ],
  );
  return id;
}

const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);
const minutesAhead = (n: number): Date => new Date(Date.now() + n * 60_000);

describe('initialNextFire', () => {
  it('computes a future fire for a cron schedule', () => {
    const next = initialNextFire('cron', { cronExpr: '*/15 * * * *', timezone: 'UTC' });
    expect(next).not.toBe(null);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it('honours the timezone', () => {
    const next = initialNextFire('cron', { cronExpr: '0 3 * * *', timezone: 'Africa/Lagos' });
    expect(next).not.toBe(null);
    // Africa/Lagos is UTC+1 year-round, so 03:00 local is 02:00Z.
    expect(next!.getUTCHours()).toBe(2);
  });

  it('returns null for manual and webhook kinds', () => {
    expect(initialNextFire('manual', { timezone: 'UTC' })).toBe(null);
    expect(initialNextFire('webhook', { timezone: 'UTC' })).toBe(null);
  });
});

describe('tick', () => {
  it('fires a due schedule and enqueues a run', async () => {
    await makeSchedule({ nextFireAt: minutesAgo(1) });

    const result = await new Scheduler().tick();
    expect(result.fired).toBe(1);

    const runs = await query<{ trigger: string; status: string }>(
      'SELECT trigger, status FROM runs',
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe('schedule');
    expect(runs[0]?.status).toBe('queued');
  });

  it('ADVANCES next_fire_at into the future', async () => {
    // The exact bug that prompted this file: the schedule fired conceptually but its next fire
    // stayed in the past, so it could never fire again.
    await makeSchedule({ nextFireAt: minutesAgo(1) });

    await new Scheduler().tick();

    const rows = await query<{ next_fire_at: string; last_fire_at: string | null }>(
      'SELECT next_fire_at, last_fire_at FROM schedules',
    );
    const next = rows[0]?.next_fire_at;
    expect(next).toBeDefined();
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
    expect(rows[0]?.last_fire_at).not.toBe(null);
  });

  it('does not fire a schedule that is not yet due', async () => {
    await makeSchedule({ nextFireAt: minutesAhead(30) });
    const result = await new Scheduler().tick();
    expect(result.fired).toBe(0);
    expect(await query('SELECT id FROM runs')).toHaveLength(0);
  });

  it('does not fire a disabled schedule', async () => {
    await makeSchedule({ nextFireAt: minutesAgo(5), enabled: false });
    const result = await new Scheduler().tick();
    expect(result.fired).toBe(0);
  });

  it('does not run a PAUSED task, but still advances its schedule', async () => {
    // Advancing anyway is deliberate: resuming a task must not trigger a flood of catch-up runs.
    await query("UPDATE tasks SET status = 'paused' WHERE id = $1", [taskId]);
    await makeSchedule({ nextFireAt: minutesAgo(1) });

    await new Scheduler().tick();

    expect(await query('SELECT id FROM runs')).toHaveLength(0);
    const rows = await query<{ next_fire_at: string }>('SELECT next_fire_at FROM schedules');
    expect(new Date(rows[0]!.next_fire_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('bounds catch-up after downtime instead of stampeding', async () => {
    // A minutely schedule three hours behind has ~180 missed fires. Firing them all on recovery
    // would be a self-inflicted flood against whatever the task calls.
    await makeSchedule({ cron: '* * * * *', nextFireAt: minutesAgo(180) });

    await new Scheduler().tick();

    const runs = await query('SELECT id FROM runs');
    expect(runs.length).toBeLessThanOrEqual(2); // MAX_CATCHUP_FIRES is 1 by default

    const rows = await query<{ next_fire_at: string }>('SELECT next_fire_at FROM schedules');
    expect(new Date(rows[0]!.next_fire_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('processes several due schedules in one tick', async () => {
    await makeSchedule({ nextFireAt: minutesAgo(1) });

    const otherTask = newId('task');
    const otherVersion = newId('task_version');
    await query(
      `INSERT INTO tasks (id, owner_id, name, slug, status, concurrency_policy)
       VALUES ($1, $2, 'Second', 'second', 'active', 'allow')`,
      [otherTask, userId],
    );
    await query(
      'INSERT INTO task_versions (id, task_id, version, graph) VALUES ($1, $2, 1, $3)',
      [
        otherVersion,
        otherTask,
        JSON.stringify({ version: 1, entry: 'a', steps: [{ kind: 'noop', key: 'a', next: null }] }),
      ],
    );
    await query('UPDATE tasks SET current_version_id = $2 WHERE id = $1', [
      otherTask,
      otherVersion,
    ]);
    await query(
      `INSERT INTO schedules (id, task_id, kind, cron_expr, timezone, enabled, next_fire_at)
       VALUES ($1, $2, 'cron', '*/15 * * * *', 'UTC', TRUE, $3)`,
      [newId('schedule'), otherTask, minutesAgo(2).toISOString()],
    );

    const result = await new Scheduler().tick();
    expect(result.fired).toBe(2);
    expect(await query('SELECT id FROM runs')).toHaveLength(2);
  });

  it('is safe to run concurrently — no schedule fires twice', async () => {
    // Several replicas may all run a scheduler. SKIP LOCKED is what stops them duplicating work.
    await makeSchedule({ nextFireAt: minutesAgo(1) });

    await Promise.all([
      new Scheduler().tick(),
      new Scheduler().tick(),
      new Scheduler().tick(),
    ]);

    expect(await query('SELECT id FROM runs')).toHaveLength(1);
  });

  it('disables a one-shot schedule after it fires', async () => {
    const id = newId('schedule');
    await query(
      `INSERT INTO schedules (id, task_id, kind, run_at, timezone, enabled, next_fire_at)
       VALUES ($1, $2, 'once', $3, 'UTC', TRUE, $3)`,
      [id, taskId, minutesAgo(1).toISOString()],
    );

    await new Scheduler().tick();

    const rows = await query<{ enabled: boolean; next_fire_at: string | null }>(
      'SELECT enabled, next_fire_at FROM schedules WHERE id = $1',
      [id],
    );
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.next_fire_at).toBe(null);
    expect(await query('SELECT id FROM runs')).toHaveLength(1);
  });
});
