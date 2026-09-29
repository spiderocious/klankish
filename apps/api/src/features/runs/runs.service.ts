import {
  buildPage,
  canAccessOwned,
  ERROR_CODES,
  type Actor,
  type RunDetailView,
  type RunStatus,
  type RunTrigger,
  type RunView,
  type StepRunView,
} from '@klankish/shared';

import { query, queryOne } from '../../db/client.js';
import { queue } from '../../engine/queue.js';
import { failures, fail, ok, type ServiceResult } from '../../platform/result.js';
import { auditRepo } from '../audit/audit.repo.js';

/**
 * Runs — the read side of the record.
 *
 * This is the product's core surface: everything here exists so that someone can answer "what
 * happened?" months later without reading a log.
 */

interface RunListRow {
  id: string;
  task_id: string;
  task_name: string;
  task_version: number;
  trigger: RunTrigger;
  status: RunStatus;
  attempt: number;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_identity: string | null;
  error_message: string | null;
  parent_run_id: string | null;
  created_at: string;
  owner_id: string;
  step_count: string;
  steps_succeeded: string;
  steps_failed: string;
}

const RUN_SELECT = `
  SELECT r.id, r.task_id, t.name AS task_name, tv.version AS task_version,
         r.trigger, r.status, r.attempt, r.scheduled_for, r.started_at, r.finished_at,
         r.duration_ms, r.error_identity, r.error_message, r.parent_run_id, r.created_at,
         t.owner_id,
         (SELECT count(*) FROM step_runs sr WHERE sr.run_id = r.id)::text AS step_count,
         (SELECT count(*) FROM step_runs sr WHERE sr.run_id = r.id AND sr.status = 'succeeded')::text
           AS steps_succeeded,
         (SELECT count(*) FROM step_runs sr WHERE sr.run_id = r.id AND sr.status = 'failed')::text
           AS steps_failed
  FROM runs r
  JOIN tasks t ON t.id = r.task_id
  JOIN task_versions tv ON tv.id = r.task_version_id
`;

function toRunView(row: RunListRow): RunView {
  return {
    id: row.id,
    task_id: row.task_id,
    task_name: row.task_name,
    task_version: row.task_version,
    trigger: row.trigger,
    status: row.status,
    attempt: row.attempt,
    scheduled_for: row.scheduled_for,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    // Surfaced deliberately: a growing gap between "due" and "picked up" is the earliest signal
    // that workers are saturated, and it is invisible if you only record duration.
    queue_latency_ms:
      row.started_at === null
        ? null
        : new Date(row.started_at).getTime() - new Date(row.scheduled_for).getTime(),
    error_identity: row.error_identity,
    error_message: row.error_message,
    step_count: Number(row.step_count),
    steps_succeeded: Number(row.steps_succeeded),
    steps_failed: Number(row.steps_failed),
    parent_run_id: row.parent_run_id,
    created_at: row.created_at,
  };
}

interface StepRunRow {
  id: string;
  run_id: string;
  idx: number;
  step_key: string;
  step_name: string | null;
  step_kind: string;
  status: string;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  input: unknown;
  output: unknown;
  error: { identity: string; message: string; detail?: string } | null;
  next_step_key: string | null;
  http_request_method: string | null;
  http_request_url: string | null;
  http_request_headers: Record<string, string> | null;
  http_request_body: unknown;
  http_response_status: number | null;
  http_response_headers: Record<string, string> | null;
  http_response_body: unknown;
  http_response_body_ref: string | null;
  http_bytes: number | null;
  http_duration_ms: number | null;
  http_truncated: boolean | null;
}

function toStepRunView(row: StepRunRow): StepRunView {
  return {
    id: row.id,
    run_id: row.run_id,
    idx: row.idx,
    step_key: row.step_key,
    step_name: row.step_name,
    step_kind: row.step_kind as StepRunView['step_kind'],
    status: row.status as StepRunView['status'],
    attempt: row.attempt,
    started_at: row.started_at,
    finished_at: row.finished_at,
    duration_ms: row.duration_ms,
    input: row.input,
    output: row.output,
    error:
      row.error === null
        ? null
        : {
            identity: row.error.identity,
            message: row.error.message,
            ...(row.error.detail !== undefined && { detail: row.error.detail }),
          },
    next_step_key: row.next_step_key,
    http:
      row.http_request_method === null
        ? null
        : {
            request_method: row.http_request_method,
            request_url: row.http_request_url ?? '',
            request_headers: row.http_request_headers ?? {},
            request_body: row.http_request_body,
            response_status: row.http_response_status,
            response_headers: row.http_response_headers ?? {},
            response_body: row.http_response_body,
            response_body_ref: row.http_response_body_ref,
            bytes: row.http_bytes ?? 0,
            duration_ms: row.http_duration_ms ?? 0,
            truncated: row.http_truncated ?? false,
          },
  };
}

