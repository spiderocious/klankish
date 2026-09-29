import { newId, redact, type Role } from '@klankish/shared';
import type { PoolClient } from 'pg';

import { query, txQuery } from '../../db/client.js';
import { getContext } from '../../platform/context.js';
import { logger } from '../../platform/logger.js';

/**
 * The audit log.
 *
 * Append-only, enforced by a database trigger rather than convention — an audit log that can be
 * edited is not an audit log.
 *
 * `record()` deliberately NEVER throws. A failure to write an audit entry must not roll back the
 * thing being audited: losing the log line is bad, losing the user's password change because the
 * log write failed is worse. Failures are logged at error level so they are still visible.
 */

export interface AuditInput {
  readonly actorId?: string | null;
  readonly actorRole?: Role | null;
  readonly action: string;
  readonly subjectType?: string | null;
  readonly subjectId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
}

export const auditRepo = {
  async record(input: AuditInput, client?: PoolClient): Promise<void> {
    const ctx = getContext();
    const params = [
      newId('audit'),
      input.actorId ?? ctx?.actor?.id ?? null,
      input.actorRole ?? ctx?.actor?.role ?? null,
      input.action,
      input.subjectType ?? null,
      input.subjectId ?? null,
      // Redacted before storage: an audit row is read by admins, and a `before`/`after` diff of a
      // secret or a password field would otherwise put plaintext in a table people browse.
      input.before === undefined ? null : JSON.stringify(redact(input.before)),
      input.after === undefined ? null : JSON.stringify(redact(input.after)),
      ctx?.ip ?? null,
      ctx?.user_agent ?? null,
    ];

    const sql = `
      INSERT INTO audit_log
        (id, actor_id, actor_role, action, subject_type, subject_id, before, after, ip, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

    try {
      if (client === undefined) {
        await query(sql, params);
      } else {
        await txQuery(client, sql, params);
      }
    } catch (err) {
      logger.error({ err, action: input.action }, 'failed to write audit entry');
    }
  },
};
