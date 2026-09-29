import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';

import { env } from '../platform/env.js';
import { logger } from '../platform/logger.js';

/**
 * The Postgres pool and query helpers.
 *
 * Deliberately thin — no ORM, no query builder. The queue's `FOR UPDATE SKIP LOCKED` claim is the
 * single most important query in this system, and it should be readable as SQL rather than
 * assembled by an abstraction that may or may not preserve its semantics.
 */

// node-postgres returns BIGINT (OID 20) as a string to avoid silent precision loss. Every bigint
// column here (interval_ms, bytes) is comfortably inside Number.MAX_SAFE_INTEGER, and having them
// arrive as numbers avoids a parseInt at every callsite. Revisit if a genuinely large column
// appears.
types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));

// Keep TIMESTAMPTZ (1184) and DATE as strings rather than JS Dates. The API serialises ISO 8601
// everywhere, and Date round-tripping through a local timezone is a classic source of off-by-an-
// hour bugs. Postgres already hands back an ISO-compatible string.
types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
types.setTypeParser(1114, (v: string) => new Date(`${v}Z`).toISOString());

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: `klankish-${env.PROCESS_ROLE}`,
});

pool.on('error', (err) => {
  // An idle client erroring is usually the DB restarting. The pool recovers; log rather than crash.
  logger.error({ err }, 'postgres idle client error');
});

export interface QueryOptions {
  /** Log a warning when a query takes longer than this. */
  readonly slowMs?: number;
}

/**
 * Run a query. Always parameterised — string interpolation into SQL is never acceptable, and
 * there is no helper here that would permit it.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
  opts: QueryOptions = {},
): Promise<T[]> {
  const started = Date.now();
  try {
    const res = await pool.query<T>(text, params as unknown[]);
    const elapsed = Date.now() - started;
    if (elapsed > (opts.slowMs ?? 1000)) {
      logger.warn({ elapsed_ms: elapsed, sql: firstLine(text) }, 'slow query');
    }
    return res.rows;
  } catch (err) {
    logger.error({ err, sql: firstLine(text) }, 'query failed');
    throw err;
  }
}

/** A query expected to return at most one row. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run a function inside a transaction, committing on return and rolling back on throw.
 *
 * Note the rethrow after ROLLBACK: that is control flow, not a violation of "services never
 * throw". The alternative — swallowing it — leaves the caller believing a rolled-back write
 * succeeded, which is strictly worse.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // A failed rollback means the connection is broken. Log it, but surface the ORIGINAL error:
      // that is the one that explains what went wrong.
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Query helper bound to an existing transaction client. */
export async function txQuery<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const res = await client.query<T>(text, params as unknown[]);
  return res.rows;
}

export async function txQueryOne<T extends QueryResultRow = QueryResultRow>(
  client: PoolClient,
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await txQuery<T>(client, text, params);
  return rows[0] ?? null;
}

/**
 * Postgres `now()`, not the app clock.
 *
 * Everything that gates claiming reads time from the database. With multiple replicas, two app
 * clocks will disagree by some milliseconds, and a lease comparison that straddles that gap is a
 * double-execution bug that only appears under load.
 */
export async function dbNow(): Promise<string> {
  const row = await queryOne<{ now: string }>('SELECT now() AS now');
  return row?.now ?? new Date().toISOString();
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0]?.slice(0, 160) ?? '';
}

/** Postgres error codes worth branching on. */
export const PG_ERRORS = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
} as const;

export function isPgError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === code
  );
}

/** The constraint name from a Postgres error, for mapping to a specific error identity. */
export function pgConstraint(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'constraint' in err) {
    const c = (err as { constraint?: unknown }).constraint;
    return typeof c === 'string' ? c : null;
  }
  return null;
}
