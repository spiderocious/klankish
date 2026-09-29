/**
 * Roles and permissions.
 *
 * The ladder is STRICT: super_admin ⊃ admin ⊃ user. There is no permission an admin holds that a
 * super_admin lacks. An admin is a user with elevated permissions — never a parallel surface with
 * its own logic, because two implementations of "can this actor see this row" is how a tool grows
 * an access bug.
 *
 * Everything here is a pure function so both the server and the browser can ask the same question
 * and get the same answer. The server's answer is the one that counts; the client uses it only to
 * decide what to render.
 */

export const ROLES = ['user', 'admin', 'super_admin'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Readonly<Record<Role, number>> = {
  user: 0,
  admin: 1,
  super_admin: 2,
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

/** The whole ladder, in one place. Everything else in this file is built on it. */
export function atLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export const isAdmin = (role: Role): boolean => atLeast(role, 'admin');
export const isSuperAdmin = (role: Role): boolean => atLeast(role, 'super_admin');

export const USER_STATUSES = ['active', 'suspended', 'invited'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** The minimal actor shape every permission check needs. Never the full user row. */
export interface Actor {
  readonly id: string;
  readonly role: Role;
  readonly status: UserStatus;
}

/**
 * Ownership check.
 *
 * A non-admin sees only their own rows; an admin sees everything. Note what this returns for a
 * suspended actor: nothing. A suspended account keeps its role but loses access, and putting that
 * rule HERE rather than in each route means it cannot be forgotten at one endpoint.
 */
export function canAccessOwned(actor: Actor, ownerId: string): boolean {
  if (actor.status !== 'active') return false;
  if (isAdmin(actor.role)) return true;
  return actor.id === ownerId;
}

/**
 * Mutation is narrower than access: an admin can SEE another user's task, and can pause it (an
 * operational safety valve), but must not silently edit someone's automation. Editing stays with
 * the owner and with super_admin.
 */
export function canMutateOwned(actor: Actor, ownerId: string): boolean {
  if (actor.status !== 'active') return false;
  if (actor.id === ownerId) return true;
  return isSuperAdmin(actor.role);
}

export const PERMISSIONS = [
  'task.read.any',
  'task.write.any',
  'task.pause.any',
  'run.read.any',
  'run.kill.any',
  'user.read.any',
  'user.suspend',
  'user.delete',
  'user.role.change',
  'audit.read',
  'worker.read',
  'queue.manage',
  'instance.settings',
  'encryption.rotate',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_MIN_ROLE: Readonly<Record<Permission, Role>> = {
  'task.read.any': 'admin',
  // Editing another user's task is super_admin only — see canMutateOwned.
  'task.write.any': 'super_admin',
  'task.pause.any': 'admin',
  'run.read.any': 'admin',
  'run.kill.any': 'admin',
  'user.read.any': 'admin',
  'user.suspend': 'admin',
  'user.delete': 'super_admin',
  'user.role.change': 'super_admin',
  'audit.read': 'admin',
  'worker.read': 'admin',
  'queue.manage': 'admin',
  'instance.settings': 'super_admin',
  'encryption.rotate': 'super_admin',
};

export function can(actor: Actor, permission: Permission): boolean {
  if (actor.status !== 'active') return false;
  return atLeast(actor.role, PERMISSION_MIN_ROLE[permission]);
}

/** Every permission an actor holds. Sent to the client so the UI renders the right affordances. */
export function permissionsFor(actor: Actor): Permission[] {
  return PERMISSIONS.filter((p) => can(actor, p));
}

/**
 * Role changes a given actor may make.
 *
 * Two guards worth stating: nobody may grant a role above their own (privilege escalation), and
 * the caller must separately enforce that the last super_admin cannot be demoted — that needs a
 * database count, so it cannot live in this pure module.
 */
export function canAssignRole(actor: Actor, target: Role): boolean {
  if (!can(actor, 'user.role.change')) return false;
  return atLeast(actor.role, target);
}
