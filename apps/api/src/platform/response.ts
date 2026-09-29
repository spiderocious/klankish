import type { PaginationMeta } from '@klankish/shared';
import type { FastifyReply } from 'fastify';

import { getRequestId } from './context.js';

/**
 * ResponseUtil — the ONE place a response body is constructed.
 *
 * `reply.send()` in a handler is a review failure. Not stylistic pedantry: this is the only place
 * whole-body concerns can be handled without remembering at every callsite. Right now that means
 * bigint serialisation and the request id; when the next such concern appears, it lands here
 * instead of in two hundred handlers.
 */

/**
 * JSON.stringify throws outright on a bigint. There is no money in this product, but byte counts
 * and duration sums can exceed 2^53, and the rule "serialise bigint centrally, never at 240
 * callsites" holds regardless of what the bigint represents.
 *
 * Inside the safe-integer range a bigint becomes a JSON number; beyond it, a string — because a
 * number that large would silently lose precision the moment a browser parsed it.
 */
function serialiseBigints(value: unknown, depth = 0): unknown {
  if (depth > 64) return '[TRUNCATED]';

  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }

  if (Array.isArray(value)) return value.map((v) => serialiseBigints(v, depth + 1));

  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serialiseBigints(v, depth + 1);
    }
    return out;
  }

  return value;
}

/** True when the body contains a bigint anywhere — so the walk is skipped when it is not needed. */
function hasBigint(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'bigint') return true;
  if (Array.isArray(value)) return value.some((v) => hasBigint(v, depth + 1));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (hasBigint(v, depth + 1)) return true;
    }
  }
  return false;
}

function prepare(data: unknown): unknown {
  return hasBigint(data) ? serialiseBigints(data) : data;
}

export const ResponseUtil = {
  ok<T>(reply: FastifyReply, data: T, meta?: PaginationMeta | Record<string, unknown>): void {
    void reply.code(200).send({
      data: prepare(data),
      ...(meta !== undefined && { meta: prepare(meta) }),
      request_id: getRequestId(),
    });
  },

  created<T>(reply: FastifyReply, data: T): void {
    void reply.code(201).send({ data: prepare(data), request_id: getRequestId() });
  },

  /**
   * 202 means QUEUED, not done. The client must show "processing", never "success" — the real
   * outcome arrives later via SSE or a poll.
   */
  accepted<T>(reply: FastifyReply, data?: T): void {
    void reply.code(202).send({
      ...(data !== undefined && { data: prepare(data) }),
      request_id: getRequestId(),
    });
  },

  /** 204 has NO body. Calling .json() on one throws in the browser, so send nothing at all. */
  noContent(reply: FastifyReply): void {
    void reply.code(204).send();
  },

  /** A cursor-paginated list. The wire names here are contract — see shared/cursor.ts. */
  page<T>(
    reply: FastifyReply,
    items: readonly T[],
    meta: { next_cursor: string | null; has_more: boolean },
  ): void {
    void reply.code(200).send({
      data: prepare(items),
      meta: { next_cursor: meta.next_cursor, has_more: meta.has_more },
      request_id: getRequestId(),
    });
  },
} as const;
