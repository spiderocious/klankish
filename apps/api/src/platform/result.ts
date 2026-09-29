import {
  ERROR_CODES,
  resolveErrorMessage,
  severityFor,
  statusFor,
  type ErrorCode,
  type Severity,
} from '@klankish/shared';

/**
 * ServiceResult — the return type of every service method.
 *
 * Services NEVER throw for expected failures (not found, conflict, forbidden, validation). They
 * return a value, so their branching is testable without try/catch and so a caller cannot forget
 * to handle a failure mode: the type forces the check.
 *
 * Throwing is reserved for the genuinely unexpected — the database being down, a bug. Those
 * belong in the global error handler, not in a domain branch.
 */

export type ServiceResult<T> =
  | { readonly success: true; readonly data: T }
  | {
      readonly success: false;
      readonly errorCode: ErrorCode;
      readonly httpStatus: number;
      readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
      /** Operator-facing diagnostic. NOT contract — no client may branch on it. */
      readonly rejection?: string;
      readonly retryAfter?: number;
      /** Overrides the registry message. Used where a specific detail genuinely helps. */
      readonly message?: string;
    };

export type ServiceFailure = Extract<ServiceResult<never>, { success: false }>;

export const ok = <T>(data: T): ServiceResult<T> => ({ success: true, data });

export function fail(
  errorCode: ErrorCode,
  opts: {
    readonly httpStatus?: number;
    readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
    readonly rejection?: string;
    readonly retryAfter?: number;
    readonly message?: string;
  } = {},
): ServiceFailure {
  return {
    success: false,
    errorCode,
    httpStatus: opts.httpStatus ?? statusFor(errorCode),
    ...(opts.fieldErrors !== undefined && { fieldErrors: opts.fieldErrors }),
    ...(opts.rejection !== undefined && { rejection: opts.rejection }),
    ...(opts.retryAfter !== undefined && { retryAfter: opts.retryAfter }),
    ...(opts.message !== undefined && { message: opts.message }),
  };
}

/** Common failures, so their identity and diagnostic are spelled the same way everywhere. */
export const failures = {
  notFound: (what: string): ServiceFailure =>
    fail(ERROR_CODES.NOT_FOUND, { rejection: `${what}_not_found` }),

  /**
   * Cross-user access is 403, not 404.
   *
   * The information-leak argument for 404 does not apply here: the caller is authenticated, and
   * ULIDs are unguessable, so confirming "a row with this id exists" reveals nothing useful. A
   * truthful 403 is far easier to debug than a misleading 404.
   */
  forbidden: (rejection = 'not_owner'): ServiceFailure =>
    fail(ERROR_CODES.FORBIDDEN, { rejection }),

  validation: (
    fieldErrors: Readonly<Record<string, readonly string[]>>,
    rejection?: string,
  ): ServiceFailure =>
    fail(ERROR_CODES.VALIDATION_ERROR, {
      fieldErrors,
      ...(rejection !== undefined && { rejection }),
    }),

  conflict: (code: ErrorCode, rejection?: string): ServiceFailure =>
    fail(code, { ...(rejection !== undefined && { rejection }) }),
} as const;

/**
 * The error the global handler renders.
 *
 * Note the deliberate split: the SERVICE returns a value, and the CONTROLLER converts that value
 * into a throw at the HTTP boundary. That is not a contradiction of "services never throw" — it is
 * what keeps every error rendering in one middleware instead of letting two hundred controllers
 * each invent their own envelope.
 */
export class AppError extends Error {
  readonly reason: ErrorCode;
  readonly httpStatus: number;
  readonly severity: Severity;
  readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
  readonly rejection?: string;
  readonly retryAfter?: number;
  /** The user-facing text. Distinct from `message`, which is for logs and stack traces. */
  readonly displayMessage: string;

  constructor(
    reason: ErrorCode,
    opts: {
      readonly httpStatus?: number;
      readonly fieldErrors?: Readonly<Record<string, readonly string[]>>;
      readonly rejection?: string;
      readonly retryAfter?: number;
      readonly message?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    // Internal message: what an operator reads in a log. Never served to a client.
    super(opts.rejection ?? reason);
    this.name = 'AppError';
    this.reason = reason;
    this.httpStatus = opts.httpStatus ?? statusFor(reason);
    this.severity = severityFor(reason);
    this.displayMessage = opts.message ?? resolveErrorMessage(reason);
    if (opts.fieldErrors !== undefined) this.fieldErrors = opts.fieldErrors;
    if (opts.rejection !== undefined) this.rejection = opts.rejection;
    if (opts.retryAfter !== undefined) this.retryAfter = opts.retryAfter;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * Convert a failed ServiceResult into the thrown AppError the error handler renders.
 *
 * Controllers call this and nothing else on the failure path — they never interpret WHY something
 * failed, which is what keeps them thin.
 */
export function bail(failure: ServiceFailure): never {
  throw new AppError(failure.errorCode, {
    httpStatus: failure.httpStatus,
    ...(failure.fieldErrors !== undefined && { fieldErrors: failure.fieldErrors }),
    ...(failure.rejection !== undefined && { rejection: failure.rejection }),
    ...(failure.retryAfter !== undefined && { retryAfter: failure.retryAfter }),
    ...(failure.message !== undefined && { message: failure.message }),
  });
}

/** Narrow a ServiceResult, throwing on failure. For call sites that cannot handle it locally. */
export function unwrap<T>(result: ServiceResult<T>): T {
  if (!result.success) bail(result);
  return result.data;
}
