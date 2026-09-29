import type { RetryPolicy } from './graph.js';

/**
 * Retry delay computation.
 *
 * The jitter variant here is FULL jitter: `random(0, capped_delay)`, not `capped_delay ± small%`.
 *
 * That distinction is the whole point. Without full jitter, N steps that failed together retry
 * together forever — they stay synchronised, and the retry storm that knocked the upstream over
 * repeats at every interval. Full jitter spreads them across the entire window on the first retry.
 * The cost is that an individual retry may come back very quickly; the benefit is that the herd
 * disperses. For a system whose job is hitting other people's APIs on a schedule, that trade is
 * clearly right.
 */

export interface BackoffInput {
  readonly policy: RetryPolicy;
  /** 1-based: attempt 1 has already failed when computing the delay before attempt 2. */
  readonly attempt: number;
  /** Injectable for deterministic tests. */
  readonly random?: () => number;
}

export function computeBackoffMs({ policy, attempt, random = Math.random }: BackoffInput): number {
  const n = Math.max(1, attempt);

  let raw: number;
  switch (policy.backoff) {
    case 'fixed':
      raw = policy.base_ms;
      break;
    case 'linear':
      raw = policy.base_ms * n;
      break;
    case 'exponential':
      // 2^30 guards against overflow on an absurd attempt count.
      raw = policy.base_ms * Math.pow(2, Math.min(n - 1, 30));
      break;
    default: {
      const never: never = policy.backoff;
      void never;
      raw = policy.base_ms;
    }
  }

  const capped = Math.min(raw, policy.max_ms);
  if (!policy.jitter) return Math.max(0, Math.round(capped));

  return Math.max(0, Math.round(random() * capped));
}

/**
 * Whether a failed step should be retried.
 *
 * Two independent gates, and both must pass:
 *
 *   1. Attempts remain.
 *   2. The failure is the RETRYABLE kind — and, when the outcome is ambiguous (a timeout on a
 *      request that may have been received), the step must be idempotent. Retrying a
 *      non-idempotent POST that actually succeeded is how a system sends two emails or charges
 *      twice, and it is invisible in the record because the first attempt looks like a failure.
 */
export interface RetryDecisionInput {
  readonly policy: RetryPolicy;
  readonly attempt: number;
  readonly idempotent: boolean;
  readonly failure: FailureKind;
}

export type FailureKind =
  /** Connection refused, DNS failure, socket hang-up — the request provably did not complete. */
  | 'network'
  /** Timed out. The upstream MAY have processed it: ambiguous. */
  | 'timeout'
  /** 5xx. Usually safe to retry, but the write may still have landed. */
  | 'server'
  /** 429 or 503 with Retry-After — explicitly asked to come back. */
  | 'throttled'
  /** 4xx other than 408/429. Retrying will fail identically. */
  | 'client'
  /** Assertion failed, validation failed, expression error — deterministic. */
  | 'deterministic';

export function shouldRetry({
  policy,
  attempt,
  idempotent,
  failure,
}: RetryDecisionInput): boolean {
  if (attempt >= policy.max_attempts) return false;

  switch (failure) {
    case 'client':
    case 'deterministic':
      // Identical input would produce an identical failure. Retrying only wastes time.
      return false;

    case 'network':
      // The request never landed, so replaying it is safe even for a non-idempotent step.
      return true;

    case 'throttled':
      return true;

    case 'timeout':
    case 'server':
      // Ambiguous: the write may have succeeded. Only replay when the step says that is safe.
      return idempotent;

    default: {
      const never: never = failure;
      void never;
      return false;
    }
  }
}

/**
 * Honour an upstream `Retry-After` header when it is longer than our computed delay.
 *
 * Taking the max, rather than replacing, means a server asking for 60s gets 60s, while a server
 * asking for 1s does not shorten our own backoff into a hot loop.
 */
export function applyRetryAfter(computedMs: number, retryAfterSeconds: number | null): number {
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds)) return computedMs;
  const askedMs = Math.max(0, retryAfterSeconds) * 1000;
  // One hour ceiling: a misconfigured upstream should not park a run for a day.
  return Math.min(Math.max(computedMs, askedMs), 3_600_000);
}

/** Parse `Retry-After`, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (header === null || header === undefined || header.trim() === '') return null;

  const seconds = Number.parseInt(header.trim(), 10);
  if (Number.isInteger(seconds) && seconds >= 0 && String(seconds) === header.trim()) {
    return seconds;
  }

  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.round((date - now) / 1000));

  return null;
}
