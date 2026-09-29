import { nextFireAt, type ScheduleKind } from '@klankish/shared';

import { transaction, txQuery } from '../db/client.js';
import { env } from '../platform/env.js';
import { subLogger } from '../platform/logger.js';
import { queue } from './queue.js';

/**
 * The scheduler.
 *
 * Ticks every SCHEDULER_TICK_MS, finds schedules whose next fire time has passed, enqueues a run,
 * and advances the schedule — all inside ONE transaction per schedule, so a crash mid-tick can
 * neither double-fire nor skip.
 *
 * `FOR UPDATE SKIP LOCKED` again: several replicas may all run a scheduler, and each takes
 * different rows rather than all firing the same one.
 *
 * The catch-up rule is the part worth reading twice. When an instance has been down for a day, a
 * daily schedule has ~1 missed fire and a minutely schedule has ~1440. Firing all of them on
 * recovery is never what anyone wants — it is a self-inflicted stampede against whatever the task
 * calls. So missed fires are skipped forward and only MAX_CATCHUP_FIRES (default 1) are actually
 * enqueued.
 */

const log = subLogger('scheduler');

interface DueSchedule {
  id: string;
  task_id: string;
  kind: ScheduleKind;
  cron_expr: string | null;
  interval_ms: number | null;
  run_at: string | null;
  timezone: string;
  jitter_ms: number;
  next_fire_at: string;
  task_status: string;
  current_version_id: string | null;
  owner_id: string;
}

