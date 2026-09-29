import { MESSAGE_KEYS, resolveMessage } from '@klankish/shared';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../../platform/auth-hooks.js';
import { rateLimit } from '../../platform/rate-limit.js';
import { ResponseUtil } from '../../platform/response.js';
import { bail } from '../../platform/result.js';
import { secretsService } from './secrets.service.js';

/**
 * Secret routes.
 *
 * Note what is absent: there is no GET that returns a value. Not for an admin, not for the owner.
 * `SecretView` has no value field, so a plaintext cannot leak through a careless serialiser — the
 * type has nowhere to put it.
 */
export function register(app: FastifyInstance): void {
  const auth = [requireAuth, rateLimit({ scope: 'secrets' })];

  app.get(
    '/api/v1/secrets',
    { preHandler: auth, schema: { tags: ['secrets'] } },
    async (request, reply) => {
      const result = await secretsService.list(request.actor!.id);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.post(
    '/api/v1/secrets',
    {
      preHandler: auth,
      schema: {
        tags: ['secrets'],
        body: Type.Object(
          {
            // The charset matches what the expression lexer accepts as an identifier, so a stored
            // secret is always referenceable as {{ secrets.NAME }}.
            name: Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }),
            value: Type.String({ minLength: 1, maxLength: 10_000 }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const result = await secretsService.create(request.actor!.id, request.body as never);
      if (!result.success) bail(result);
      ResponseUtil.created(reply, {
        ...result.data,
        message: resolveMessage(MESSAGE_KEYS.secrets.CREATED),
      });
    },
  );

  app.put(
    '/api/v1/secrets/:id',
    {
      preHandler: auth,
      schema: {
        tags: ['secrets'],
        params: Type.Object({ id: Type.String({ maxLength: 64 }) }),
        body: Type.Object(
          { value: Type.String({ minLength: 1, maxLength: 10_000 }) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { value } = request.body as { value: string };
      const result = await secretsService.update(request.actor!.id, id, value);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, {
        ...result.data,
        message: resolveMessage(MESSAGE_KEYS.secrets.UPDATED),
      });
    },
  );

  app.delete(
    '/api/v1/secrets/:id',
    {
      preHandler: auth,
      schema: { tags: ['secrets'], params: Type.Object({ id: Type.String({ maxLength: 64 }) }) },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await secretsService.remove(request.actor!.id, id);
      if (!result.success) bail(result);
      ResponseUtil.noContent(reply);
    },
  );
}
