import { clampLimit, decodeCursor, isAdmin, MESSAGE_KEYS, resolveMessage } from '@klankish/shared';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../../platform/auth-hooks.js';
import { rateLimit } from '../../platform/rate-limit.js';
import { ResponseUtil } from '../../platform/response.js';
import { bail } from '../../platform/result.js';
import { runsService } from './runs.service.js';

const IdParam = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });

export function register(app: FastifyInstance): void {
  const auth = [requireAuth, rateLimit({ scope: 'runs' })];

  app.get(
    '/api/v1/runs',
    {
      preHandler: auth,
      schema: {
        tags: ['runs'],
        querystring: Type.Object(
          {
            task_id: Type.Optional(Type.String({ maxLength: 64 })),
            status: Type.Optional(Type.String({ maxLength: 20 })),
            trigger: Type.Optional(Type.String({ maxLength: 20 })),
            since: Type.Optional(Type.String({ maxLength: 40 })),
            cursor: Type.Optional(Type.String({ maxLength: 500 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            all_users: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, string | number | boolean | undefined>;
      const actor = request.actor!;
      const cursor = typeof q['cursor'] === 'string' ? decodeCursor(q['cursor']) : null;

      const result = await runsService.list(actor, {
        ...(typeof q['task_id'] === 'string' && { taskId: q['task_id'] }),
        ...(typeof q['status'] === 'string' && { status: q['status'] as never }),
        ...(typeof q['trigger'] === 'string' && { trigger: q['trigger'] as never }),
        ...(typeof q['since'] === 'string' && { since: q['since'] }),
        ...(cursor !== null && { cursor }),
        limit: clampLimit(q['limit'], isAdmin(actor.role)),
        ...(q['all_users'] === true && { allUsers: true }),
      });

      if (!result.success) bail(result);
      ResponseUtil.page(reply, result.data.items, {
        next_cursor: result.data.next_cursor,
        has_more: result.data.has_more,
      });
    },
  );

  // The run inspector's endpoint — the most important read in the product.
  app.get(
    '/api/v1/runs/:id',
    { preHandler: auth, schema: { tags: ['runs'], params: IdParam } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await runsService.get(request.actor!, id);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.post(
    '/api/v1/runs/:id/cancel',
    { preHandler: auth, schema: { tags: ['runs'], params: IdParam } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await runsService.cancel(request.actor!, id);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, {
        ...result.data,
        message: resolveMessage(MESSAGE_KEYS.runs.CANCELLED),
      });
    },
  );

  app.post(
    '/api/v1/runs/:id/retry',
    { preHandler: auth, schema: { tags: ['runs'], params: IdParam } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await runsService.retry(request.actor!, id);
      if (!result.success) bail(result);
      // 202 — queued, not done.
      ResponseUtil.accepted(reply, {
        ...result.data,
        message: resolveMessage(MESSAGE_KEYS.runs.RETRIED),
      });
    },
  );
}
