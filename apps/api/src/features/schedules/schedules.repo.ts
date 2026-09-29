import type { ScheduleKind } from '@klankish/shared';
import type { PoolClient } from 'pg';

import { query, queryOne, txQuery } from '../../db/client.js';

export interface ScheduleRow {
  id: string;
  task_id: string;
  kind: ScheduleKind;
  cron_expr: string | null;
  interval_ms: number | null;
  run_at: string | null;
  timezone: string;
  enabled: boolean;
  jitter_ms: number;
  next_fire_at: string | null;
  last_fire_at: string | null;
  webhook_secret: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `
  id, task_id, kind, cron_expr, interval_ms, run_at, timezone, enabled,
  jitter_ms, next_fire_at, last_fire_at, webhook_secret, created_at, updated_at
`;

export const schedulesRepo = {
  async findByTask(taskId: string): Promise<ScheduleRow | null> {
    return queryOne<ScheduleRow>(`SELECT ${COLUMNS} FROM schedules WHERE task_id = $1`, [taskId]);
  },

  async findById(id: string): Promise<ScheduleRow | null> {
    return queryOne<ScheduleRow>(`SELECT ${COLUMNS} FROM schedules WHERE id = $1`, [id]);
  },

  async forTasks(taskIds: readonly string[]): Promise<Map<string, ScheduleRow>> {
    if (taskIds.length === 0) return new Map();
    const rows = await query<ScheduleRow>(
      `SELECT ${COLUMNS} FROM schedules WHERE task_id = ANY($1)`,
      [taskIds],
    );
    return new Map(rows.map((r) => [r.task_id, r]));
  },

  /**
   * Create or replace a task's schedule.
   *
   * ON CONFLICT on the one-per-task constraint, so changing a schedule is a single statement and
   * cannot briefly leave a task with none.
   */
  async upsert(
    input: {
      id: string;
      taskId: string;
      kind: ScheduleKind;
      cronExpr: string | null;
      intervalMs: number | null;
      runAt: string | null;
      timezone: string;
      enabled: boolean;
      jitterMs: number;
      nextFireAt: string | null;
      webhookSecret: string | null;
    },
    client?: PoolClient,
  ): Promise<ScheduleRow> {
    const sql = `
      INSERT INTO schedules (
        id, task_id, kind, cron_expr, interval_ms, run_at, timezone,
        enabled, jitter_ms, next_fire_at, webhook_secret
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (task_id) DO UPDATE SET
        kind = EXCLUDED.kind,
        cron_expr = EXCLUDED.cron_expr,
        interval_ms = EXCLUDED.interval_ms,
        run_at = EXCLUDED.run_at,
        timezone = EXCLUDED.timezone,
        enabled = EXCLUDED.enabled,
        jitter_ms = EXCLUDED.jitter_ms,
        next_fire_at = EXCLUDED.next_fire_at,
        -- Keep the existing secret when the caller did not supply one, so editing a webhook
        -- schedule does not silently invalidate every caller's configured signature.
        webhook_secret = COALESCE(EXCLUDED.webhook_secret, schedules.webhook_secret)
      RETURNING ${COLUMNS}`;

    const params = [
      input.id,
      input.taskId,
      input.kind,
      input.cronExpr,
      input.intervalMs,
      input.runAt,
      input.timezone,
      input.enabled,
      input.jitterMs,
      input.nextFireAt,
      input.webhookSecret,
    ];

    const rows =
      client === undefined
        ? await query<ScheduleRow>(sql, params)
        : await txQuery<ScheduleRow>(client, sql, params);

    const row = rows[0];
    if (row === undefined) throw new Error('upsert returned no row');
    return row;
  },

  async setEnabled(taskId: string, enabled: boolean, nextFireAt: string | null): Promise<void> {
    await query(
      `UPDATE schedules SET enabled = $2, next_fire_at = $3 WHERE task_id = $1`,
      [taskId, enabled, nextFireAt],
    );
  },

  async remove(taskId: string): Promise<void> {
    await query('DELETE FROM schedules WHERE task_id = $1', [taskId]);
  },

  /** Upcoming fires across a set of tasks, for the dashboard. */
  async upcoming(
    ownerId: string | null,
    limit: number,
  ): Promise<Array<{ task_id: string; task_name: string; next_fire_at: string; kind: ScheduleKind; cron_expr: string | null; timezone: string; interval_ms: number | null; run_at: string | null }>> {
    return query(
      `SELECT s.task_id, t.name AS task_name, s.next_fire_at, s.kind,
              s.cron_expr, s.timezone, s.interval_ms, s.run_at
       FROM schedules s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.enabled = TRUE
         AND s.next_fire_at IS NOT NULL
         AND t.is_deleted = FALSE
         AND t.status = 'active'
         AND ($1::text IS NULL OR t.owner_id = $1)
       ORDER BY s.next_fire_at
       LIMIT $2`,
      [ownerId, limit],
    );
  },
};
