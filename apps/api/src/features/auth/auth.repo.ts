import type { Role, UserStatus } from '@klankish/shared';
import type { PoolClient } from 'pg';

import { query, queryOne, txQuery, txQueryOne } from '../../db/client.js';

/**
 * SQL only. No business logic, no HTTP concepts.
 *
 * Every column is named explicitly — `SELECT *` breaks the moment someone adds a column, and it
 * silently widens what a query returns.
 */

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: Role;
  status: UserStatus;
  timezone: string;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  user_agent: string | null;
  ip: string | null;
  expires_at: string;
  revoked_at: string | null;
  replaced_by_id: string | null;
  created_at: string;
}

const USER_COLUMNS = `
  id, email, password_hash, name, role, status, timezone,
  last_login_at, created_at, updated_at
`;

export const authRepo = {
  async findUserByEmail(email: string): Promise<UserRow | null> {
    return queryOne<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE email = $1 AND is_deleted = FALSE`,
      [email],
    );
  },

  async findUserById(id: string): Promise<UserRow | null> {
    return queryOne<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND is_deleted = FALSE`,
      [id],
    );
  },

  async countUsers(): Promise<number> {
    const row = await queryOne<{ n: string }>(
      'SELECT count(*)::text AS n FROM users WHERE is_deleted = FALSE',
    );
    return Number(row?.n ?? '0');
  },

  async createUser(input: {
    id: string;
    email: string;
    passwordHash: string;
    name: string;
    role: Role;
    timezone: string;
  }): Promise<UserRow> {
    const rows = await query<UserRow>(
      `INSERT INTO users (id, email, password_hash, name, role, timezone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${USER_COLUMNS}`,
      [input.id, input.email, input.passwordHash, input.name, input.role, input.timezone],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('insert returned no row');
    return row;
  },

  async touchLastLogin(userId: string): Promise<void> {
    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  },

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  },

  // --- sessions ---

  async createSession(
    input: {
      id: string;
      userId: string;
      refreshTokenHash: string;
      userAgent: string | null;
      ip: string | null;
      expiresAt: string;
    },
    client?: PoolClient,
  ): Promise<SessionRow> {
    const sql = `
      INSERT INTO sessions (id, user_id, refresh_token_hash, user_agent, ip, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, user_id, refresh_token_hash, user_agent, ip, expires_at,
                revoked_at, replaced_by_id, created_at`;
    const params = [
      input.id,
      input.userId,
      input.refreshTokenHash,
      input.userAgent,
      input.ip,
      input.expiresAt,
    ];
    const rows =
      client === undefined
        ? await query<SessionRow>(sql, params)
        : await txQuery<SessionRow>(client, sql, params);
    const row = rows[0];
    if (row === undefined) throw new Error('insert returned no row');
    return row;
  },

  async findSessionByTokenHash(hash: string, client?: PoolClient): Promise<SessionRow | null> {
    const sql = `
      SELECT id, user_id, refresh_token_hash, user_agent, ip, expires_at,
             revoked_at, replaced_by_id, created_at
      FROM sessions WHERE refresh_token_hash = $1`;
    return client === undefined
      ? queryOne<SessionRow>(sql, [hash])
      : txQueryOne<SessionRow>(client, sql, [hash]);
  },

  async listSessions(userId: string): Promise<SessionRow[]> {
    return query<SessionRow>(
      `SELECT id, user_id, refresh_token_hash, user_agent, ip, expires_at,
              revoked_at, replaced_by_id, created_at
       FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC`,
      [userId],
    );
  },

  async markSessionReplaced(
    sessionId: string,
    replacedById: string,
    client: PoolClient,
  ): Promise<void> {
    await txQuery(
      client,
      'UPDATE sessions SET revoked_at = now(), replaced_by_id = $2 WHERE id = $1',
      [sessionId, replacedById],
    );
  },

  async revokeSession(sessionId: string, userId: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `UPDATE sessions SET revoked_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id`,
      [sessionId, userId],
    );
    return rows.length;
  },

  /**
   * Revoke every session for a user.
   *
   * Used on password change, and on refresh-token reuse — where it is the whole point: a leaked
   * token must cost the attacker (and the user) every session, not just the one.
   */
  async revokeAllSessions(
    userId: string,
    opts: { exceptId?: string } = {},
    client?: PoolClient,
  ): Promise<number> {
    const sql =
      opts.exceptId === undefined
        ? `UPDATE sessions SET revoked_at = now()
           WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`
        : `UPDATE sessions SET revoked_at = now()
           WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2 RETURNING id`;
    const params = opts.exceptId === undefined ? [userId] : [userId, opts.exceptId];
    const rows =
      client === undefined
        ? await query<{ id: string }>(sql, params)
        : await txQuery<{ id: string }>(client, sql, params);
    return rows.length;
  },

  // --- password reset ---

  async createResetToken(input: {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<void> {
    await query(
      `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [input.id, input.userId, input.tokenHash, input.expiresAt],
    );
  },

  async findResetToken(
    tokenHash: string,
  ): Promise<{ id: string; user_id: string; expires_at: string; used_at: string | null } | null> {
    return queryOne(
      `SELECT id, user_id, expires_at, used_at
       FROM password_reset_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
  },

  async consumeResetToken(id: string, client: PoolClient): Promise<void> {
    await txQuery(client, 'UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [id]);
  },
};