export const runsService = {
  async list(
    actor: Actor,
    opts: {
      taskId?: string;
      status?: RunStatus;
      trigger?: RunTrigger;
      since?: string;
      cursor?: { last_id: string; last_sort_key: string };
      limit: number;
      allUsers?: boolean;
    },
  ): Promise<ServiceResult<{ items: RunView[]; next_cursor: string | null; has_more: boolean }>> {
    const where: string[] = ['t.is_deleted = FALSE'];
    const params: unknown[] = [];

    // A non-admin sees only their own runs. An admin must ask explicitly to see everyone's.
    const scopeToOwner = !(opts.allUsers === true && canAccessOwned(actor, 'any'));
    if (scopeToOwner) {
      params.push(actor.id);
      where.push(`t.owner_id = $${params.length}`);
    }
    if (opts.taskId !== undefined) {
      params.push(opts.taskId);
      where.push(`r.task_id = $${params.length}`);
    }
    if (opts.status !== undefined) {
      params.push(opts.status);
      where.push(`r.status = $${params.length}`);
    }
    if (opts.trigger !== undefined) {
      params.push(opts.trigger);
      where.push(`r.trigger = $${params.length}`);
    }
    if (opts.since !== undefined) {
      params.push(opts.since);
      where.push(`r.created_at >= $${params.length}::timestamptz`);
    }
    if (opts.cursor !== undefined) {
      params.push(opts.cursor.last_sort_key, opts.cursor.last_id);
      where.push(`(r.created_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
    }

    params.push(opts.limit + 1);

    const rows = await query<RunListRow>(
      `${RUN_SELECT}
       WHERE ${where.join(' AND ')}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $${params.length}`,
      params,
    );

    const page = buildPage(rows, opts.limit, (r) => ({
      last_id: r.id,
      last_sort_key: r.created_at,
    }));

    return ok({
      items: page.items.map(toRunView),
      next_cursor: page.next_cursor,
      has_more: page.has_more,
    });
  },

  /** The run inspector's payload: the run plus every step, in execution order. */
  async get(actor: Actor, runId: string): Promise<ServiceResult<RunDetailView>> {
    const row = await queryOne<RunListRow & { vars: Record<string, unknown> }>(
      `${RUN_SELECT.replace('SELECT r.id', 'SELECT r.vars, r.id')}
       WHERE r.id = $1`,
      [runId],
    );

    if (row === null) return failures.notFound('run');
    if (!canAccessOwned(actor, row.owner_id)) return failures.forbidden('not_run_owner');

    const steps = await query<StepRunRow>(
      `SELECT sr.id, sr.run_id, sr.idx, sr.step_key, sr.step_name, sr.step_kind,
              sr.status, sr.attempt, sr.started_at, sr.finished_at, sr.duration_ms,
              sr.input, sr.output, sr.error, sr.next_step_key,
              ex.request_method   AS http_request_method,
              ex.request_url      AS http_request_url,
              ex.request_headers  AS http_request_headers,
              ex.request_body     AS http_request_body,
              ex.response_status  AS http_response_status,
              ex.response_headers AS http_response_headers,
              ex.response_body_inline AS http_response_body,
              ex.response_body_ref    AS http_response_body_ref,
              ex.bytes            AS http_bytes,
              ex.duration_ms      AS http_duration_ms,
              ex.truncated        AS http_truncated
       FROM step_runs sr
       LEFT JOIN http_exchanges ex ON ex.step_run_id = sr.id
       WHERE sr.run_id = $1
       ORDER BY sr.idx`,
      [runId],
    );

    return ok({
      ...toRunView(row),
      steps: steps.map(toStepRunView),
      vars: row.vars,
    });
  },

  async cancel(actor: Actor, runId: string): Promise<ServiceResult<{ status: string }>> {
    const row = await queryOne<{ owner_id: string; status: RunStatus }>(
      `SELECT t.owner_id, r.status FROM runs r
       JOIN tasks t ON t.id = r.task_id WHERE r.id = $1`,
      [runId],
    );

    if (row === null) return failures.notFound('run');
    if (!canAccessOwned(actor, row.owner_id)) return failures.forbidden('not_run_owner');

    if (row.status === 'queued') {
      // Not started, so there is nothing to unwind.
      await queue.cancelQueued(runId);
      await auditRepo.record({ action: 'run.cancelled', subjectType: 'run', subjectId: runId });
      return ok({ status: 'cancelled' });
    }

    if (row.status === 'running') {
      // Cooperative: the executor checks the flag between steps, so the record is never left
      // half-written.
      await queue.requestCancel(runId);
      await auditRepo.record({ action: 'run.cancel_requested', subjectType: 'run', subjectId: runId });
      return ok({ status: 'cancelling' });
    }

    return fail(ERROR_CODES.RUN_NOT_CANCELLABLE, { rejection: `already_${row.status}` });
  },

  /**
   * Retry a failed run as a NEW run, linked to the original.
   *
   * A new row rather than a reset: rewriting the original would destroy the record of the
   * failure, which is exactly the thing worth keeping.
   */
  async retry(actor: Actor, runId: string): Promise<ServiceResult<{ run_id: string }>> {
    const row = await queryOne<{
      owner_id: string;
      status: RunStatus;
      task_id: string;
      task_version_id: string;
      vars: Record<string, unknown>;
      root_run_id: string | null;
    }>(
      `SELECT t.owner_id, r.status, r.task_id, r.task_version_id, r.vars, r.root_run_id
       FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.id = $1`,
      [runId],
    );

    if (row === null) return failures.notFound('run');
    if (!canAccessOwned(actor, row.owner_id)) return failures.forbidden('not_run_owner');

    if (row.status === 'queued' || row.status === 'running') {
      return fail(ERROR_CODES.INVALID_STATE_TRANSITION, { rejection: 'run_still_active' });
    }

    // Pins the SAME task version the original ran, so a retry reproduces the original attempt
    // rather than silently running a newer definition.
    const retryRun = await queue.enqueue({
      taskId: row.task_id,
      taskVersionId: row.task_version_id,
      trigger: 'retry',
      createdBy: actor.id,
      vars: row.vars,
      parentRunId: runId,
      rootRunId: row.root_run_id ?? runId,
    });

    await auditRepo.record({
      action: 'run.retried',
      subjectType: 'run',
      subjectId: retryRun.id,
      after: { retry_of: runId },
    });

    return ok({ run_id: retryRun.id });
  },
};
