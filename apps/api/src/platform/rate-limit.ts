import { ERROR_CODES } from '@klankish/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { env } from './env.js';
import { AppError } from './result.js';

/**
 * Token-bucket rate limiting.
 *
 * Token bucket, NOT fixed window. A fixed window lets a client spend its whole allowance at
 * 11:59:59 and the next window's at 12:00:00 — a 2x burst straight through the limit at exactly
 * the moment a retry storm would produce one. A bucket that refills continuously has no such edge.
 *
 * In-process for now, which is correct for a single replica and stated as a limitation rather
 * than hidden: with N replicas each holds its own bucket, so the effective limit is N times the
 * configured one. Redis is the fix when that matters (see docs/tech-spec.md §1) and the interface
 * here does not change when it arrives.
 */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

/** Bound the map so a flood of unique IPs cannot grow it without limit. */
const MAX_BUCKETS = 50_000;

function take(key: string, capacity: number, refillPerMs: number, now: number): boolean {
  let bucket = buckets.get(key);

  if (bucket === undefined) {
    if (buckets.size >= MAX_BUCKETS) {
      // Evict the oldest-touched entries. Crude, but this is a safety valve, not an LRU cache,
      // and the alternative is an unbounded map keyed by attacker-controlled input.
      const cutoff = now - 60_000;
      for (const [k, b] of buckets) {
        if (b.lastRefillMs < cutoff) buckets.delete(k);
        if (buckets.size < MAX_BUCKETS * 0.9) break;
      }
    }
    bucket = { tokens: capacity, lastRefillMs: now };
    buckets.set(key, bucket);
  }

  // Continuous refill: tokens accrue in proportion to elapsed time, capped at capacity.
  const elapsed = now - bucket.lastRefillMs;
  if (elapsed > 0) {
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefillMs = now;
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function retryAfterSeconds(key: string, refillPerMs: number): number {
  const bucket = buckets.get(key);
  if (bucket === undefined) return 1;
  const needed = 1 - bucket.tokens;
  return Math.max(1, Math.ceil(needed / refillPerMs / 1000));
}

export interface RateLimitOptions {
  /** Requests per minute for an anonymous caller, keyed by IP. */
  readonly anonPerMin?: number;
  /** Requests per minute for an authenticated caller, keyed by user id. */
  readonly userPerMin?: number;
  /** A distinct bucket namespace, so a strict login limit does not consume a general allowance. */
  readonly scope?: string;
}

/**
 * Build a rate-limit hook.
 *
 * Registered BEFORE the route handler and, where both apply, before auth is not possible — an
 * authenticated limit needs the actor. So this runs after requireAuth when a route has one, and
 * falls back to the IP bucket otherwise. That ordering is stated at each route.
 */
export function rateLimit(opts: RateLimitOptions = {}) {
  const anonPerMin = opts.anonPerMin ?? env.RATE_LIMIT_ANON_PER_MIN;
  const userPerMin = opts.userPerMin ?? env.RATE_LIMIT_USER_PER_MIN;
  const scope = opts.scope ?? 'default';

  return async function rateLimitHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const actor = request.actor;

    const isAdmin = actor !== undefined && actor.role !== 'user';
    const capacity = actor === undefined
      ? anonPerMin
      : isAdmin
        ? Math.max(userPerMin, env.RATE_LIMIT_ADMIN_PER_MIN)
        : userPerMin;

    const key =
      actor === undefined
        ? `${scope}:ip:${request.ip}`
        : `${scope}:user:${actor.id}`;

    const refillPerMs = capacity / 60_000;
    const now = Date.now();

    if (!take(key, capacity, refillPerMs, now)) {
      const retryAfter = retryAfterSeconds(key, refillPerMs);
      // A real Retry-After, not "try again later". A client that cannot compute a backoff will
      // simply hammer the endpoint.
      void reply.header('Retry-After', String(retryAfter));
      throw new AppError(ERROR_CODES.RATE_LIMITED, {
        retryAfter,
        rejection: `limit_${capacity}_per_min`,
      });
    }
  };
}

/**
 * A deliberately strict limiter for credential endpoints.
 *
 * 10/min per IP: generous for a person who mistypes a password, useless for credential stuffing.
 */
export const authRateLimit = rateLimit({ anonPerMin: 10, userPerMin: 20, scope: 'auth' });

/** Test helper. Buckets are process-global, so tests must be able to reset them. */
export function resetRateLimits(): void {
  buckets.clear();
}
