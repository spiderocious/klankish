import {
  ERROR_CODES,
  isValidTimezone,
  newId,
  type Actor,
  type MeView,
  type Role,
  type SessionView,
} from '@klankish/shared';

import { transaction } from '../../db/client.js';
import { getContext } from '../../platform/context.js';
import {
  burnPasswordTime,
  generateRefreshToken,
  hashPassword,
  hashToken,
  randomToken,
  signAccessToken,
  verifyPassword,
} from '../../platform/crypto.js';
import { env } from '../../platform/env.js';
import { subLogger } from '../../platform/logger.js';
import { fail, failures, ok, type ServiceResult } from '../../platform/result.js';
import { auditRepo } from '../audit/audit.repo.js';
import { authRepo, type UserRow } from './auth.repo.js';
import { toMeView, toSessionView, toUserView } from './auth.view.js';

const log = subLogger('auth');

export interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly user: MeView;
}

function actorFrom(user: UserRow): Actor {
  return { id: user.id, role: user.role, status: user.status };
}

function futureIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export const authService = {
  /**
   * Register.
   *
   * The FIRST user becomes super_admin. On a self-hosted instance somebody has to hold the keys,
   * and requiring a manual database edit to bootstrap an admin is a worse experience than this,
   * which is visible and happens exactly once.
   */
  async register(input: {
    email: string;
    password: string;
    name: string;
    timezone?: string;
  }): Promise<ServiceResult<TokenPair>> {
    const email = input.email.trim().toLowerCase();
    const timezone = input.timezone ?? 'UTC';

    if (!isValidTimezone(timezone)) {
      return failures.validation({ timezone: ['That is not a recognised timezone.'] });
    }

    const existing = await authRepo.findUserByEmail(email);
    if (existing !== null) {
      return fail(ERROR_CODES.EMAIL_TAKEN, { rejection: 'email_already_registered' });
    }

    const isFirstUser = (await authRepo.countUsers()) === 0;
    const role: Role = isFirstUser ? 'super_admin' : 'user';

    const user = await authRepo.createUser({
      id: newId('user'),
      email,
      passwordHash: await hashPassword(input.password),
      name: input.name.trim(),
      role,
      timezone,
    });

    await auditRepo.record({
      actorId: user.id,
      actorRole: role,
      action: 'auth.register',
      subjectType: 'user',
      subjectId: user.id,
      after: { email, role },
    });

    if (isFirstUser) {
      log.info({ user_id: user.id }, 'first user registered — granted super_admin');
    }

    return ok(await this.issueTokens(user));
  },

  async login(input: { email: string; password: string }): Promise<ServiceResult<TokenPair>> {
    const email = input.email.trim().toLowerCase();
    const user = await authRepo.findUserByEmail(email);

    if (user === null) {
      // Burn equivalent time before answering. Without this, a missing account returns in ~1ms
      // and a real one in ~50ms, which enumerates the user base from timing alone.
      await burnPasswordTime();
      return fail(ERROR_CODES.INVALID_CREDENTIALS, { rejection: 'no_such_user' });
    }

    if (!(await verifyPassword(user.password_hash, input.password))) {
      // Same identity as "no such user" — telling them WHICH was wrong is the leak.
      return fail(ERROR_CODES.INVALID_CREDENTIALS, { rejection: 'bad_password' });
    }

    if (user.status === 'suspended') {
      return fail(ERROR_CODES.ACCOUNT_SUSPENDED, { rejection: 'suspended' });
    }

    await authRepo.touchLastLogin(user.id);
    return ok(await this.issueTokens(user));
  },

  /**
   * Refresh, with rotation and reuse detection.
   *
   * Every refresh invalidates the presented token and issues a new one. If a token that has
   * ALREADY been replaced is presented, it means the token leaked — the legitimate client and an
   * attacker both hold one, and we cannot tell which is which. The safe response is to revoke the
   * entire session family and force a fresh login.
   *
   * All of it runs in one transaction: a crash between "revoke old" and "issue new" would
   * otherwise lock the user out.
   */
  async refresh(refreshToken: string): Promise<ServiceResult<TokenPair>> {
    const hash = hashToken(refreshToken);

    return transaction(async (client) => {
      const session = await authRepo.findSessionByTokenHash(hash, client);

      if (session === null) {
        return fail(ERROR_CODES.TOKEN_INVALID, { rejection: 'unknown_refresh_token' });
      }

      // The reuse case.
      if (session.revoked_at !== null) {
        await authRepo.revokeAllSessions(session.user_id, {}, client);
        log.warn(
          { user_id: session.user_id, session_id: session.id },
          'refresh token reuse detected — revoked all sessions for this user',
        );
        await auditRepo.record(
          {
            actorId: session.user_id,
            action: 'auth.refresh_reuse_detected',
            subjectType: 'session',
            subjectId: session.id,
          },
          client,
        );
        return fail(ERROR_CODES.TOKEN_REUSED, { rejection: 'refresh_token_replayed' });
      }

      if (new Date(session.expires_at).getTime() <= Date.now()) {
        return fail(ERROR_CODES.TOKEN_EXPIRED, { rejection: 'refresh_expired' });
      }

      const user = await authRepo.findUserById(session.user_id);
      if (user === null) {
        return fail(ERROR_CODES.TOKEN_INVALID, { rejection: 'user_gone' });
      }
      if (user.status === 'suspended') {
        return fail(ERROR_CODES.ACCOUNT_SUSPENDED, { rejection: 'suspended' });
      }

      const ctx = getContext();
      const newSessionId = newId('session');
      const newRefresh = generateRefreshToken();

      await authRepo.createSession(
        {
          id: newSessionId,
          userId: user.id,
          refreshTokenHash: hashToken(newRefresh),
          userAgent: ctx?.user_agent ?? session.user_agent,
          ip: ctx?.ip ?? session.ip,
          expiresAt: futureIso(env.REFRESH_TOKEN_TTL_S),
        },
        client,
      );

      // Chain old -> new, so a replay of the old one is detectable above.
      await authRepo.markSessionReplaced(session.id, newSessionId, client);

      return ok({
        access_token: await signAccessToken({
          userId: user.id,
          role: user.role,
          sessionId: newSessionId,
        }),
        refresh_token: newRefresh,
        expires_in: env.ACCESS_TOKEN_TTL_S,
        user: toMeView(user),
      });
    });
  },

  async issueTokens(user: UserRow): Promise<TokenPair> {
    const ctx = getContext();
    const sessionId = newId('session');
    const refreshToken = generateRefreshToken();

    await authRepo.createSession({
      id: sessionId,
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: ctx?.user_agent ?? null,
      ip: ctx?.ip ?? null,
      expiresAt: futureIso(env.REFRESH_TOKEN_TTL_S),
    });

    return {
      access_token: await signAccessToken({
        userId: user.id,
        role: user.role,
        sessionId,
      }),
      refresh_token: refreshToken,
      expires_in: env.ACCESS_TOKEN_TTL_S,
      user: toMeView(user),
    };
  },

  async logout(refreshToken: string): Promise<ServiceResult<null>> {
    const session = await authRepo.findSessionByTokenHash(hashToken(refreshToken));
    if (session !== null && session.revoked_at === null) {
      await authRepo.revokeSession(session.id, session.user_id);
    }
    // Always succeeds. Logging out an already-invalid token is not an error the user can act on,
    // and reporting one only tells a prober that the token was real.
    return ok(null);
  },

  async logoutAll(userId: string): Promise<ServiceResult<{ revoked: number }>> {
    const revoked = await authRepo.revokeAllSessions(userId);
    return ok({ revoked });
  },

  async listSessions(
    userId: string,
    currentSessionId: string | undefined,
  ): Promise<ServiceResult<SessionView[]>> {
    const rows = await authRepo.listSessions(userId);
    return ok(rows.map((r) => toSessionView(r, currentSessionId)));
  },

  async revokeSession(userId: string, sessionId: string): Promise<ServiceResult<null>> {
    const n = await authRepo.revokeSession(sessionId, userId);
    if (n === 0) return failures.notFound('session');
    return ok(null);
  },

  async me(userId: string): Promise<ServiceResult<MeView>> {
    const user = await authRepo.findUserById(userId);
    if (user === null) return failures.notFound('user');
    return ok(toMeView(user));
  },

  async updateProfile(
    userId: string,
    input: { name?: string; timezone?: string },
  ): Promise<ServiceResult<MeView>> {
    if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
      return failures.validation({ timezone: ['That is not a recognised timezone.'] });
    }

    const user = await authRepo.findUserById(userId);
    if (user === null) return failures.notFound('user');

    const { query } = await import('../../db/client.js');
    await query(
      `UPDATE users SET name = COALESCE($2, name), timezone = COALESCE($3, timezone)
       WHERE id = $1`,
      [userId, input.name?.trim() ?? null, input.timezone ?? null],
    );

    const updated = await authRepo.findUserById(userId);
    return updated === null ? failures.notFound('user') : ok(toMeView(updated));
  },

  /**
   * Change password. Revokes every OTHER session — if the reason for changing it was a
   * compromise, leaving the attacker's session alive defeats the point.
   */
  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
    currentSessionId?: string,
  ): Promise<ServiceResult<{ revoked: number }>> {
    const user = await authRepo.findUserById(userId);
    if (user === null) return failures.notFound('user');

    if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
      return fail(ERROR_CODES.INVALID_CREDENTIALS, {
        rejection: 'current_password_wrong',
        fieldErrors: { current_password: ['That is not your current password.'] },
      });
    }

    await authRepo.updatePassword(userId, await hashPassword(input.newPassword));
    const revoked = await authRepo.revokeAllSessions(userId, {
      ...(currentSessionId !== undefined && { exceptId: currentSessionId }),
    });

    await auditRepo.record({
      actorId: userId,
      actorRole: user.role,
      action: 'auth.password_changed',
      subjectType: 'user',
      subjectId: userId,
    });

    return ok({ revoked });
  },

  /**
   * Request a password reset.
   *
   * Always returns success, whether or not the email exists — otherwise this endpoint is a
   * user-enumeration oracle. The caller's message says "if that email has an account…".
   */
  async requestPasswordReset(email: string): Promise<ServiceResult<{ token?: string }>> {
    const user = await authRepo.findUserByEmail(email.trim().toLowerCase());
    if (user === null) return ok({});

    const token = randomToken(32);
    await authRepo.createResetToken({
      id: newId('session'),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: futureIso(3600),
    });

    // Returned so the caller can queue the email via the outbox. It never reaches the HTTP
    // response — see the controller.
    return ok({ token });
  },

  async resetPassword(input: {
    token: string;
    newPassword: string;
  }): Promise<ServiceResult<null>> {
    const row = await authRepo.findResetToken(hashToken(input.token));

    if (row === null) {
      return fail(ERROR_CODES.TOKEN_INVALID, { rejection: 'unknown_reset_token' });
    }
    // 410 Gone, not 404: it existed and was consumed or expired. That distinction tells the user
    // to request a new link rather than hunt for a typo.
    if (row.used_at !== null) {
      return fail(ERROR_CODES.GONE, { rejection: 'reset_token_used' });
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return fail(ERROR_CODES.GONE, { rejection: 'reset_token_expired' });
    }

    await transaction(async (client) => {
      await authRepo.consumeResetToken(row.id, client);
      await authRepo.updatePassword(row.user_id, await hashPassword(input.newPassword));
      await authRepo.revokeAllSessions(row.user_id, {}, client);
    });

    await auditRepo.record({
      actorId: row.user_id,
      action: 'auth.password_reset',
      subjectType: 'user',
      subjectId: row.user_id,
    });

    return ok(null);
  },

  actorFrom,
  toUserView,
};