/** Compute the fire after `from` for a schedule. Null means "never again". */
function computeNext(schedule: DueSchedule, from: Date): Date | null {
  switch (schedule.kind) {
    case 'cron':
      return schedule.cron_expr === null
        ? null
        : nextFireAt(schedule.cron_expr, from, schedule.timezone);

    case 'interval':
      return schedule.interval_ms === null
        ? null
        : new Date(from.getTime() + schedule.interval_ms);

    // A one-shot has no next fire; it is disabled after running.
    case 'once':
      return null;

    // Neither of these is time-driven, so the scheduler never picks them up at all.
    case 'manual':
    case 'webhook':
      return null;

    default: {
      const never: never = schedule.kind;
      void never;
      return null;
    }
  }
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private ticking = false;

  start(): void {
    if (this.running) return;
    this.running = true;

    log.info({ tick_ms: env.SCHEDULER_TICK_MS }, 'scheduler started');
    this.scheduleTick(0);
  }

  private scheduleTick(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleTick(env.SCHEDULER_TICK_MS));
    }, delay);
    this.timer.unref();
  }

  /**
   * One pass over due schedules.
   *
   * Guarded against re-entry: a slow tick must not overlap the next one, or the same schedule
   * could be processed twice in parallel within one process.
   */
  async tick(): Promise<{ fired: number; skipped: number }> {
    if (this.ticking) return { fired: 0, skipped: 0 };
    this.ticking = true;

    let fired = 0;
    let skipped = 0;

    try {
      // Process one schedule per transaction rather than all in one: a single bad schedule then
      // cannot roll back the work done for every other one in the tick.
      //
      // Bounded per tick. Without a bound, a schedule that somehow stays due would be picked up
      // again and again inside this same loop and the tick would never return — the next tick is
      // only a few seconds away, so stopping early costs nothing.
      const MAX_PER_TICK = 500;
      for (let i = 0; i < MAX_PER_TICK; i += 1) {
        const processed = await this.processOneDue();
        if (processed === null) break;
        if (processed.fired) fired += 1;
        else skipped += 1;
      }
    } catch (err) {
      log.error({ err }, 'scheduler tick failed');
    } finally {
      this.ticking = false;
    }

    if (fired > 0 || skipped > 0) {
      log.info({ fired, skipped }, 'scheduler tick');
    }
    return { fired, skipped };
  }

  private async processOneDue(): Promise<{ fired: boolean } | null> {
    return transaction(async (client) => {
      const rows = await txQuery<DueSchedule>(
        client,
        `SELECT s.id, s.task_id, s.kind, s.cron_expr, s.interval_ms, s.run_at,
                s.timezone, s.jitter_ms, s.next_fire_at,
                t.status AS task_status, t.current_version_id, t.owner_id
         FROM schedules s
         JOIN tasks t ON t.id = s.task_id
         WHERE s.enabled = TRUE
           AND s.next_fire_at IS NOT NULL
           AND s.next_fire_at <= now()
           AND t.is_deleted = FALSE
         ORDER BY s.next_fire_at
         FOR UPDATE OF s SKIP LOCKED
         LIMIT 1`,
      );

      const schedule = rows[0];
      if (schedule === undefined) return null;

      const dueAt = new Date(schedule.next_fire_at);
      const now = new Date();

      // --- advance past missed fires ---
      //
      // Catching up is NOT a matter of walking every missed fire. A minutely schedule that was
      // down for a week has ~10,000 of them, and stepping through one at a time inside an open
      // transaction is how a scheduler tick turns into a two-minute lock.
      //
      // So the walk is hard-bounded, and once the bound is hit the schedule is jumped straight
      // to the next fire after NOW. The behaviour is identical (fire at most MAX_CATCHUP_FIRES
      // and move on); only the cost differs.
      const WALK_LIMIT = 200;

      let cursor = dueAt;
      let missed = 0;
      let nextAfter: Date | null = computeNext(schedule, cursor);

      while (nextAfter !== null && nextAfter <= now && missed < WALK_LIMIT) {
        missed += 1;
        cursor = nextAfter;
        nextAfter = computeNext(schedule, cursor);
      }

      // Still behind after the walk limit: skip ahead rather than grinding.
      if (nextAfter !== null && nextAfter <= now) {
        log.warn(
          { schedule_id: schedule.id, walked: missed },
          'schedule is far behind — jumping forward instead of walking every missed fire',
        );
        nextAfter = computeNext(schedule, now);
        // A schedule whose next fire never advances past now would be returned by the query
        // forever, and the tick loop would spin. Disabling it is drastic but honest: something
        // about this schedule is wrong, and it is visible rather than silently hot-looping.
        if (nextAfter !== null && nextAfter <= now) {
          log.error(
            { schedule_id: schedule.id, kind: schedule.kind },
            'schedule cannot advance past now — disabling it to avoid a hot loop',
          );
          await txQuery(
            client,
            'UPDATE schedules SET enabled = FALSE, next_fire_at = NULL WHERE id = $1',
            [schedule.id],
          );
          return { fired: false };
        }
      }

      if (missed > env.MAX_CATCHUP_FIRES) {
        log.warn(
          { schedule_id: schedule.id, missed, firing: env.MAX_CATCHUP_FIRES },
          'schedule was behind — skipping missed fires rather than stampeding',
        );
      }

      // A paused or archived task still has its schedule advanced, so resuming it does not
      // trigger a flood of catch-up runs.
      const taskRunnable = schedule.task_status === 'active';
      const hasVersion = schedule.current_version_id !== null;

      let didFire = false;

      if (taskRunnable && hasVersion && schedule.current_version_id !== null) {
        // Jitter de-correlates many tasks that share one cron expression, so twenty tasks on
        // `0 * * * *` do not all hit the same API in the same millisecond.
        const jitter =
          schedule.jitter_ms > 0 ? Math.floor(Math.random() * schedule.jitter_ms) : 0;
        const scheduledFor = new Date(dueAt.getTime() + jitter).toISOString();

        // Enqueue on THIS transaction's client, not a new one.
        //
        // The earlier version opened a second transaction here, which meant one transaction held
        // `FOR UPDATE` on `schedules` while waiting for `FOR UPDATE` on `tasks` — and a
        // concurrent scheduler could hold them the other way round. That is a deadlock, and it
        // reliably hung a tick under concurrency.
        //
        // Joining the transaction also keeps the run and the schedule advance atomic: a crash
        // between them can no longer double-fire or skip.
        await queue.enqueue(
          {
            taskId: schedule.task_id,
            taskVersionId: schedule.current_version_id,
            trigger: 'schedule',
            scheduleId: schedule.id,
            scheduledFor,
            createdBy: schedule.owner_id,
          },
          client,
        );

        didFire = true;
      }

      // --- advance the schedule ---
      const finalNext = nextAfter;

      if (schedule.kind === 'once' || finalNext === null) {
        // A one-shot disables itself. Leaving it enabled with a null next_fire_at would be
        // indistinguishable from a broken cron expression.
        await txQuery(
          client,
          `UPDATE schedules SET enabled = FALSE, last_fire_at = $2, next_fire_at = NULL
           WHERE id = $1`,
          [schedule.id, dueAt.toISOString()],
        );
      } else {
        await txQuery(
          client,
          'UPDATE schedules SET last_fire_at = $2, next_fire_at = $3 WHERE id = $1',
          [schedule.id, dueAt.toISOString(), finalNext.toISOString()],
        );
      }

      return { fired: didFire };
    });
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.running = false;
    log.info('scheduler stopped');
  }
}

/**
 * Compute the initial `next_fire_at` when a schedule is created or changed.
 *
 * Exported because the API needs it at save time: a schedule with a null next_fire_at would never
 * be picked up, and the failure mode is silence.
 */
export function initialNextFire(
  kind: ScheduleKind,
  opts: { cronExpr?: string | null; intervalMs?: number | null; runAt?: string | null; timezone: string },
  from: Date = new Date(),
): Date | null {
  switch (kind) {
    case 'cron':
      return opts.cronExpr == null ? null : nextFireAt(opts.cronExpr, from, opts.timezone);
    case 'interval':
      return opts.intervalMs == null ? null : new Date(from.getTime() + opts.intervalMs);
    case 'once': {
      if (opts.runAt == null) return null;
      const at = new Date(opts.runAt);
      // A one-shot scheduled in the past fires immediately rather than never — that is what
      // someone setting a time that has just passed actually wants.
      return Number.isNaN(at.getTime()) ? null : at;
    }
    case 'manual':
    case 'webhook':
      return null;
    default: {
      const never: never = kind;
      void never;
      return null;
    }
  }
}
