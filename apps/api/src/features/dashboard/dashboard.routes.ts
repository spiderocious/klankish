import {
  describeCron,
  isAdmin,
  nextFireAt,
  type DashboardView,
  type QueueStatsView,
  type UpcomingFireView,
} from '@klankish/shared';
import type { FastifyInstance } from 'fastify';

import { queryOne } from '../../db/client.js';
import { queue } from '../../engine/queue.js';
import { requireAuth } from '../../platform/auth-hooks.js';
import { rateLimit } from '../../platform/rate-limit.js';
import { ResponseUtil } from '../../platform/response.js';
import { runsService } from '../runs/runs.service.js';
import { schedulesRepo } from '../schedules/schedules.repo.js';
import { tasksService } from '../tasks/tasks.service.js';

/**
 * The dashboard.
 *
 * Aggregated server-side in a handful of queries rather than assembled by the client from six
 * endpoints: the browser should not have to know how to compute a success rate, and doing it here
 * means the number on the dashboard and the number on the task page cannot disagree.
 */
export function register(app: FastifyInstance): void {
  const auth = [requireAuth, rateLimit({ scope: 'dashboard' })];

  app.get(
    '/api/v1/dashboard',
    { preHandler: auth, schema: { tags: ['dashboard'] } },
    async (request, reply) => {
      const actor = request.actor!;
      // Non-admins see only their own numbers; an admin sees the whole instance.
      const ownerFilter = isAdmin(actor.role) ? null : actor.id;

      const [taskCounts, runCounts, queueStats, recent, failing, upcomingRows] = await Promise.all([
        queryOne<{ total: string; active: string; paused: string }>(
          `SELECT count(*)::text AS total,
                  count(*) FILTER (WHERE status = 'active')::text AS active,
                  count(*) FILTER (WHERE status = 'paused')::text AS paused
           FROM tasks
           WHERE is_deleted = FALSE AND ($1::text IS NULL OR owner_id = $1)`,
          [ownerFilter],
        ),
        queryOne<{
          today: string;
          succeeded: string;
          failed: string;
          p95: number | null;
        }>(
          `SELECT count(*)::text AS today,
                  count(*) FILTER (WHERE r.status = 'succeeded')::text AS succeeded,
                  count(*) FILTER (WHERE r.status IN ('failed','timed_out'))::text AS failed,
                  percentile_cont(0.95) WITHIN GROUP (ORDER BY r.duration_ms)::int AS p95
           FROM runs r
           JOIN tasks t ON t.id = r.task_id
           WHERE r.created_at >= now() - interval '24 hours'
             AND ($1::text IS NULL OR t.owner_id = $1)`,
          [ownerFilter],
        ),
        queue.stats(),
        runsService.list(actor, { limit: 10 }),
        tasksService.list(actor, { limit: 5, status: 'active' }),
        schedulesRepo.upcoming(ownerFilter, 5),
      ]);

      const runsToday = Number(runCounts?.today ?? '0');
      const succeeded = Number(runCounts?.succeeded ?? '0');
      const failed = Number(runCounts?.failed ?? '0');

      const oldestAgeMs =
        queueStats.oldest_queued_at === null
          ? null
          : Date.now() - new Date(queueStats.oldest_queued_at).getTime();

      const scheduledNextHour = await queryOne<{ n: string }>(
        `SELECT count(*)::text AS n FROM schedules s
         JOIN tasks t ON t.id = s.task_id
         WHERE s.enabled = TRUE
           AND s.next_fire_at BETWEEN now() AND now() + interval '1 hour'
           AND t.is_deleted = FALSE
           AND ($1::text IS NULL OR t.owner_id = $1)`,
        [ownerFilter],
      );

      const queueView: QueueStatsView = {
        queued: queueStats.queued,
        running: queueStats.running,
        oldest_queued_at: queueStats.oldest_queued_at,
        oldest_queued_age_ms: oldestAgeMs,
        stuck_leases: queueStats.stuck_leases,
        scheduled_next_hour: Number(scheduledNextHour?.n ?? '0'),
      };

      const upcoming: UpcomingFireView[] = upcomingRows.map((r) => ({
        task_id: r.task_id,
        task_name: r.task_name,
        next_fire_at: r.next_fire_at,
        schedule_description:
          r.kind === 'cron' && r.cron_expr !== null
            ? `${describeCron(r.cron_expr)} (${r.timezone})`
            : r.kind === 'interval' && r.interval_ms !== null
              ? `Every ${Math.round(r.interval_ms / 60_000)} min`
              : r.kind,
      }));

      const view: DashboardView = {
        tasks_total: Number(taskCounts?.total ?? '0'),
        tasks_active: Number(taskCounts?.active ?? '0'),
        tasks_paused: Number(taskCounts?.paused ?? '0'),
        runs_today: runsToday,
        runs_succeeded_today: succeeded,
        runs_failed_today: failed,
        // NULL rather than 0 when nothing has run — "0%" on a fresh instance reads as broken.
        success_rate_today: runsToday === 0 ? null : succeeded / runsToday,
        p95_duration_ms: runCounts?.p95 ?? null,
        queue: queueView,
        recent_runs: recent.success ? recent.data.items : [],
        failing_tasks: failing.success
          ? failing.data.items.filter(
              (t) => t.stats !== null && t.stats.consecutive_failures > 0,
            )
          : [],
        upcoming,
      };

      ResponseUtil.ok(reply, view);
    },
  );

  /**
   * Next fires for a cron expression, without saving anything.
   *
   * Powers the builder's "next 5 runs" preview. Computed server-side so the preview uses exactly
   * the same code path as the scheduler — a client-side cron parser would eventually disagree with
   * it, and the disagreement would be invisible until a task fired at the wrong time.
   */
  app.get(
    '/api/v1/schedules/preview',
    { preHandler: auth, schema: { tags: ['schedules'] } },
    async (request, reply) => {
      const q = request.query as { cron?: string; timezone?: string; count?: string };
      const cron = q.cron ?? '';
      const timezone = q.timezone ?? 'UTC';
      const count = Math.min(10, Math.max(1, Number.parseInt(q.count ?? '5', 10) || 5));

      const fires: string[] = [];
      let cursor = new Date();
      for (let i = 0; i < count; i += 1) {
        const next = nextFireAt(cron, cursor, timezone);
        if (next === null) break;
        fires.push(next.toISOString());
        cursor = next;
      }

      ResponseUtil.ok(reply, {
        valid: fires.length > 0,
        description: describeCron(cron),
        next_fires: fires,
      });
    },
  );
}
