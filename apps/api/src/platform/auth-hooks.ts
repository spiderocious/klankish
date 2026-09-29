import { ERROR_CODES, atLeast, type Actor, type Role } from '@klankish/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { query } from '../db/client.js';
import { hashToken, verifyAccessToken } from './crypto.js';
import { AppError } from './result.js';

/**
 * Authentication and authorization hooks.
 *
 * Fastify's `preHandler` replaces Express middleware here. The DOCTRINE is unchanged — hook order
 * is load-bearing and stated at every route — but the mechanism is the framework's own, rather
 * than an Express shim bolted on top.
 *
 * Auth populates `request.actor`; the request context (seeded in app.ts) then carries it to
 * services, which never see the request object.
 */

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    sessionId?: string;
  }
}

interface UserAuthRow {
  id: string;
  role: Role;
  status: 'active' | 'suspended' | 'invited';
}

function bearerFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || value === '') return null;
  return value;
}

/**
 * Resolve the actor from a JWT or an API key.
 *
 * The user row is re-read on every request rather than trusted from the token. That costs one
 * indexed lookup and buys correctness: a suspended user must lose access immediately, not in up
 * to 15 minutes when their access token happens to expire.
 */
async function resolveActor(
  request: FastifyRequest,
): Promise<{ actor: Actor; sessionId?: string } | null> {
  const token = bearerFrom(request);
  if (token === null) return null;

  // API keys are distinguishable by prefix, so there is no ambiguity about which path to take.
  if (token.startsWith('klk_')) {
    const rows = await query<UserAuthRow & { key_id: string }>(
      `SELECT u.id, u.role, u.status, k.id AS key_id
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = $1
         AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > now())
         AND u.is_deleted = FALSE`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (row === undefined) return null;

    // Fire-and-forget: last_used_at is for the UI, and blocking the request on it would add a
    // write to every single API call.
    void query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.key_id]).catch(
      () => undefined,
    );

    return { actor: { id: row.id, role: row.role, status: row.status } };
  }

  const claims = await verifyAccessToken(token);
  if (claims === null) return null;

  const rows = await query<UserAuthRow>(
    `SELECT u.id, u.role, u.status
     FROM users u
     JOIN sessions s ON s.id = $2 AND s.user_id = u.id
     WHERE u.id = $1
       AND u.is_deleted = FALSE
       AND s.revoked_at IS NULL
       AND s.expires_at > now()`,
    [claims.sub, claims.sid],
  );
  const row = rows[0];
  // No row means the session was revoked (logout, password change, reuse detection). The access
  // token may still be cryptographically valid — that is exactly the case this join catches.
  if (row === undefined) return null;

  return { actor: { id: row.id, role: row.role, status: row.status }, sessionId: claims.sid };
}

/** Require a signed-in actor. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const resolved = await resolveActor(request);

  if (resolved === null) {
    throw new AppError(ERROR_CODES.UNAUTHENTICATED, { rejection: 'no_valid_credentials' });
  }
  if (resolved.actor.status === 'suspended') {
    throw new AppError(ERROR_CODES.ACCOUNT_SUSPENDED, { rejection: 'suspended' });
  }

  request.actor = resolved.actor;
  if (resolved.sessionId !== undefined) request.sessionId = resolved.sessionId;
}

/** Populate the actor when present, but allow anonymous through. */
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const resolved = await resolveActor(request);
  if (resolved !== null && resolved.actor.status === 'active') {
    request.actor = resolved.actor;
    if (resolved.sessionId !== undefined) request.sessionId = resolved.sessionId;
  }
}

/**
 * Require a minimum role. Always registered AFTER requireAuth — the order is load-bearing, and
 * this throws rather than silently passing if it is not.
 */
export function requireRole(minimum: Role) {
  return async function roleHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const actor = request.actor;
    if (actor === undefined) {
      throw new Error(
        'requireRole() ran without an actor — requireAuth must be registered before it.',
      );
    }
    if (!atLeast(actor.role, minimum)) {
      throw new AppError(ERROR_CODES.INSUFFICIENT_ROLE, {
        rejection: `needs_${minimum}`,
      });
    }
  };
}

export const requireAdmin = requireRole('admin');
export const requireSuperAdmin = requireRole('super_admin');
