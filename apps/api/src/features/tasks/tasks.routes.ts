import {
  clampLimit,
  decodeCursor,
  isAdmin,
  MESSAGE_KEYS,
  resolveMessage,
  type TaskGraph,
} from '@klankish/shared';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../../platform/auth-hooks.js';
import { rateLimit } from '../../platform/rate-limit.js';
import { ResponseUtil } from '../../platform/response.js';
import { bail } from '../../platform/result.js';
import { tasksService } from './tasks.service.js';

/**
 * Task routes.
 *
 * HOOK ORDER: requireAuth first (so the actor exists), then rateLimit (so it keys by user id
 * rather than bucketing every authenticated user under one shared egress IP).
 *
 * ROUTE ORDER: literal paths before parameterised ones. Fastify's radix router resolves this
 * correctly on its own, but the ordering is kept explicit because it is the convention across this
 * codebase and relying on a router implementation detail is how the rule quietly erodes.
 */

const StepSchema = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 64 }),
    kind: Type.String({ minLength: 1, maxLength: 32 }),
  },
  // Steps are a discriminated union with a dozen shapes; validating them structurally here would
  // duplicate `validateGraph`, which does it properly AND checks cycles, targets and expressions.
  { additionalProperties: true },
);

const GraphSchema = Type.Object(
  {
    version: Type.Literal(1),
    entry: Type.String({ minLength: 1, maxLength: 64 }),
    steps: Type.Array(StepSchema, { maxItems: 200 }),
    defaults: Type.Optional(Type.Object({}, { additionalProperties: true })),
    vars: Type.Optional(Type.Object({}, { additionalProperties: true })),
  },
  { additionalProperties: false },
);

const ScheduleSchema = Type.Object(
  {
    kind: Type.Union([
      Type.Literal('cron'),
      Type.Literal('interval'),
      Type.Literal('once'),
      Type.Literal('manual'),
      Type.Literal('webhook'),
    ]),
    cron_expr: Type.Optional(Type.Union([Type.String({ maxLength: 120 }), Type.Null()])),
    interval_ms: Type.Optional(Type.Union([Type.Integer({ minimum: 60_000 }), Type.Null()])),
    run_at: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
    timezone: Type.Optional(Type.String({ maxLength: 64 })),
    jitter_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const CreateTaskBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    graph: GraphSchema,
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20 })),
    concurrency_policy: Type.Optional(
      Type.Union([Type.Literal('skip'), Type.Literal('queue'), Type.Literal('allow')]),
    ),
    max_concurrent_runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    timeout_ms: Type.Optional(Type.Union([Type.Integer({ minimum: 1000 }), Type.Null()])),
    schedule: Type.Optional(ScheduleSchema),
  },
  { additionalProperties: false },
);

const UpdateTaskBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    description: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
    status: Type.Optional(
      Type.Union([Type.Literal('active'), Type.Literal('paused'), Type.Literal('archived')]),
    ),
    tags: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 20 })),
    concurrency_policy: Type.Optional(
      Type.Union([Type.Literal('skip'), Type.Literal('queue'), Type.Literal('allow')]),
    ),
    max_concurrent_runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    timeout_ms: Type.Optional(Type.Union([Type.Integer({ minimum: 1000 }), Type.Null()])),
    graph: Type.Optional(GraphSchema),
    note: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: false },
);

const IdParam = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });

