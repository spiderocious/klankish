import {
  buildPage,
  canAccessOwned,
  canMutateOwned,
  ERROR_CODES,
  isValidTimezone,
  newId,
  parseCron,
  validateGraph,
  type Actor,
  type ConcurrencyPolicy,
  type ScheduleKind,
  type TaskDetailView,
  type TaskGraph,
  type TaskStatus,
  type TaskVersionView,
  type TaskView,
} from '@klankish/shared';

import { transaction } from '../../db/client.js';
import { env } from '../../platform/env.js';
import { fail, failures, ok, type ServiceResult } from '../../platform/result.js';
import { queue } from '../../engine/queue.js';
import { initialNextFire } from '../../engine/scheduler.js';
import { auditRepo } from '../audit/audit.repo.js';
import { schedulesRepo } from '../schedules/schedules.repo.js';
import { secretsService } from '../secrets/secrets.service.js';
import { tasksRepo, type TaskRow } from './tasks.repo.js';
import { toTaskDetailView, toTaskVersionView, toTaskView } from './tasks.view.js';

/**
 * Tasks.
 *
 * Two things here carry most of the weight:
 *
 *   1. VALIDATION AT SAVE TIME. A graph with a cycle, a dangling target, a broken expression or a
 *      reference to a nonexistent step is rejected while someone is looking at the screen — not at
 *      3am when the schedule fires and the only evidence is a failed run.
 *
 *   2. IMMUTABLE VERSIONING. Every edit writes a new version, and a run pins the version it
 *      executed. Without this, editing a task retroactively falsifies every historical run record.
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'task';
}

async function assertReadable(actor: Actor, task: TaskRow | null): Promise<ServiceResult<TaskRow>> {
  if (task === null) return failures.notFound('task');
  // 403, not 404, on a cross-user id: the caller is authenticated and ULIDs are unguessable, so
  // confirming existence leaks nothing, and a truthful 403 is far easier to debug.
  if (!canAccessOwned(actor, task.owner_id)) return failures.forbidden('not_task_owner');
  return ok(task);
}

async function assertWritable(actor: Actor, task: TaskRow | null): Promise<ServiceResult<TaskRow>> {
  if (task === null) return failures.notFound('task');
  if (!canMutateOwned(actor, task.owner_id)) return failures.forbidden('not_task_owner');
  return ok(task);
}

export interface CreateTaskInput {
  name: string;
  description?: string | null;
  graph: TaskGraph;
  tags?: string[];
  concurrency_policy?: ConcurrencyPolicy;
  max_concurrent_runs?: number;
  timeout_ms?: number | null;
  schedule?: {
    kind: ScheduleKind;
    cron_expr?: string | null;
    interval_ms?: number | null;
    run_at?: string | null;
    timezone?: string;
    jitter_ms?: number;
    enabled?: boolean;
  };
}

export const tasksService = {
  async list(
    actor: Actor,
    opts: {
      status?: TaskStatus;
      tag?: string;
      search?: string;
      cursor?: { last_id: string; last_sort_key: string };
      limit: number;
      allUsers?: boolean;
    },
  ): Promise<ServiceResult<{ items: TaskView[]; next_cursor: string | null; has_more: boolean }>> {
    // Only an admin may drop the owner filter, and only when they ask for it explicitly.
    const scopeToOwner = !(opts.allUsers === true && canAccessOwned(actor, 'any'));

    const rows = await tasksRepo.list({
      ...(scopeToOwner && { ownerId: actor.id }),
      ...(opts.status !== undefined && { status: opts.status }),
      ...(opts.tag !== undefined && { tag: opts.tag }),
      ...(opts.search !== undefined && { search: opts.search }),
      ...(opts.cursor !== undefined && { cursor: opts.cursor }),
      limit: opts.limit,
    });

    const page = buildPage(rows, opts.limit, (r) => ({
      last_id: r.id,
      last_sort_key: r.created_at,
    }));

    const ids = page.items.map((t) => t.id);
    const [schedules, stats] = await Promise.all([
      schedulesRepo.forTasks(ids),
      tasksRepo.statsFor(ids),
    ]);

    // Step counts come from the current version, fetched per task. N+1 is acceptable at a page of
    // 20 and keeps the query legible; revisit if the page size grows.
    const items = await Promise.all(
      page.items.map(async (row) => {
        const version = await tasksRepo.currentGraph(row.id);
        return toTaskView(row, {
          stepCount: version?.graph.steps.length ?? 0,
          currentVersion: version?.version ?? 0,
          schedule: schedules.get(row.id) ?? null,
          stats: stats.get(row.id) ?? null,
          appUrl: env.APP_URL,
        });
      }),
    );

    return ok({ items, next_cursor: page.next_cursor, has_more: page.has_more });
  },

  async get(actor: Actor, id: string): Promise<ServiceResult<TaskDetailView>> {
    const found = await assertReadable(actor, await tasksRepo.findById(id));
    if (!found.success) return found;

    const version = await tasksRepo.currentGraph(id);
    if (version === null) {
      return fail(ERROR_CODES.NOT_FOUND, { rejection: 'task_has_no_version' });
    }

    const [schedule, stats, consecutive] = await Promise.all([
      schedulesRepo.findByTask(id),
      tasksRepo.statsFor([id]),
      tasksRepo.consecutiveFailures(id),
    ]);

    const s = stats.get(id);
    return ok(
      toTaskDetailView(found.data, version, {
        stepCount: version.graph.steps.length,
        schedule,
        stats: s === undefined ? null : { ...s, consecutive_failures: consecutive },
        appUrl: env.APP_URL,
      }),
    );
  },

  async create(actor: Actor, input: CreateTaskInput): Promise<ServiceResult<TaskDetailView>> {
    const validation = await this.validateGraphFor(actor.id, input.graph);
    if (!validation.success) return validation;

    if (input.schedule !== undefined) {
      const scheduleCheck = validateScheduleInput(input.schedule);
      if (!scheduleCheck.success) return scheduleCheck;
    }

    const slug = slugify(input.name);
    if (await tasksRepo.slugExists(actor.id, slug)) {
      return fail(ERROR_CODES.NAME_TAKEN, {
        rejection: 'slug_exists',
        fieldErrors: { name: ['You already have a task with a similar name.'] },
      });
    }

    const taskId = newId('task');

    // Task, first version, current-version pointer and schedule all in ONE transaction: a task
    // with no version would be unrunnable, and a half-created one is worse than none.
    const result = await transaction(async (client) => {
      const task = await tasksRepo.create(
        {
          id: taskId,
          ownerId: actor.id,
          name: input.name.trim(),
          slug,
          description: input.description ?? null,
          concurrencyPolicy: input.concurrency_policy ?? 'skip',
          maxConcurrentRuns: input.max_concurrent_runs ?? 1,
          timeoutMs: input.timeout_ms ?? null,
          tags: input.tags ?? [],
        },
        client,
      );

      const version = await tasksRepo.createVersion(
        { id: newId('task_version'), taskId, graph: input.graph, note: 'Initial version', createdBy: actor.id },
        client,
      );

      await tasksRepo.setCurrentVersion(taskId, version.id, client);

      if (input.schedule !== undefined) {
        const tz = input.schedule.timezone ?? 'UTC';
        const next = initialNextFire(input.schedule.kind, {
          cronExpr: input.schedule.cron_expr ?? null,
          intervalMs: input.schedule.interval_ms ?? null,
          runAt: input.schedule.run_at ?? null,
          timezone: tz,
        });

        await schedulesRepo.upsert(
          {
            id: newId('schedule'),
            taskId,
            kind: input.schedule.kind,
            cronExpr: input.schedule.cron_expr ?? null,
            intervalMs: input.schedule.interval_ms ?? null,
            runAt: input.schedule.run_at ?? null,
            timezone: tz,
            enabled: input.schedule.enabled ?? true,
            jitterMs: input.schedule.jitter_ms ?? 0,
            nextFireAt: next?.toISOString() ?? null,
            webhookSecret: input.schedule.kind === 'webhook' ? newId('webhook') : null,
          },
          client,
        );
      }

      return { task, version };
    });

    await auditRepo.record({
      action: 'task.created',
      subjectType: 'task',
      subjectId: taskId,
      after: { name: input.name, steps: input.graph.steps.length },
    });

    const schedule = await schedulesRepo.findByTask(taskId);
    return ok(
      toTaskDetailView(result.task, result.version, {
        stepCount: input.graph.steps.length,
        schedule,
        stats: null,
        appUrl: env.APP_URL,
      }),
    );
  },

  /**
   * Update a task. A graph change writes a NEW VERSION rather than mutating the existing one.
   */
  async update(
    actor: Actor,
    id: string,
    input: {
      name?: string;
      description?: string | null;
      status?: TaskStatus;
      tags?: string[];
      concurrency_policy?: ConcurrencyPolicy;
      max_concurrent_runs?: number;
      timeout_ms?: number | null;
      graph?: TaskGraph;
      note?: string;
    },
  ): Promise<ServiceResult<TaskDetailView>> {
    const found = await assertWritable(actor, await tasksRepo.findById(id));
    if (!found.success) return found;

    if (input.graph !== undefined) {
      const validation = await this.validateGraphFor(found.data.owner_id, input.graph);
      if (!validation.success) return validation;
    }

    await transaction(async (client) => {
      // Lock the task so two concurrent saves cannot produce the same version number.
      await tasksRepo.lockTask(id, client);

      if (input.graph !== undefined) {
        const version = await tasksRepo.createVersion(
          {
            id: newId('task_version'),
            taskId: id,
            graph: input.graph,
            note: input.note ?? null,
            createdBy: actor.id,
          },
          client,
        );
        await tasksRepo.setCurrentVersion(id, version.id, client);
      }
    });

    const patch = {
      ...(input.name !== undefined && { name: input.name.trim() }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.tags !== undefined && { tags: input.tags }),
      ...(input.concurrency_policy !== undefined && {
        concurrencyPolicy: input.concurrency_policy,
      }),
      ...(input.max_concurrent_runs !== undefined && {
        maxConcurrentRuns: input.max_concurrent_runs,
      }),
      ...(input.timeout_ms !== undefined && { timeoutMs: input.timeout_ms }),
    };

    if (Object.keys(patch).length > 0) await tasksRepo.update(id, patch);

    await auditRepo.record({
      action: 'task.updated',
      subjectType: 'task',
      subjectId: id,
      after: { fields: Object.keys(input) },
    });

    return this.get(actor, id);
  },

  async setStatus(
    actor: Actor,
    id: string,
    status: TaskStatus,
  ): Promise<ServiceResult<TaskDetailView>> {
    const found = await assertWritable(actor, await tasksRepo.findById(id));
    if (!found.success) return found;

    await tasksRepo.update(id, { status });

    // Pausing a task must also stop its schedule firing, or runs keep being created and
    // immediately skipped — which fills the record with noise.
    const schedule = await schedulesRepo.findByTask(id);
    if (schedule !== null) {
      if (status === 'active' && !schedule.enabled) {
        const next = initialNextFire(schedule.kind, {
          cronExpr: schedule.cron_expr,
          intervalMs: schedule.interval_ms,
          runAt: schedule.run_at,
          timezone: schedule.timezone,
        });
        await schedulesRepo.setEnabled(id, true, next?.toISOString() ?? null);
      } else if (status !== 'active' && schedule.enabled) {
        await schedulesRepo.setEnabled(id, false, null);
      }
    }

    await auditRepo.record({
      action: `task.${status}`,
      subjectType: 'task',
      subjectId: id,
    });

    return this.get(actor, id);
  },

  async remove(actor: Actor, id: string): Promise<ServiceResult<null>> {
    const found = await assertWritable(actor, await tasksRepo.findById(id));
    if (!found.success) return found;

    await schedulesRepo.remove(id);
    await tasksRepo.softDelete(id);

    await auditRepo.record({
      action: 'task.deleted',
      subjectType: 'task',
      subjectId: id,
      before: { name: found.data.name },
    });

    return ok(null);
  },

  /** Queue a run immediately, bypassing the schedule and the concurrency policy. */
  async runNow(
    actor: Actor,
    id: string,
    vars?: Record<string, unknown>,
  ): Promise<ServiceResult<{ run_id: string; status: string }>> {
    const found = await assertReadable(actor, await tasksRepo.findById(id));
    if (!found.success) return found;

    if (found.data.status === 'archived') {
      return fail(ERROR_CODES.TASK_PAUSED, { rejection: 'task_archived' });
    }

    const version = await tasksRepo.currentGraph(id);
    if (version === null) {
      return fail(ERROR_CODES.NOT_FOUND, { rejection: 'task_has_no_version' });
    }

    const run = await queue.enqueue({
      taskId: id,
      taskVersionId: version.id,
      trigger: 'manual',
      createdBy: actor.id,
      ...(vars !== undefined && { vars }),
    });

    await auditRepo.record({
      action: 'task.run_now',
      subjectType: 'run',
      subjectId: run.id,
    });

    return ok({ run_id: run.id, status: run.status });
  },

  async listVersions(actor: Actor, id: string): Promise<ServiceResult<TaskVersionView[]>> {
    const found = await assertReadable(actor, await tasksRepo.findById(id));
    if (!found.success) return found;

    const rows = await tasksRepo.listVersions(id);
    return ok(rows.map((r) => toTaskVersionView(r)));
  },

  async getVersion(
    actor: Actor,
    id: string,
    versionId: string,
  ): Promise<ServiceResult<{ version: TaskVersionView; graph: TaskGraph }>> {
    const found = await assertReadable(actor, await tasksRepo.findById(id));
    if (!found.success) return found;

    const version = await tasksRepo.findVersion(versionId);
    if (version === null || version.task_id !== id) return failures.notFound('version');

    return ok({ version: toTaskVersionView(version), graph: version.graph });
  },

  /**
   * Restore an old version — as a NEW version, never by rewinding the pointer.
   *
   * Rewinding would make the history lie: it would look as though the intervening versions never
   * existed, and any run that pinned one would point at a version the task claims not to have.
   */
  async restoreVersion(
    actor: Actor,
    id: string,
    versionId: string,
  ): Promise<ServiceResult<TaskDetailView>> {
    const found = await assertWritable(actor, await tasksRepo.findById(id));
    if (!found.success) return found;

    const old = await tasksRepo.findVersion(versionId);
    if (old === null || old.task_id !== id) return failures.notFound('version');

    return this.update(actor, id, {
      graph: old.graph,
      note: `Restored from version ${old.version}`,
    });
  },

  async clone(actor: Actor, id: string): Promise<ServiceResult<TaskDetailView>> {
    const found = await assertReadable(actor, await tasksRepo.findById(id));
    if (!found.success) return found;

    const version = await tasksRepo.currentGraph(id);
    if (version === null) return failures.notFound('version');

    return this.create(actor, {
      name: `${found.data.name} (copy)`,
      description: found.data.description,
      graph: version.graph,
      tags: found.data.tags,
      concurrency_policy: found.data.concurrency_policy,
      max_concurrent_runs: found.data.max_concurrent_runs,
      timeout_ms: found.data.timeout_ms,
    });
  },

  /**
   * Validate a graph without saving. Powers the builder's live feedback.
   *
   * Passes the owner's secret names so a reference to a secret that does not exist is caught
   * here rather than at run time.
   */
  async validateGraphFor(
    ownerId: string,
    graph: TaskGraph,
  ): Promise<ServiceResult<{ warnings: string[] }>> {
    const knownSecrets = await secretsService.namesFor(ownerId);
    const result = validateGraph(graph, { knownSecrets });

    if (!result.ok) {
      // Field errors keyed by step so the builder can highlight the offending step rather than
      // showing one message at the top of the form.
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of result.errors) {
        const key = issue.step_key ?? issue.field ?? 'graph';
        (fieldErrors[key] ??= []).push(issue.message);
      }
      const first = result.errors[0];
      return fail(first?.code ?? ERROR_CODES.VALIDATION_ERROR, {
        fieldErrors,
        rejection: 'graph_invalid',
        message: first?.message ?? 'This task has a problem.',
      });
    }

    return ok({ warnings: result.warnings.map((w) => w.message) });
  },
};

