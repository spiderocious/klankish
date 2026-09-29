import type { ConcurrencyPolicy, TaskGraph, TaskStatus } from '@klankish/shared';
import type { PoolClient } from 'pg';

import { query, queryOne, txQuery, txQueryOne } from '../../db/client.js';

/** SQL only. Every column named explicitly — `SELECT *` breaks the moment a column is added. */

export interface TaskRow {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: TaskStatus;
  current_version_id: string | null;
  concurrency_policy: ConcurrencyPolicy;
  max_concurrent_runs: number;
  max_queued: number;
  timeout_ms: number | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface TaskVersionRow {
  id: string;
  task_id: string;
  version: number;
  graph: TaskGraph;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

const TASK_COLUMNS = `
  id, owner_id, name, slug, description, status, current_version_id,
  concurrency_policy, max_concurrent_runs, max_queued, timeout_ms, tags,
  created_at, updated_at
`;

export const tasksRepo = {
  async findById(id: string): Promise<TaskRow | null> {
    return queryOne<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1 AND is_deleted = FALSE`,
      [id],
    );
  },

  /**
   * Cursor-paginated list. Fetches `limit + 1` so `has_more` is answered without a COUNT.
   *
   * The cursor pair is (created_at, id): created_at alone is not unique, and a tie at the page
   * boundary would silently drop or repeat a row.
   */
  async list(opts: {
    ownerId?: string;
    status?: TaskStatus;
    tag?: string;
    search?: string;
    cursor?: { last_id: string; last_sort_key: string };
    limit: number;
  }): Promise<TaskRow[]> {
    const where: string[] = ['is_deleted = FALSE'];
    const params: unknown[] = [];

    if (opts.ownerId !== undefined) {
      params.push(opts.ownerId);
      where.push(`owner_id = $${params.length}`);
    }
    if (opts.status !== undefined) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    if (opts.tag !== undefined) {
      params.push(opts.tag);
      where.push(`$${params.length} = ANY(tags)`);
    }
    if (opts.search !== undefined && opts.search !== '') {
      params.push(`%${opts.search}%`);
      where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
    }
    if (opts.cursor !== undefined) {
      params.push(opts.cursor.last_sort_key, opts.cursor.last_id);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }

    params.push(opts.limit + 1);

    return query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
      params,
    );
  },

  async slugExists(ownerId: string, slug: string, exceptId?: string): Promise<boolean> {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM tasks
       WHERE owner_id = $1 AND slug = $2 AND is_deleted = FALSE
         AND ($3::text IS NULL OR id <> $3)`,
      [ownerId, slug, exceptId ?? null],
    );
    return row !== null;
  },

  async create(
    input: {
      id: string;
      ownerId: string;
      name: string;
      slug: string;
      description: string | null;
      concurrencyPolicy: ConcurrencyPolicy;
      maxConcurrentRuns: number;
      timeoutMs: number | null;
      tags: string[];
    },
    client: PoolClient,
  ): Promise<TaskRow> {
    const rows = await txQuery<TaskRow>(
      client,
      `INSERT INTO tasks (
         id, owner_id, name, slug, description,
         concurrency_policy, max_concurrent_runs, timeout_ms, tags
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${TASK_COLUMNS}`,
      [
        input.id,
        input.ownerId,
        input.name,
        input.slug,
        input.description,
        input.concurrencyPolicy,
        input.maxConcurrentRuns,
        input.timeoutMs,
        input.tags,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('insert returned no row');
    return row;
  },

  async update(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      status?: TaskStatus;
      concurrencyPolicy?: ConcurrencyPolicy;
      maxConcurrentRuns?: number;
      timeoutMs?: number | null;
      tags?: string[];
    },
  ): Promise<TaskRow | null> {
    // COALESCE with a typed null means "leave alone", so one statement handles any subset of
    // fields without building SQL by string concatenation.
    return queryOne<TaskRow>(
      `UPDATE tasks SET
         name = COALESCE($2, name),
         description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         status = COALESCE($5, status),
         concurrency_policy = COALESCE($6, concurrency_policy),
         max_concurrent_runs = COALESCE($7, max_concurrent_runs),
         timeout_ms = CASE WHEN $8::boolean THEN $9 ELSE timeout_ms END,
         tags = COALESCE($10, tags)
       WHERE id = $1 AND is_deleted = FALSE
       RETURNING ${TASK_COLUMNS}`,
      [
        id,
        patch.name ?? null,
        patch.description !== undefined,
        patch.description ?? null,
        patch.status ?? null,
        patch.concurrencyPolicy ?? null,
        patch.maxConcurrentRuns ?? null,
        patch.timeoutMs !== undefined,
        patch.timeoutMs ?? null,
        patch.tags ?? null,
      ],
    );
  },

  /** Soft delete. Hard deletes are reserved for admin purges. */
  async softDelete(id: string): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE tasks SET is_deleted = TRUE, deleted_at = now(), status = 'archived'
       WHERE id = $1 AND is_deleted = FALSE
       RETURNING id`,
      [id],
    );
    return rows.length > 0;
  },

  // --- versions ---

  async createVersion(
    input: {
      id: string;
      taskId: string;
      graph: TaskGraph;
      note: string | null;
      createdBy: string;
    },
    client: PoolClient,
  ): Promise<TaskVersionRow> {
    // The version number is computed in the same statement, under the task row lock the caller
    // holds. Reading max(version) separately would race two concurrent saves into the same number.
    const rows = await txQuery<TaskVersionRow>(
      client,
      `INSERT INTO task_versions (id, task_id, version, graph, note, created_by)
       VALUES (
         $1, $2,
         COALESCE((SELECT max(version) FROM task_versions WHERE task_id = $2), 0) + 1,
         $3, $4, $5
       )
       RETURNING id, task_id, version, graph, note, created_by, created_at`,
      [input.id, input.taskId, JSON.stringify(input.graph), input.note, input.createdBy],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('insert returned no row');
    return row;
  },

  async setCurrentVersion(
    taskId: string,
    versionId: string,
    client: PoolClient,
  ): Promise<void> {
    await txQuery(client, 'UPDATE tasks SET current_version_id = $2 WHERE id = $1', [
      taskId,
      versionId,
    ]);
  },

  async findVersion(versionId: string): Promise<TaskVersionRow | null> {
    return queryOne<TaskVersionRow>(
      `SELECT id, task_id, version, graph, note, created_by, created_at
       FROM task_versions WHERE id = $1`,
      [versionId],
    );
  },

  async currentGraph(taskId: string): Promise<TaskVersionRow | null> {
    return queryOne<TaskVersionRow>(
      `SELECT tv.id, tv.task_id, tv.version, tv.graph, tv.note, tv.created_by, tv.created_at
       FROM tasks t
       JOIN task_versions tv ON tv.id = t.current_version_id
       WHERE t.id = $1`,
      [taskId],
    );
  },

  async listVersions(taskId: string, limit = 50): Promise<TaskVersionRow[]> {
    return query<TaskVersionRow>(
      `SELECT tv.id, tv.task_id, tv.version, tv.graph, tv.note, tv.created_by, tv.created_at
       FROM task_versions tv
       WHERE tv.task_id = $1
       ORDER BY tv.version DESC
       LIMIT $2`,
      [taskId, limit],
    );
  },

  async lockTask(taskId: string, client: PoolClient): Promise<TaskRow | null> {
    return txQueryOne<TaskRow>(
      client,
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1 AND is_deleted = FALSE FOR UPDATE`,
      [taskId],
    );
  },