export function register(app: FastifyInstance): void {
  const auth = [requireAuth, rateLimit({ scope: 'tasks' })];

  // ---- collection ----
  app.get(
    '/api/v1/tasks',
    {
      preHandler: auth,
      schema: {
        tags: ['tasks'],
        querystring: Type.Object(
          {
            status: Type.Optional(Type.String({ maxLength: 20 })),
            tag: Type.Optional(Type.String({ maxLength: 40 })),
            search: Type.Optional(Type.String({ maxLength: 120 })),
            cursor: Type.Optional(Type.String({ maxLength: 500 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            all_users: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const q = request.query as {
        status?: string;
        tag?: string;
        search?: string;
        cursor?: string;
        limit?: number;
        all_users?: boolean;
      };
      const actor = request.actor!;

      const result = await tasksService.list(actor, {
        ...(q.status !== undefined && { status: q.status as never }),
        ...(q.tag !== undefined && { tag: q.tag }),
        ...(q.search !== undefined && { search: q.search }),
        // A bad cursor serves page one rather than 500ing — it is a hand-edited URL, not an outage.
        ...(q.cursor !== undefined &&
          decodeCursor(q.cursor) !== null && { cursor: decodeCursor(q.cursor)! }),
        limit: clampLimit(q.limit, isAdmin(actor.role)),
        ...(q.all_users !== undefined && { allUsers: q.all_users }),
      });

      if (!result.success) bail(result);
      ResponseUtil.page(reply, result.data.items, {
        next_cursor: result.data.next_cursor,
        has_more: result.data.has_more,
      });
    },
  );

  app.post(
    '/api/v1/tasks',
    { preHandler: auth, schema: { tags: ['tasks'], body: CreateTaskBody } },
    async (request, reply) => {
      const result = await tasksService.create(request.actor!, request.body as never);
      if (!result.success) bail(result);
      ResponseUtil.created(reply, result.data);
    },
  );

  // Registered BEFORE /tasks/:id so the literal path is not shadowed by the parameterised one.
  app.post(
    '/api/v1/tasks/validate',
    {
      preHandler: auth,
      schema: { tags: ['tasks'], body: Type.Object({ graph: GraphSchema }) },
    },
    async (request, reply) => {
      const { graph } = request.body as { graph: TaskGraph };
      const result = await tasksService.validateGraphFor(request.actor!.id, graph);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, { valid: true, warnings: result.data.warnings });
    },
  );

  // ---- item ----
  app.get(
    '/api/v1/tasks/:id',
    { preHandler: auth, schema: { tags: ['tasks'], params: IdParam } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await tasksService.get(request.actor!, id);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.patch(
    '/api/v1/tasks/:id',
    { preHandler: auth, schema: { tags: ['tasks'], params: IdParam, body: UpdateTaskBody } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await tasksService.update(request.actor!, id, request.body as never);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, { ...result.data, message: resolveMessage(MESSAGE_KEYS.tasks.UPDATED) });
    },
  );

  app.delete(
    '/api/v1/tasks/:id',
    { preHandler: auth, schema: { tags: ['tasks'], params: IdParam } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await tasksService.remove(request.actor!, id);
      if (!result.success) bail(result);
      ResponseUtil.noContent(reply);
    },
  );

  // ---- actions ----
  app.post(
    '/api/v1/tasks/:id/run',
    {
      preHandler: auth,
      schema: {
        tags: ['tasks'],
        params: IdParam,
        body: Type.Optional(
          Type.Object({ vars: Type.Optional(Type.Object({}, { additionalProperties: true })) }),
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { vars?: Record<string, unknown> };
      const result = await tasksService.runNow(
        request.actor!,
        id,
        ...(body.vars !== undefined ? ([body.vars] as const) : ([] as const)),
      );
      if (!result.success) bail(result);
      // 202: the run is QUEUED, not finished. The UI must show "queued", never "success".
      ResponseUtil.accepted(reply, {
        ...result.data,
        message: resolveMessage(MESSAGE_KEYS.tasks.RUN_QUEUED),
      });
    },
  );

  app.post(
    '/api/v1/tasks/:id/pause',
    { preHandler: auth, schema: { tags: ['tasks'], params: IdParam } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await tasksService.setStatus(request.actor!, id, 'paused');
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, { ...result.data, message: resolveMessage(MESSAGE_KEYS.tasks.PAUSED) });
    },
  );

  app.post(
    '/api/v1/tasks/:id/resume',
    { preHandler: auth, schema: { tags: ['tasks'], params: IdParam } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await tasksService.setStatus(request.actor!, id, 'active');
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, { ...result.data, message: resolveMessage(MESSAGE_KEYS.tasks.RESUMED) });
    },
  );

  app.post(
    '/api/v1/tasks/:id/clone',
    { preHandler: auth, schema: { tags: ['tasks'], params: IdParam } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await tasksService.clone(request.actor!, id);
      if (!result.success) bail(result);
      ResponseUtil.created(reply, { ...result.data, message: resolveMessage(MESSAGE_KEYS.tasks.CLONED) });
    },
  );

  // ---- versions ----
  app.get(
    '/api/v1/tasks/:id/versions',
    { preHandler: auth, schema: { tags: ['tasks'], params: IdParam } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await tasksService.listVersions(request.actor!, id);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.get(
    '/api/v1/tasks/:id/versions/:versionId',
    {
      preHandler: auth,
      schema: {
        tags: ['tasks'],
        params: Type.Object({
          id: Type.String({ maxLength: 64 }),
          versionId: Type.String({ maxLength: 64 }),
        }),
      },
    },
    async (request, reply) => {
      const { id, versionId } = request.params as { id: string; versionId: string };
      const result = await tasksService.getVersion(request.actor!, id, versionId);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.post(
    '/api/v1/tasks/:id/versions/:versionId/restore',
    {
      preHandler: auth,
      schema: {
        tags: ['tasks'],
        params: Type.Object({
          id: Type.String({ maxLength: 64 }),
          versionId: Type.String({ maxLength: 64 }),
        }),
      },
    },
    async (request, reply) => {
      const { id, versionId } = request.params as { id: string; versionId: string };
      const result = await tasksService.restoreVersion(request.actor!, id, versionId);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, {
        ...result.data,
        message: resolveMessage(MESSAGE_KEYS.tasks.VERSION_RESTORED),
      });
    },
  );
}
