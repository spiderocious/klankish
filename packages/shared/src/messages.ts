import { ERROR_CODES, type ErrorCode } from './errors.js';

/**
 * The message registry.
 *
 * Every error resolves REAL user-facing text here. A generic "Request failed" default is a bug,
 * not a fallback — if this map is missing an entry, the error handler should be loud about it in
 * development rather than quietly papering over it.
 *
 * Copy lives here, in one reviewable place, so it can be changed (or later translated) without
 * touching a single service. This is also why clients must never branch on the message: it is free
 * to change, which is precisely what makes it unsuitable as a contract.
 */

export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  [ERROR_CODES.INVALID_CREDENTIALS]: 'That email or password is not right.',
  [ERROR_CODES.TOKEN_EXPIRED]: 'Your session has expired. Please sign in again.',
  [ERROR_CODES.TOKEN_INVALID]: 'That sign-in token is not valid.',
  [ERROR_CODES.TOKEN_REUSED]:
    'For your security, all sessions were signed out because a used token was presented again.',
  [ERROR_CODES.SESSION_REVOKED]: 'This session was signed out. Please sign in again.',
  [ERROR_CODES.ACCOUNT_SUSPENDED]: 'This account is suspended. Contact an administrator.',
  [ERROR_CODES.UNAUTHENTICATED]: 'You need to sign in to do that.',

  [ERROR_CODES.FORBIDDEN]: 'You do not have access to that.',
  [ERROR_CODES.INSUFFICIENT_ROLE]: 'Your role does not allow that action.',

  [ERROR_CODES.NOT_FOUND]: 'That does not exist.',
  [ERROR_CODES.ALREADY_EXISTS]: 'That already exists.',
  [ERROR_CODES.EMAIL_TAKEN]: 'An account with that email already exists.',
  [ERROR_CODES.NAME_TAKEN]: 'You already have one with that name.',
  [ERROR_CODES.GONE]: 'That link has expired. Please request a new one.',

  [ERROR_CODES.VALIDATION_ERROR]: 'Some fields need fixing.',
  [ERROR_CODES.IDEMPOTENCY_MISMATCH]:
    'That request key was already used with a different body.',
  [ERROR_CODES.RATE_LIMITED]: 'Too many requests. Please slow down.',
  [ERROR_CODES.PAYLOAD_TOO_LARGE]: 'That request is too large.',
  [ERROR_CODES.MALFORMED_JSON]: 'The request body is not valid JSON.',

  [ERROR_CODES.GRAPH_HAS_CYCLE]: 'These steps loop back on themselves and would never finish.',
  [ERROR_CODES.GRAPH_UNKNOWN_STEP]: 'A step points at another step that does not exist.',
  [ERROR_CODES.GRAPH_DUPLICATE_KEY]: 'Two steps share the same key. Keys must be unique.',
  [ERROR_CODES.GRAPH_NO_ENTRY]: 'This task has no starting step.',
  [ERROR_CODES.GRAPH_EMPTY]: 'This task has no steps yet.',
  [ERROR_CODES.GRAPH_TOO_LARGE]: 'This task has too many steps.',
  [ERROR_CODES.INVALID_EXPRESSION]: 'That expression could not be understood.',
  [ERROR_CODES.INVALID_CRON]: 'That is not a valid schedule expression.',
  [ERROR_CODES.INVALID_TIMEZONE]: 'That is not a recognised timezone.',

  [ERROR_CODES.STEP_FAILED]: 'A step failed.',
  [ERROR_CODES.STEP_TIMEOUT]: 'A step took too long and was stopped.',
  [ERROR_CODES.RUN_TIMEOUT]: 'This run took too long and was stopped.',
  [ERROR_CODES.RUN_CANCELLED]: 'This run was cancelled.',
  [ERROR_CODES.RUN_NOT_CANCELLABLE]: 'This run has already finished.',
  [ERROR_CODES.LEASE_EXPIRED]: 'The worker running this stopped responding. It was re-queued.',
  [ERROR_CODES.CONCURRENCY_SKIPPED]: 'Skipped: a previous run of this task is still going.',
  [ERROR_CODES.MAX_QUEUED_EXCEEDED]: 'Too many runs of this task are already waiting.',
  [ERROR_CODES.INVALID_STATE_TRANSITION]: 'That change is not allowed from the current state.',
  [ERROR_CODES.TASK_PAUSED]: 'This task is paused.',

  [ERROR_CODES.HTTP_REQUEST_FAILED]: 'The request to that address failed.',
  [ERROR_CODES.HTTP_BLOCKED_TARGET]:
    'That address is not allowed. Internal and private addresses are blocked.',
  [ERROR_CODES.HTTP_TOO_MANY_REDIRECTS]: 'That address redirected too many times.',
  [ERROR_CODES.SHELL_DISABLED]: 'Running commands is turned off on this instance.',
  [ERROR_CODES.SHELL_BINARY_NOT_ALLOWED]: 'That command is not on the allowed list.',
  [ERROR_CODES.SHELL_NONZERO_EXIT]: 'The command finished with an error.',
  [ERROR_CODES.SHELL_PATH_ESCAPE]: 'That working directory is outside the allowed workspace.',
  [ERROR_CODES.ASSERTION_FAILED]: 'A check did not hold.',
  [ERROR_CODES.SECRET_NOT_FOUND]: 'No secret with that name.',
  [ERROR_CODES.CONNECTION_NOT_FOUND]: 'No connection with that name.',
  [ERROR_CODES.INTERPOLATION_FAILED]: 'A value referenced by a step could not be resolved.',
  [ERROR_CODES.SUBTASK_DEPTH_EXCEEDED]: 'Tasks are nested too deeply.',

  [ERROR_CODES.MAIL_NOT_CONFIGURED]: 'Email is not set up on this instance.',
  [ERROR_CODES.MAIL_SEND_FAILED]: 'The email could not be sent.',
  [ERROR_CODES.STORAGE_NOT_CONFIGURED]: 'File storage is not set up on this instance.',
  [ERROR_CODES.STORAGE_FAILED]: 'The file could not be stored.',
  [ERROR_CODES.OBJECT_NOT_FOUND]: 'No file at that key.',

  [ERROR_CODES.INTERNAL_ERROR]: 'Something went wrong on our side.',
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 'The service is temporarily unavailable.',
  [ERROR_CODES.DEPENDENCY_DOWN]: 'A service this depends on is not responding.',
};

