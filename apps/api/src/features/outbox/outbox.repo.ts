import { newId } from '@klankish/shared';
import type { PoolClient } from 'pg';

import { query, txQuery } from '../../db/client.js';

/**
 * The transactional outbox.
 *
 * A side effect (email, webhook) is written in the SAME transaction as the state change that
 * caused it, and delivered later by a worker. Sending inline instead means the email goes out for
 * a transaction that then rolls back — the user gets "your password was reset" for a reset that
 * did not happen.
 *
 * Delivery is at-least-once, so every handler must be idempotent.
 */

export interface OutboxRow {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  available_at: string;
  attempts: number;
  locked_by: string | null;
  locked_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}

export const outboxRepo = {
  /** Pass `client` to enlist in a caller's transaction — which is the whole point of an outbox. */
  async enqueue(
    topic: string,
    payload: Record<string, unknown>,
    opts: { availableAt?: string } = {},
    client?: PoolClient,
  ): Promise<string> {
    const id = newId('outbox');
    const sql = `
      INSERT INTO outbox (id, topic, payload, available_at)
      VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()))`;
    const params = [id, topic, JSON.stringify(payload), opts.availableAt ?? null];

    if (client === undefined) {
      await query(sql, params);
    } else {
      await txQuery(client, sql, params);
    }
    return id;
  },

  /**
   * Claim a batch for delivery.
   *
   * Same `FOR UPDATE SKIP LOCKED` mechanism as the run queue: two delivery workers polling at
   * once take different rows instead of both taking the same one and sending twice.
   */
  async claimBatch(workerId: string, limit: number, leaseMs: number): Promise<OutboxRow[]> {
    return query<OutboxRow>(
      `UPDATE outbox o
       SET locked_by = $1, locked_at = now()
       WHERE o.id IN (
         SELECT id FROM outbox
         WHERE delivered_at IS NULL
           AND available_at <= now()
           AND (locked_at IS NULL OR locked_at < now() - ($3 || ' milliseconds')::interval)
         ORDER BY available_at
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       RETURNING id, topic, payload, available_at, attempts,
                 locked_by, locked_at, delivered_at, last_error, created_at`,
      [workerId, limit, String(leaseMs)],
    );
  },

  async markDelivered(id: string): Promise<void> {
    await query('UPDATE outbox SET delivered_at = now(), locked_by = NULL WHERE id = $1', [id]);
  },

  /** Record a failure and schedule the next attempt. */
  async markFailed(id: string, error: string, retryInMs: number): Promise<void> {
    await query(
      `UPDATE outbox
       SET attempts = attempts + 1,
           last_error = $2,
           locked_by = NULL,
           locked_at = NULL,
           available_at = now() + ($3 || ' milliseconds')::interval
       WHERE id = $1`,
      [id, error.slice(0, 1000), String(retryInMs)],
    );
  },

  async pendingCount(): Promise<number> {
    const rows = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM outbox WHERE delivered_at IS NULL',
    );
    return Number(rows[0]?.n ?? '0');
  },
};