  /** Aggregate stats per task, for the list and detail screens. */
  async statsFor(taskIds: readonly string[]): Promise<Map<string, {
    runs_total: number;
    runs_succeeded: number;
    runs_failed: number;
    p50_duration_ms: number | null;
    p95_duration_ms: number | null;
    last_run_at: string | null;
    last_run_status: string | null;
  }>> {
    if (taskIds.length === 0) return new Map();

    const rows = await query<{
      task_id: string;
      runs_total: string;
      runs_succeeded: string;
      runs_failed: string;
      p50: number | null;
      p95: number | null;
      last_run_at: string | null;
      last_run_status: string | null;
    }>(
      `SELECT
         task_id,
         count(*)::text AS runs_total,
         count(*) FILTER (WHERE status = 'succeeded')::text AS runs_succeeded,
         count(*) FILTER (WHERE status = 'failed')::text AS runs_failed,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95,
         max(created_at) AS last_run_at,
         (ARRAY_AGG(status ORDER BY created_at DESC))[1]::text AS last_run_status
       FROM runs
       WHERE task_id = ANY($1)
       GROUP BY task_id`,
      [taskIds],
    );

    return new Map(
      rows.map((r) => [
        r.task_id,
        {
          runs_total: Number(r.runs_total),
          runs_succeeded: Number(r.runs_succeeded),
          runs_failed: Number(r.runs_failed),
          p50_duration_ms: r.p50,
          p95_duration_ms: r.p95,
          last_run_at: r.last_run_at,
          last_run_status: r.last_run_status,
        },
      ]),
    );
  },

  /**
   * Consecutive failures, newest first, stopping at the first success.
   *
   * Drives the "N failures in a row" alert rule. Done in SQL rather than by fetching runs and
   * counting in JS, because the alert check runs for every task on every failure.
   */
  async consecutiveFailures(taskId: string): Promise<number> {
    const row = await queryOne<{ n: string }>(
      `WITH ordered AS (
         SELECT status, row_number() OVER (ORDER BY created_at DESC) AS rn
         FROM runs
         WHERE task_id = $1 AND status IN ('succeeded', 'failed', 'timed_out')
         LIMIT 100
       ),
       first_success AS (
         SELECT COALESCE(min(rn), 101) AS rn FROM ordered WHERE status = 'succeeded'
       )
       SELECT (SELECT rn FROM first_success)::int - 1 AS n`,
      [taskId],
    );
    return Math.max(0, Number(row?.n ?? '0'));
  },
};
