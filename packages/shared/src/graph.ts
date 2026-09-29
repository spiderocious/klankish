/**
 * The task graph — the single definition of what a task IS.
 *
 * This type is imported by both the engine (which executes it) and the builder UI (which edits
 * it), so the two cannot disagree about the shape of a step. That is the entire reason this lives
 * in a shared package rather than being declared twice.
 */

export const STEP_KINDS = [
  'noop',
  'http',
  'branch',
  'transform',
  'assert',
  'delay',
  'shell',
  'email',
  'storage_put',
  'storage_get',
  'webhook',
  'subtask',
] as const;

export type StepKind = (typeof STEP_KINDS)[number];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const BACKOFF_STRATEGIES = ['fixed', 'linear', 'exponential'] as const;
export type BackoffStrategy = (typeof BACKOFF_STRATEGIES)[number];

export interface RetryPolicy {
  readonly max_attempts: number;
  readonly backoff: BackoffStrategy;
  readonly base_ms: number;
  readonly max_ms: number;
  /** Full jitter. On by default: without it, N retrying steps stay synchronised forever. */
  readonly jitter: boolean;
}

export const DEFAULT_RETRY: RetryPolicy = {
  max_attempts: 3,
  backoff: 'exponential',
  base_ms: 1000,
  max_ms: 60_000,
  jitter: true,
};

/**
 * A capture rule lifts a value out of a step's result into a named variable, so later steps can
 * reference `{{ vars.NAME }}` instead of repeating a long path.
 */
export interface CaptureRule {
  readonly name: string;
  /** An expression evaluated against the step's own result scope. */
  readonly from: string;
  /** When the expression resolves to nothing: fail the step, or store null. */
  readonly on_missing?: 'fail' | 'null';
}

/** What to do when a step errors: stop the run, carry on, or jump to a named step. */
export type OnError = 'fail' | 'continue' | { readonly goto: string };

interface StepCommon {
  readonly key: string;
  readonly name?: string;
  readonly next?: string | null;
  readonly on_error?: OnError;
  readonly retry?: RetryPolicy;
  readonly timeout_ms?: number;
  readonly capture?: readonly CaptureRule[];
  /** Expression gate. When present and falsy, the step is skipped (recorded as `skipped`). */
  readonly if?: string;
  /**
   * Whether re-running this step is safe.
   *
   * Delivery is at-least-once (see tech-spec §5), so a step that is NOT idempotent must not be
   * auto-retried after an ambiguous failure — a timeout on a POST that may have succeeded is the
   * canonical case. Defaults per kind: reads true, writes false.
   */
  readonly idempotent?: boolean;
}

export interface NoopStep extends StepCommon {
  readonly kind: 'noop';
}

export interface HttpStep extends StepCommon {
  readonly kind: 'http';
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** 'json' sets Content-Type and serialises; 'text' and 'form' send as given. */
  readonly body_type?: 'json' | 'text' | 'form' | 'none';
  /** Name of a saved connection supplying auth. */
  readonly connection?: string;
  readonly follow_redirects?: boolean;
  readonly max_redirects?: number;
  /** Status codes treated as success. Defaults to 2xx. */
  readonly expect_status?: readonly number[];
}

export interface BranchCase {
  /** Expression. The first case that evaluates truthy wins. */
  readonly when: string;
  readonly goto: string;
}

export interface BranchStep extends StepCommon {
  readonly kind: 'branch';
  readonly cases: readonly BranchCase[];
  /** Where to go when no case matched. null terminates the run. */
  readonly otherwise?: string | null;
}

export interface TransformStep extends StepCommon {
  readonly kind: 'transform';
  /** Named expressions, each stored into vars under its key. */
  readonly set: Readonly<Record<string, string>>;
}

export interface AssertStep extends StepCommon {
  readonly kind: 'assert';
  readonly condition: string;
  readonly message?: string;
}

export interface DelayStep extends StepCommon {
  readonly kind: 'delay';
  /** Literal milliseconds, or an expression resolving to a number. */
  readonly ms: number | string;
}

