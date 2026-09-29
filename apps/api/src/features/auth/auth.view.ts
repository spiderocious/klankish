import { permissionsFor, type MeView, type SessionView, type UserView } from '@klankish/shared';

import type { SessionRow, UserRow } from './auth.repo.js';

/**
 * Row → wire mappers.
 *
 * THIS FILE IS THE SERIALISER. When a doc, a type, or a checklist disagrees with it about a field
 * name or its casing, this file is right and the other thing is stale. Verify the seam by reading
 * here, never by reading prose.
 *
 * Casing: snake_case, matching the rest of the envelope.
 * Dates: ISO 8601 strings — never epoch numbers, never Date objects.
 * Secrets: password_hash never appears in any view. There is no mapper that can emit it.
 */

export function toUserView(row: UserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    timezone: row.timezone,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
  };
}

export function toMeView(row: UserRow): MeView {
  return {
    ...toUserView(row),
    // Resolved server-side and sent down so the client renders the right affordances without
    // reimplementing the permission ladder. The server still enforces it independently — this is
    // for rendering, never for authorisation.
    permissions: permissionsFor({ id: row.id, role: row.role, status: row.status }),
  };
}

export function toSessionView(row: SessionRow, currentSessionId?: string): SessionView {
  return {
    id: row.id,
    user_agent: row.user_agent,
    ip: row.ip,
    created_at: row.created_at,
    expires_at: row.expires_at,
    // Lets the UI label "this device" and avoid offering to revoke the session you are using.
    is_current: currentSessionId !== undefined && row.id === currentSessionId,
  };
}