export function resolveErrorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[ERROR_CODES.INTERNAL_ERROR];
}

/**
 * Success message keys, sliced per feature.
 *
 * Success responses mostly carry data rather than prose, so this is smaller than the error
 * registry — it exists for the cases where the UI shows a confirmation toast.
 */
export const MESSAGE_KEYS = {
  auth: {
    REGISTERED: 'auth.registered',
    LOGGED_IN: 'auth.logged_in',
    LOGGED_OUT: 'auth.logged_out',
    PASSWORD_CHANGED: 'auth.password_changed',
    PASSWORD_RESET_SENT: 'auth.password_reset_sent',
    PASSWORD_RESET: 'auth.password_reset',
    SESSIONS_REVOKED: 'auth.sessions_revoked',
  },
  tasks: {
    CREATED: 'tasks.created',
    UPDATED: 'tasks.updated',
    DELETED: 'tasks.deleted',
    PAUSED: 'tasks.paused',
    RESUMED: 'tasks.resumed',
    CLONED: 'tasks.cloned',
    RUN_QUEUED: 'tasks.run_queued',
    VERSION_RESTORED: 'tasks.version_restored',
  },
  runs: {
    CANCELLED: 'runs.cancelled',
    RETRIED: 'runs.retried',
  },
  secrets: {
    CREATED: 'secrets.created',
    UPDATED: 'secrets.updated',
    DELETED: 'secrets.deleted',
  },
  admin: {
    USER_SUSPENDED: 'admin.user_suspended',
    USER_REACTIVATED: 'admin.user_reactivated',
    ROLE_CHANGED: 'admin.role_changed',
    RUN_KILLED: 'admin.run_killed',
  },
} as const;

/**
 * The union of every message key.
 *
 * Written with a distributive conditional rather than `Group[keyof Group]`: indexing a UNION of
 * object types by `keyof` of that union yields the INTERSECTION of their keys, which here is
 * empty — so the naive form collapses to `never` and every call site fails to typecheck.
 */
type ValuesOf<T> = T extends Record<string, infer V> ? V : never;
export type MessageKey = ValuesOf<(typeof MESSAGE_KEYS)[keyof typeof MESSAGE_KEYS]>;

const SUCCESS_MESSAGES: Readonly<Record<string, string>> = {
  [MESSAGE_KEYS.auth.REGISTERED]: 'Account created.',
  [MESSAGE_KEYS.auth.LOGGED_IN]: 'Signed in.',
  [MESSAGE_KEYS.auth.LOGGED_OUT]: 'Signed out.',
  [MESSAGE_KEYS.auth.PASSWORD_CHANGED]: 'Password changed. Other sessions were signed out.',
  [MESSAGE_KEYS.auth.PASSWORD_RESET_SENT]:
    'If that email has an account, a reset link is on its way.',
  [MESSAGE_KEYS.auth.PASSWORD_RESET]: 'Password reset. You can sign in now.',
  [MESSAGE_KEYS.auth.SESSIONS_REVOKED]: 'Signed out everywhere else.',

  [MESSAGE_KEYS.tasks.CREATED]: 'Task created.',
  [MESSAGE_KEYS.tasks.UPDATED]: 'Task saved.',
  [MESSAGE_KEYS.tasks.DELETED]: 'Task deleted.',
  [MESSAGE_KEYS.tasks.PAUSED]: 'Task paused.',
  [MESSAGE_KEYS.tasks.RESUMED]: 'Task resumed.',
  [MESSAGE_KEYS.tasks.CLONED]: 'Task cloned.',
  [MESSAGE_KEYS.tasks.RUN_QUEUED]: 'Run queued.',
  [MESSAGE_KEYS.tasks.VERSION_RESTORED]: 'Version restored as a new version.',

  [MESSAGE_KEYS.runs.CANCELLED]: 'Run cancelled.',
  [MESSAGE_KEYS.runs.RETRIED]: 'Retry queued.',

  [MESSAGE_KEYS.secrets.CREATED]: 'Secret saved.',
  [MESSAGE_KEYS.secrets.UPDATED]: 'Secret updated.',
  [MESSAGE_KEYS.secrets.DELETED]: 'Secret deleted.',

  [MESSAGE_KEYS.admin.USER_SUSPENDED]: 'User suspended.',
  [MESSAGE_KEYS.admin.USER_REACTIVATED]: 'User reactivated.',
  [MESSAGE_KEYS.admin.ROLE_CHANGED]: 'Role updated.',
  [MESSAGE_KEYS.admin.RUN_KILLED]: 'Run killed.',
};

export function resolveMessage(key: MessageKey): string {
  return SUCCESS_MESSAGES[key] ?? key;
}
