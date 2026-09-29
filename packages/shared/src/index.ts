/**
 * @klankish/shared — the contract between the engine, the API and the browser.
 *
 * Anything in here is imported by BOTH sides. That is deliberate: a field renamed here is a
 * compile error in the frontend rather than a runtime surprise, which is the only real defence
 * against contract drift at the seam.
 */

export {
  ERROR_CODES,
  SEVERITY,
  severityFor,
  statusFor,
  type ErrorCode,
  type Severity,
  type ErrorEnvelope,
  type SuccessEnvelope,
  type PaginationMeta,
} from './errors.js';

export {
  ERROR_MESSAGES,
  MESSAGE_KEYS,
  resolveErrorMessage,
  resolveMessage,
  type MessageKey,
} from './messages.js';

export {
  ROLES,
  USER_STATUSES,
  PERMISSIONS,
  atLeast,
  can,
  canAccessOwned,
  canAssignRole,
  canMutateOwned,
  isAdmin,
  isRole,
  isSuperAdmin,
  permissionsFor,
  type Actor,
  type Permission,
  type Role,
  type UserStatus,
} from './rbac.js';

export {
  STEP_KINDS,
  HTTP_METHODS,
  BACKOFF_STRATEGIES,
  RUN_STATUSES,
  STEP_RUN_STATUSES,
  RUN_TRIGGERS,
  TASK_STATUSES,
  CONCURRENCY_POLICIES,
  SCHEDULE_KINDS,
  RUN_TRANSITIONS,
  TERMINAL_RUN_STATUSES,
  DEFAULT_RETRY,
  canTransitionRun,
  defaultIdempotent,
  isIdempotent,
  isTerminalRunStatus,
  outgoingTargets,
  type AssertStep,
  type BackoffStrategy,
  type BranchCase,
  type BranchStep,
  type CaptureRule,
  type ConcurrencyPolicy,
  type DelayStep,
  type EmailStep,
  type HttpMethod,
  type HttpStep,
  type NoopStep,
  type OnError,
  type RetryPolicy,
  type RunStatus,
  type RunTrigger,
  type ScheduleKind,
  type ShellStep,
  type Step,
  type StepKind,
  type StepRunStatus,
  type StorageGetStep,
  type StoragePutStep,
  type SubtaskStep,
  type TaskGraph,
  type TaskStatus,
  type TransformStep,
  type WebhookStep,
} from './graph.js';

export { validateGraph, type GraphIssue, type GraphValidation } from './graph-validate.js';

export {
  ID_PREFIXES,
  idTimestamp,
  isId,
  newId,
  ulid,
  type ResourceKind,
} from './ids.js';

export {
  LOG_REDACT_PATHS,
  REDACTED,
  isSensitiveName,
  redact,
  redactHeaders,
  redactUrl,
  type RedactOptions,
} from './redact.js';

export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_PAGE_SIZE_ADMIN,
  buildPage,
  clampLimit,
  decodeCursor,
  encodeCursor,
  type Cursor,
} from './cursor.js';

export {
  describeCron,
  isValidTimezone,
  nextFireAt,
  nextFires,
  parseCron,
  type CronFields,
  type CronParseResult,
} from './cron.js';

export {
  applyRetryAfter,
  computeBackoffMs,
  parseRetryAfter,
  shouldRetry,
  type BackoffInput,
  type FailureKind,
  type RetryDecisionInput,
} from './backoff.js';

export type {
  AdminOverviewView,
  ApiKeyCreatedView,
  ApiKeyView,
  AuditLogView,
  ConnectionView,
  DashboardView,
  HourBucket,
  HttpExchangeView,
  MeView,
  NotificationView,
  QueueStatsView,
  RunDetailView,
  RunView,
  ScheduleView,
  SecretView,
  SessionView,
  StepErrorView,
  StepRunView,
  TaskDetailView,
  TaskStats,
  TaskVersionView,
  TaskView,
  UpcomingFireView,
  UserView,
  WorkerView,
} from './wire.js';
