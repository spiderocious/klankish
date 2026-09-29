/**
 * The error contract.
 *
 * An error response does THREE jobs, and each gets its own field, because collapsing them into one
 * `code` does all three badly:
 *
 *   BRANCH  → `reason`    a stable snake_case identity. Clients switch on it. Renaming = breaking.
 *   DISPLAY → `message`   resolved human text from the message registry. Free to change.
 *   MEASURE → `severity`  a coarse numeric band for dashboards and alerting.
 *
 * Plus two optional fields:
 *   `fieldErrors` — validation failures only.
 *   `rejection`   — an operator-facing diagnostic saying WHICH branch rejected the request. It is
 *                   explicitly NOT part of the client contract, so it can be renamed freely, and
 *                   no client may ever branch on it.
 */

export const ERROR_CODES = {
  // --- auth ---
  INVALID_CREDENTIALS: 'invalid_credentials',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_INVALID: 'token_invalid',
  TOKEN_REUSED: 'token_reused',
  SESSION_REVOKED: 'session_revoked',
  ACCOUNT_SUSPENDED: 'account_suspended',
  UNAUTHENTICATED: 'unauthenticated',

  // --- authorization ---
  FORBIDDEN: 'forbidden',
  INSUFFICIENT_ROLE: 'insufficient_role',

  // --- resources ---
  NOT_FOUND: 'not_found',
  ALREADY_EXISTS: 'already_exists',
  EMAIL_TAKEN: 'email_taken',
  NAME_TAKEN: 'name_taken',
  GONE: 'gone',

  // --- request ---
  VALIDATION_ERROR: 'validation_error',
  IDEMPOTENCY_MISMATCH: 'idempotency_mismatch',
  RATE_LIMITED: 'rate_limited',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  MALFORMED_JSON: 'malformed_json',

  // --- task graph ---
  GRAPH_HAS_CYCLE: 'graph_has_cycle',
  GRAPH_UNKNOWN_STEP: 'graph_unknown_step',
  GRAPH_DUPLICATE_KEY: 'graph_duplicate_key',
  GRAPH_NO_ENTRY: 'graph_no_entry',
  GRAPH_EMPTY: 'graph_empty',
  GRAPH_TOO_LARGE: 'graph_too_large',
  INVALID_EXPRESSION: 'invalid_expression',
  INVALID_CRON: 'invalid_cron',
  INVALID_TIMEZONE: 'invalid_timezone',

  // --- execution ---
  STEP_FAILED: 'step_failed',
  STEP_TIMEOUT: 'step_timeout',
  RUN_TIMEOUT: 'run_timeout',
  RUN_CANCELLED: 'run_cancelled',
  RUN_NOT_CANCELLABLE: 'run_not_cancellable',
  LEASE_EXPIRED: 'lease_expired',
  CONCURRENCY_SKIPPED: 'concurrency_skipped',
  MAX_QUEUED_EXCEEDED: 'max_queued_exceeded',
  INVALID_STATE_TRANSITION: 'invalid_state_transition',
  TASK_PAUSED: 'task_paused',

  // --- step runtime ---
  HTTP_REQUEST_FAILED: 'http_request_failed',
  HTTP_BLOCKED_TARGET: 'http_blocked_target',
  HTTP_TOO_MANY_REDIRECTS: 'http_too_many_redirects',
  SHELL_DISABLED: 'shell_disabled',
  SHELL_BINARY_NOT_ALLOWED: 'shell_binary_not_allowed',
  SHELL_NONZERO_EXIT: 'shell_nonzero_exit',
  SHELL_PATH_ESCAPE: 'shell_path_escape',
  ASSERTION_FAILED: 'assertion_failed',
  SECRET_NOT_FOUND: 'secret_not_found',
  CONNECTION_NOT_FOUND: 'connection_not_found',
  INTERPOLATION_FAILED: 'interpolation_failed',
  SUBTASK_DEPTH_EXCEEDED: 'subtask_depth_exceeded',

  // --- integrations ---
  MAIL_NOT_CONFIGURED: 'mail_not_configured',
  MAIL_SEND_FAILED: 'mail_send_failed',
  STORAGE_NOT_CONFIGURED: 'storage_not_configured',
  STORAGE_FAILED: 'storage_failed',
  OBJECT_NOT_FOUND: 'object_not_found',

  // --- server ---
  INTERNAL_ERROR: 'internal_error',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  DEPENDENCY_DOWN: 'dependency_down',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Severity bands answer ONE question: "should this page someone?" — never "what went wrong?".
 *
 * They are coarse by design. A handful of bands cannot distinguish dozens of reasons, which is
 * exactly why severity can never drive client branching; that is `reason`'s job.
 */
export const SEVERITY = {
  BODY_VALIDATION: 10,
  /**
   * Validation that should not happen from a well-behaved client: referencing another user's
   * secret, a step key not in the graph, a cross-user id. A user typo and a client bug both fail
   * validation, but only one is worth investigating — this is the band people forget to add.
   */
  SUSPICIOUS_VALIDATION: 15,
  AUTH: 20,
  FORBIDDEN: 30,
  NOT_FOUND: 40,
  CONFLICT: 50,
  BUSINESS_RULE: 60,
  RATE_LIMITED: 70,
  UPSTREAM: 80,
  SERVER_FAULT: 90,
} as const;

export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

const SEVERITY_BY_CODE: Readonly<Record<ErrorCode, Severity>> = {
  [ERROR_CODES.INVALID_CREDENTIALS]: SEVERITY.AUTH,
  [ERROR_CODES.TOKEN_EXPIRED]: SEVERITY.AUTH,
  [ERROR_CODES.TOKEN_INVALID]: SEVERITY.AUTH,
  // Reuse of a rotated refresh token means theft or a broken client, not an expiry. It gets the
  // suspicious band so it surfaces on a dashboard rather than blending into ordinary auth noise.
  [ERROR_CODES.TOKEN_REUSED]: SEVERITY.SUSPICIOUS_VALIDATION,
  [ERROR_CODES.SESSION_REVOKED]: SEVERITY.AUTH,
  [ERROR_CODES.ACCOUNT_SUSPENDED]: SEVERITY.FORBIDDEN,
  [ERROR_CODES.UNAUTHENTICATED]: SEVERITY.AUTH,

  [ERROR_CODES.FORBIDDEN]: SEVERITY.FORBIDDEN,
  [ERROR_CODES.INSUFFICIENT_ROLE]: SEVERITY.FORBIDDEN,

  [ERROR_CODES.NOT_FOUND]: SEVERITY.NOT_FOUND,
  [ERROR_CODES.ALREADY_EXISTS]: SEVERITY.CONFLICT,
  [ERROR_CODES.EMAIL_TAKEN]: SEVERITY.CONFLICT,
  [ERROR_CODES.NAME_TAKEN]: SEVERITY.CONFLICT,
  [ERROR_CODES.GONE]: SEVERITY.NOT_FOUND,

  [ERROR_CODES.VALIDATION_ERROR]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.IDEMPOTENCY_MISMATCH]: SEVERITY.CONFLICT,
  [ERROR_CODES.RATE_LIMITED]: SEVERITY.RATE_LIMITED,
  [ERROR_CODES.PAYLOAD_TOO_LARGE]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.MALFORMED_JSON]: SEVERITY.BODY_VALIDATION,

  [ERROR_CODES.GRAPH_HAS_CYCLE]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.GRAPH_UNKNOWN_STEP]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.GRAPH_DUPLICATE_KEY]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.GRAPH_NO_ENTRY]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.GRAPH_EMPTY]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.GRAPH_TOO_LARGE]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.INVALID_EXPRESSION]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.INVALID_CRON]: SEVERITY.BODY_VALIDATION,
  [ERROR_CODES.INVALID_TIMEZONE]: SEVERITY.BODY_VALIDATION,

  [ERROR_CODES.STEP_FAILED]: SEVERITY.BUSINESS_RULE,
  [ERROR_CODES.STEP_TIMEOUT]: SEVERITY.BUSINESS_RULE,
  [ERROR_CODES.RUN_TIMEOUT]: SEVERITY.BUSINESS_RULE,
  [ERROR_CODES.RUN_CANCELLED]: SEVERITY.BUSINESS_RULE,
  [ERROR_CODES.RUN_NOT_CANCELLABLE]: SEVERITY.CONFLICT,
  [ERROR_CODES.LEASE_EXPIRED]: SEVERITY.SERVER_FAULT,
  [ERROR_CODES.CONCURRENCY_SKIPPED]: SEVERITY.BUSINESS_RULE,
  [ERROR_CODES.MAX_QUEUED_EXCEEDED]: SEVERITY.BUSINESS_RULE,
  [ERROR_CODES.INVALID_STATE_TRANSITION]: SEVERITY.CONFLICT,
  [ERROR_CODES.TASK_PAUSED]: SEVERITY.BUSINESS_RULE,

  [ERROR_CODES.HTTP_REQUEST_FAILED]: SEVERITY.UPSTREAM,
  // A blocked target is usually a misconfiguration, but it is also what an SSRF probe looks like.
  [ERROR_CODES.HTTP_BLOCKED_TARGET]: SEVERITY.SUSPICIOUS_VALIDATION,
  [ERROR_CODES.HTTP_TOO_MANY_REDIRECTS]: SEVERITY.UPSTREAM,
  [ERROR_CODES.SHELL_DISABLED]: SEVERITY.FORBIDDEN,
  [ERROR_CODES.SHELL_BINARY_NOT_ALLOWED]: SEVERITY.SUSPICIOUS_VALIDATION,
  [ERROR_CODES.SHELL_NONZERO_EXIT]: SEVERITY.BUSINESS_RULE,
  [ERROR_CODES.SHELL_PATH_ESCAPE]: SEVERITY.SUSPICIOUS_VALIDATION,
  [ERROR_CODES.ASSERTION_FAILED]: SEVERITY.BUSINESS_RULE,
  // Referencing a secret you do not own is probing, not a typo.
  [ERROR_CODES.SECRET_NOT_FOUND]: SEVERITY.SUSPICIOUS_VALIDATION,
  [ERROR_CODES.CONNECTION_NOT_FOUND]: SEVERITY.SUSPICIOUS_VALIDATION,
  [ERROR_CODES.INTERPOLATION_FAILED]: SEVERITY.BUSINESS_RULE,
  [ERROR_CODES.SUBTASK_DEPTH_EXCEEDED]: SEVERITY.BUSINESS_RULE,

  [ERROR_CODES.MAIL_NOT_CONFIGURED]: SEVERITY.SERVER_FAULT,
  [ERROR_CODES.MAIL_SEND_FAILED]: SEVERITY.UPSTREAM,
  [ERROR_CODES.STORAGE_NOT_CONFIGURED]: SEVERITY.SERVER_FAULT,
  [ERROR_CODES.STORAGE_FAILED]: SEVERITY.UPSTREAM,
  [ERROR_CODES.OBJECT_NOT_FOUND]: SEVERITY.NOT_FOUND,

  [ERROR_CODES.INTERNAL_ERROR]: SEVERITY.SERVER_FAULT,
  [ERROR_CODES.SERVICE_UNAVAILABLE]: SEVERITY.SERVER_FAULT,
  [ERROR_CODES.DEPENDENCY_DOWN]: SEVERITY.SERVER_FAULT,
};

