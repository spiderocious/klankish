import { MESSAGE_KEYS, resolveMessage } from '@klankish/shared';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';

import { requireAuth } from '../../platform/auth-hooks.js';
import { authRateLimit } from '../../platform/rate-limit.js';
import { ResponseUtil } from '../../platform/response.js';
import { bail } from '../../platform/result.js';
import { outboxRepo } from '../outbox/outbox.repo.js';
import { authService } from './auth.service.js';

/**
 * Auth routes.
 *
 * Controllers here are thin by design: validate (declaratively, via schema), call the service,
 * then either `bail` on failure or hand the data to `ResponseUtil`. They never interpret WHY
 * something failed — that is the service's job, and keeping it there is what stops error
 * rendering drifting across two hundred handlers.
 *
 * HOOK ORDER IS LOAD-BEARING and is stated at each route.
 */

const PASSWORD_MIN = 10;

const EmailSchema = Type.String({ format: 'email', maxLength: 254 });
const PasswordSchema = Type.String({ minLength: PASSWORD_MIN, maxLength: 200 });

const RegisterBody = Type.Object(
  {
    email: EmailSchema,
    password: PasswordSchema,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    timezone: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);

const LoginBody = Type.Object(
  {
    email: EmailSchema,
    // Deliberately NOT PasswordSchema: a length rule on login would reject a legacy password and
    // leak the current policy to anyone probing.
    password: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

const RefreshBody = Type.Object(
  { refresh_token: Type.String({ minLength: 1, maxLength: 500 }) },
  { additionalProperties: false },
);

export function register(app: FastifyInstance): void {
  // ---- public ----------------------------------------------------------
  // authRateLimit only (10/min per IP): these run before any actor exists, so the bucket is
  // keyed by IP.

  app.post(
    '/api/v1/auth/register',
    { preHandler: [authRateLimit], schema: { body: RegisterBody, tags: ['auth'] } },
    async (request, reply) => {
      const result = await authService.register(request.body as never);
      if (!result.success) bail(result);
      ResponseUtil.created(reply, {
        ...result.data,
        message: resolveMessage(MESSAGE_KEYS.auth.REGISTERED),
      });
    },
  );

  app.post(
    '/api/v1/auth/login',
    { preHandler: [authRateLimit], schema: { body: LoginBody, tags: ['auth'] } },
    async (request, reply) => {
      const result = await authService.login(request.body as never);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.post(
    '/api/v1/auth/refresh',
    { preHandler: [authRateLimit], schema: { body: RefreshBody, tags: ['auth'] } },
    async (request, reply) => {
      const { refresh_token } = request.body as { refresh_token: string };
      const result = await authService.refresh(refresh_token);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.post(
    '/api/v1/auth/logout',
    { preHandler: [authRateLimit], schema: { body: RefreshBody, tags: ['auth'] } },
    async (request, reply) => {
      const { refresh_token } = request.body as { refresh_token: string };
      await authService.logout(refresh_token);
      ResponseUtil.noContent(reply);
    },
  );

  app.post(
    '/api/v1/auth/password-reset/request',
    {
      preHandler: [authRateLimit],
      schema: { body: Type.Object({ email: EmailSchema }, { additionalProperties: false }) },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };
      const result = await authService.requestPasswordReset(email);
      if (!result.success) bail(result);

      // The token goes to the outbox, never to the response — returning it here would let anyone
      // reset any account. The always-success message is what prevents user enumeration.
      if (result.data.token !== undefined) {
        await outboxRepo.enqueue('email.password_reset', { email, token: result.data.token });
      }

      ResponseUtil.ok(reply, {
        message: resolveMessage(MESSAGE_KEYS.auth.PASSWORD_RESET_SENT),
      });
    },
  );

  app.post(
    '/api/v1/auth/password-reset/confirm',
    {
      preHandler: [authRateLimit],
      schema: {
        body: Type.Object(
          { token: Type.String({ minLength: 1, maxLength: 500 }), new_password: PasswordSchema },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const body = request.body as { token: string; new_password: string };
      const result = await authService.resetPassword({
        token: body.token,
        newPassword: body.new_password,
      });
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, { message: resolveMessage(MESSAGE_KEYS.auth.PASSWORD_RESET) });
    },
  );

  // ---- authenticated ---------------------------------------------------
  // ORDER: requireAuth first so the actor exists, then the rate limiter keys by user id rather
  // than by IP. Swapping them would bucket every authenticated user under their shared egress IP.

  app.get(
    '/api/v1/auth/me',
    { preHandler: [requireAuth], schema: { tags: ['auth'] } },
    async (request, reply) => {
      const result = await authService.me(request.actor!.id);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.patch(
    '/api/v1/auth/me',
    {
      preHandler: [requireAuth],
      schema: {
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            timezone: Type.Optional(Type.String({ maxLength: 64 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const result = await authService.updateProfile(request.actor!.id, request.body as never);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.post(
    '/api/v1/auth/change-password',
    {
      preHandler: [requireAuth],
      schema: {
        body: Type.Object(
          {
            current_password: Type.String({ minLength: 1, maxLength: 200 }),
            new_password: PasswordSchema,
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const body = request.body as { current_password: string; new_password: string };
      const result = await authService.changePassword(
        request.actor!.id,
        { currentPassword: body.current_password, newPassword: body.new_password },
        request.sessionId,
      );
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, {
        ...result.data,
        message: resolveMessage(MESSAGE_KEYS.auth.PASSWORD_CHANGED),
      });
    },
  );

  // NOTE: `/sessions` is registered before `/sessions/:id` so the literal path is not swallowed
  // by the parameterised one. Fastify's radix router actually handles this correctly regardless,
  // but the ordering is kept explicit because it is the convention everywhere else in this
  // codebase and relying on a router detail is how the rule quietly erodes.
  app.get(
    '/api/v1/auth/sessions',
    { preHandler: [requireAuth], schema: { tags: ['auth'] } },
    async (request, reply) => {
      const result = await authService.listSessions(request.actor!.id, request.sessionId);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, result.data);
    },
  );

  app.delete(
    '/api/v1/auth/sessions/:id',
    {
      preHandler: [requireAuth],
      schema: { params: Type.Object({ id: Type.String({ maxLength: 64 }) }) },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await authService.revokeSession(request.actor!.id, id);
      if (!result.success) bail(result);
      ResponseUtil.noContent(reply);
    },
  );

  app.post(
    '/api/v1/auth/logout-all',
    { preHandler: [requireAuth], schema: { tags: ['auth'] } },
    async (request, reply) => {
      const result = await authService.logoutAll(request.actor!.id);
      if (!result.success) bail(result);
      ResponseUtil.ok(reply, {
        ...result.data,
        message: resolveMessage(MESSAGE_KEYS.auth.SESSIONS_REVOKED),
      });
    },
  );
}