function validateScheduleInput(schedule: NonNullable<CreateTaskInput['schedule']>): ServiceResult<null> {
  const tz = schedule.timezone ?? 'UTC';
  if (!isValidTimezone(tz)) {
    return failures.validation({ 'schedule.timezone': ['That is not a recognised timezone.'] });
  }

  switch (schedule.kind) {
    case 'cron': {
      if (schedule.cron_expr == null || schedule.cron_expr === '') {
        return failures.validation({ 'schedule.cron_expr': ['A schedule expression is required.'] });
      }
      const parsed = parseCron(schedule.cron_expr);
      if (!parsed.ok) {
        return fail(ERROR_CODES.INVALID_CRON, {
          fieldErrors: { 'schedule.cron_expr': [parsed.error ?? 'Not a valid schedule.'] },
        });
      }
      return ok(null);
    }
    case 'interval':
      if (schedule.interval_ms == null || schedule.interval_ms < 60_000) {
        return failures.validation({
          'schedule.interval_ms': ['An interval must be at least one minute.'],
        });
      }
      return ok(null);
    case 'once':
      if (schedule.run_at == null || Number.isNaN(new Date(schedule.run_at).getTime())) {
        return failures.validation({ 'schedule.run_at': ['A valid date and time is required.'] });
      }
      return ok(null);
    case 'manual':
    case 'webhook':
      return ok(null);
    default: {
      const never: never = schedule.kind;
      void never;
      return failures.validation({ 'schedule.kind': ['Unknown schedule type.'] });
    }
  }
}