export function severityFor(code: ErrorCode): Severity {
  return SEVERITY_BY_CODE[code] ?? SEVERITY.SERVER_FAULT;
}

/** Default HTTP status per identity. A service may override where the context differs. */
const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  [ERROR_CODES.INVALID_CREDENTIALS]: 401,
  [ERROR_CODES.TOKEN_EXPIRED]: 401,
  [ERROR_CODES.TOKEN_INVALID]: 401,
  [ERROR_CODES.TOKEN_REUSED]: 401,
  [ERROR_CODES.SESSION_REVOKED]: 401,
  [ERROR_CODES.ACCOUNT_SUSPENDED]: 403,
  [ERROR_CODES.UNAUTHENTICATED]: 401,

  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.INSUFFICIENT_ROLE]: 403,

  [ERROR_CODES.NOT_FOUND]: 404,
  [ERROR_CODES.ALREADY_EXISTS]: 409,
  [ERROR_CODES.EMAIL_TAKEN]: 409,
  [ERROR_CODES.NAME_TAKEN]: 409,
  [ERROR_CODES.GONE]: 410,

  [ERROR_CODES.VALIDATION_ERROR]: 422,
  [ERROR_CODES.IDEMPOTENCY_MISMATCH]: 422,
  [ERROR_CODES.RATE_LIMITED]: 429,
  [ERROR_CODES.PAYLOAD_TOO_LARGE]: 413,
  [ERROR_CODES.MALFORMED_JSON]: 400,

  [ERROR_CODES.GRAPH_HAS_CYCLE]: 422,
  [ERROR_CODES.GRAPH_UNKNOWN_STEP]: 422,
  [ERROR_CODES.GRAPH_DUPLICATE_KEY]: 422,
  [ERROR_CODES.GRAPH_NO_ENTRY]: 422,
  [ERROR_CODES.GRAPH_EMPTY]: 422,
  [ERROR_CODES.GRAPH_TOO_LARGE]: 422,
  [ERROR_CODES.INVALID_EXPRESSION]: 422,
  [ERROR_CODES.INVALID_CRON]: 422,
  [ERROR_CODES.INVALID_TIMEZONE]: 422,

  [ERROR_CODES.STEP_FAILED]: 500,
  [ERROR_CODES.STEP_TIMEOUT]: 504,
  [ERROR_CODES.RUN_TIMEOUT]: 504,
  [ERROR_CODES.RUN_CANCELLED]: 409,
  [ERROR_CODES.RUN_NOT_CANCELLABLE]: 409,
  [ERROR_CODES.LEASE_EXPIRED]: 500,
  [ERROR_CODES.CONCURRENCY_SKIPPED]: 409,
  [ERROR_CODES.MAX_QUEUED_EXCEEDED]: 429,
  [ERROR_CODES.INVALID_STATE_TRANSITION]: 409,
  [ERROR_CODES.TASK_PAUSED]: 409,

  [ERROR_CODES.HTTP_REQUEST_FAILED]: 502,
  [ERROR_CODES.HTTP_BLOCKED_TARGET]: 422,
  [ERROR_CODES.HTTP_TOO_MANY_REDIRECTS]: 502,
  [ERROR_CODES.SHELL_DISABLED]: 403,
  [ERROR_CODES.SHELL_BINARY_NOT_ALLOWED]: 403,
  [ERROR_CODES.SHELL_NONZERO_EXIT]: 500,
  [ERROR_CODES.SHELL_PATH_ESCAPE]: 403,
  [ERROR_CODES.ASSERTION_FAILED]: 500,
  [ERROR_CODES.SECRET_NOT_FOUND]: 422,
  [ERROR_CODES.CONNECTION_NOT_FOUND]: 422,
  [ERROR_CODES.INTERPOLATION_FAILED]: 500,
  [ERROR_CODES.SUBTASK_DEPTH_EXCEEDED]: 422,

  [ERROR_CODES.MAIL_NOT_CONFIGURED]: 503,
  [ERROR_CODES.MAIL_SEND_FAILED]: 502,
  [ERROR_CODES.STORAGE_NOT_CONFIGURED]: 503,
  [ERROR_CODES.STORAGE_FAILED]: 502,
  [ERROR_CODES.OBJECT_NOT_FOUND]: 404,

  [ERROR_CODES.INTERNAL_ERROR]: 500,
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 503,
  [ERROR_CODES.DEPENDENCY_DOWN]: 503,
};

export function statusFor(code: ErrorCode): number {
  return STATUS_BY_CODE[code] ?? 500;
}

/** The wire shape of an error. Shared verbatim by server and client — this IS the contract. */
export interface ErrorEnvelope {
  readonly error: {
    readonly reason: ErrorCode;
    readonly message: string;
    readonly severity: Severity;
    readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
    /** Diagnostic only. Never branch on this. */
    readonly rejection?: string;
    readonly request_id?: string;
    readonly retry_after?: number;
  };
}

export interface SuccessEnvelope<T> {
  readonly data: T;
  readonly meta?: PaginationMeta | Readonly<Record<string, unknown>>;
}

/**
 * Cursor pagination only. Offset is banned: it breaks under concurrent inserts and degrades at
 * high offsets.
 *
 * These exact wire names — `next_cursor`, `has_more` — are the contract. The seam checklist exists
 * because this is the single most common place a frontend and backend silently disagree.
 */
export interface PaginationMeta {
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}