export interface ShellStep extends StepCommon {
  readonly kind: 'shell';
  /**
   * argv, never a shell string. There is no shell, so there is nothing to inject into:
   * `["git", "status"]`, not `"git status"`.
   */
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Non-zero exit fails the step unless this lists the code as acceptable. */
  readonly allow_exit_codes?: readonly number[];
}

export interface EmailStep extends StepCommon {
  readonly kind: 'email';
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly reply_to?: string;
}

export interface StoragePutStep extends StepCommon {
  readonly kind: 'storage_put';
  readonly key: string;
  /** Literal content, or an expression resolving to it. */
  readonly content: string;
  readonly content_type?: string;
}

export interface StorageGetStep extends StepCommon {
  readonly kind: 'storage_get';
  readonly key: string;
  readonly as?: 'text' | 'json';
}

export interface WebhookStep extends StepCommon {
  readonly kind: 'webhook';
  readonly endpoint: string;
  readonly event: string;
  readonly payload?: unknown;
}

export interface SubtaskStep extends StepCommon {
  readonly kind: 'subtask';
  readonly task_id: string;
  readonly vars?: Readonly<Record<string, unknown>>;
  /** Wait for the child to finish and capture its result, or fire and forget. */
  readonly wait?: boolean;
}

export type Step =
  | NoopStep
  | HttpStep
  | BranchStep
  | TransformStep
  | AssertStep
  | DelayStep
  | ShellStep
  | EmailStep
  | StoragePutStep
  | StorageGetStep
  | WebhookStep
  | SubtaskStep;

export interface TaskGraph {
  readonly version: 1;
  readonly entry: string;
  readonly steps: readonly Step[];
  readonly defaults?: {
    readonly timeout_ms?: number;
    readonly retry?: RetryPolicy;
  };
  /** Task-level variables, available as `{{ vars.NAME }}` from the first step. */
  readonly vars?: Readonly<Record<string, unknown>>;
}

/** Steps that write something outward. Default `idempotent: false` — never auto-retried blindly. */
const WRITE_KINDS: ReadonlySet<StepKind> = new Set<StepKind>([
  'email',
  'webhook',
  'storage_put',
  'shell',
  'subtask',
]);

export function defaultIdempotent(kind: StepKind): boolean {
  return !WRITE_KINDS.has(kind);
}

export function isIdempotent(step: Step): boolean {
  return step.idempotent ?? defaultIdempotent(step.kind);
}

/** Every step key a given step can hand control to. Used by cycle and reachability checks. */
export function outgoingTargets(step: Step): string[] {
  const out: string[] = [];
  if (typeof step.next === 'string') out.push(step.next);

  if (step.on_error !== undefined && typeof step.on_error === 'object') {
    out.push(step.on_error.goto);
  }

  if (step.kind === 'branch') {
    for (const c of step.cases) out.push(c.goto);
    if (typeof step.otherwise === 'string') out.push(step.otherwise);
  }

  return out;
}

export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'skipped',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'skipped',
]);

export const isTerminalRunStatus = (s: RunStatus): boolean => TERMINAL_RUN_STATUSES.has(s);

export const STEP_RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'timed_out',
] as const;
export type StepRunStatus = (typeof STEP_RUN_STATUSES)[number];

export const RUN_TRIGGERS = ['schedule', 'manual', 'api', 'webhook', 'retry', 'subtask'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const TASK_STATUSES = ['active', 'paused', 'archived'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CONCURRENCY_POLICIES = ['skip', 'queue', 'allow'] as const;
export type ConcurrencyPolicy = (typeof CONCURRENCY_POLICIES)[number];

export const SCHEDULE_KINDS = ['cron', 'interval', 'once', 'manual', 'webhook'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/**
 * Allowed run-status transitions. The DB enforces the type; the service enforces the transitions.
 * Client-sent status is always untrusted and validated against this map.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ['running', 'cancelled', 'skipped'],
  // A running run can go back to queued: that is the reaper recovering a dead worker's lease.
  running: ['succeeded', 'failed', 'cancelled', 'timed_out', 'queued'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  skipped: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}
