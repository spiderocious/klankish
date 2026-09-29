import {
  describeCron,
  type ScheduleView,
  type TaskDetailView,
  type TaskStats,
  type TaskVersionView,
  type TaskView,
} from '@klankish/shared';

import type { ScheduleRow } from '../schedules/schedules.repo.js';
import type { TaskRow, TaskVersionRow } from './tasks.repo.js';

/**
 * Row → wire mappers. THIS FILE IS THE SERIALISER for tasks.
 *
 * When a doc or a shared type disagrees with this file about a field name or its casing, this
 * file is right. Verify the seam by reading here.
 */

export interface TaskStatsInput {
  runs_total: number;
  runs_succeeded: number;
  runs_failed: number;
  p50_duration_ms: number | null;
  p95_duration_ms: number | null;
  last_run_at: string | null;
  last_run_status: string | null;
  consecutive_failures?: number;
}

export function toTaskStats(input: TaskStatsInput): TaskStats {
  return {
    runs_total: input.runs_total,
    runs_succeeded: input.runs_succeeded,
    runs_failed: input.runs_failed,
    // NULL when there are no runs, not 0. A brand-new task showing "0% success" reads as broken
    // when it simply has not run yet.
    success_rate:
      input.runs_total === 0 ? null : input.runs_succeeded / input.runs_total,
    p50_duration_ms: input.p50_duration_ms,
    p95_duration_ms: input.p95_duration_ms,
    last_run_at: input.last_run_at,
    last_run_status: (input.last_run_status ?? null) as TaskStats['last_run_status'],
    consecutive_failures: input.consecutive_failures ?? 0,
  };
}

export function toScheduleView(row: ScheduleRow, appUrl?: string): ScheduleView {
  return {
    id: row.id,
    kind: row.kind,
    cron_expr: row.cron_expr,
    interval_ms: row.interval_ms,
    run_at: row.run_at,
    timezone: row.timezone,
    enabled: row.enabled,
    jitter_ms: row.jitter_ms,
    next_fire_at: row.next_fire_at,
    last_fire_at: row.last_fire_at,
    // Resolved server-side so the client does not reimplement cron parsing — and so the
    // description can never disagree with the schedule that actually fires.
    description: describeScheduleRow(row),
    // The webhook SECRET is never included; only the URL to post to.
    ...(row.kind === 'webhook' &&
      appUrl !== undefined && {
        webhook_url: `${appUrl}/api/v1/hooks/${row.id}`,
      }),
  };
}

function describeScheduleRow(row: ScheduleRow): string {
  switch (row.kind) {
    case 'cron':
      return row.cron_expr === null
        ? 'Invalid schedule'
        : `${describeCron(row.cron_expr)} (${row.timezone})`;
    case 'interval': {
      if (row.interval_ms === null) return 'Invalid interval';
      const minutes = Math.round(row.interval_ms / 60_000);
      if (minutes < 60) return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `Every ${hours} hour${hours === 1 ? '' : 's'}`;
      const days = Math.round(hours / 24);
      return `Every ${days} day${days === 1 ? '' : 's'}`;
    }
    case 'once':
      return row.run_at === null ? 'Not scheduled' : `Once, at ${row.run_at}`;
    case 'manual':
      return 'Manual only';
    case 'webhook':
      return 'When called by webhook';
    default: {
      const never: never = row.kind;
      void never;
      return 'Unknown';
    }
  }
}

export function toTaskView(
  row: TaskRow,
  extra: {
    stepCount: number;
    schedule?: ScheduleRow | null;
    stats?: TaskStatsInput | null;
    ownerName?: string;
    currentVersion?: number;
    appUrl?: string;
  },
): TaskView {
  return {
    id: row.id,
    owner_id: row.owner_id,
    ...(extra.ownerName !== undefined && { owner_name: extra.ownerName }),
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    tags: row.tags,
    concurrency_policy: row.concurrency_policy,
    max_concurrent_runs: row.max_concurrent_runs,
    timeout_ms: row.timeout_ms,
    current_version: extra.currentVersion ?? 0,
    step_count: extra.stepCount,
    schedule:
      extra.schedule === null || extra.schedule === undefined
        ? null
        : toScheduleView(extra.schedule, extra.appUrl),
    stats: extra.stats === null || extra.stats === undefined ? null : toTaskStats(extra.stats),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toTaskDetailView(
  row: TaskRow,
  version: TaskVersionRow,
  extra: Parameters<typeof toTaskView>[1],
): TaskDetailView {
  return {
    ...toTaskView(row, { ...extra, currentVersion: version.version }),
    graph: version.graph,
  };
}

export function toTaskVersionView(
  row: TaskVersionRow,
  createdByName: string | null = null,
): TaskVersionView {
  return {
    id: row.id,
    version: row.version,
    note: row.note,
    created_by: row.created_by ?? '',
    created_by_name: createdByName,
    created_at: row.created_at,
    step_count: row.graph.steps.length,
  };
}
