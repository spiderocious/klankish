/**
 * Wire types — the exact shapes crossing the API boundary.
 *
 * The frontend imports these directly, so a field renamed here is a compile error there rather
 * than a runtime surprise. That is the entire mitigation for contract drift, which is the single
 * most common silent bug at this seam.
 *
 * CASING: snake_case throughout, including the pagination meta (`next_cursor`, `has_more`) and the
 * error envelope. The ONE deliberate exception is the contents of a captured step `output`, whose
 * keys are whatever the upstream API returned — we do not rewrite a third party's response shape.
 */

import type { Permission, Role, UserStatus } from './rbac.js';
import type {
  ConcurrencyPolicy,
  RunStatus,
  RunTrigger,
  ScheduleKind,
  StepKind,
  StepRunStatus,
  TaskGraph,
  TaskStatus,
} from './graph.js';

export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  readonly status: UserStatus;
  readonly timezone: string;
  readonly last_login_at: string | null;
  readonly created_at: string;
}

export interface MeView extends UserView {
  readonly permissions: readonly Permission[];
}

export interface SessionView {
  readonly id: string;
  readonly user_agent: string | null;
  readonly ip: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly is_current: boolean;
}

export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  /** The visible portion, e.g. `klk_a1b2c3`. The full key is shown once, at creation, only. */
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly last_used_at: string | null;
  readonly expires_at: string | null;
  readonly created_at: string;
}

export interface ApiKeyCreatedView extends ApiKeyView {
  /** Present exactly once, in the creation response. Never retrievable afterwards. */
  readonly key: string;
}

export interface TaskView {
  readonly id: string;
  readonly owner_id: string;
  readonly owner_name?: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly status: TaskStatus;
  readonly tags: readonly string[];
  readonly concurrency_policy: ConcurrencyPolicy;
  readonly max_concurrent_runs: number;
  readonly timeout_ms: number | null;
  readonly current_version: number;
  readonly step_count: number;
  readonly schedule: ScheduleView | null;
  readonly stats: TaskStats | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TaskDetailView extends TaskView {
  readonly graph: TaskGraph;
}

export interface TaskStats {
  readonly runs_total: number;
  readonly runs_succeeded: number;
  readonly runs_failed: number;
  /** 0–1. Null when there are no runs yet — NOT 0, which would read as "always fails". */
  readonly success_rate: number | null;
  readonly p50_duration_ms: number | null;
  readonly p95_duration_ms: number | null;
  readonly last_run_at: string | null;
  readonly last_run_status: RunStatus | null;
  readonly consecutive_failures: number;
}

export interface TaskVersionView {
  readonly id: string;
  readonly version: number;
  readonly note: string | null;
  readonly created_by: string;
  readonly created_by_name: string | null;
  readonly created_at: string;
  readonly step_count: number;
}

export interface ScheduleView {
  readonly id: string;
  readonly kind: ScheduleKind;
  readonly cron_expr: string | null;
  readonly interval_ms: number | null;
  readonly run_at: string | null;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly jitter_ms: number;
  readonly next_fire_at: string | null;
  readonly last_fire_at: string | null;
  /** Human description, resolved server-side so the client does not reimplement cron parsing. */
  readonly description: string;
  /** Webhook-kind only. The secret is never included. */
  readonly webhook_url?: string;
}

export interface RunView {
  readonly id: string;
  readonly task_id: string;
  readonly task_name: string;
  readonly task_version: number;
  readonly trigger: RunTrigger;
  readonly status: RunStatus;
  readonly attempt: number;
  readonly scheduled_for: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly duration_ms: number | null;
  /**
   * Milliseconds between being due and being picked up. Surfaced deliberately: a growing value is
   * the earliest signal that workers are saturated.
   */
  readonly queue_latency_ms: number | null;
  readonly error_identity: string | null;
  readonly error_message: string | null;
  readonly step_count: number;
  readonly steps_succeeded: number;
  readonly steps_failed: number;
  readonly parent_run_id: string | null;
  readonly created_at: string;
}

export interface RunDetailView extends RunView {
  readonly steps: readonly StepRunView[];
  readonly vars: Readonly<Record<string, unknown>>;
}

export interface StepRunView {
  readonly id: string;
  readonly run_id: string;
  readonly idx: number;
  readonly step_key: string;
  readonly step_name: string | null;
  readonly step_kind: StepKind;
  readonly status: StepRunStatus;
  readonly attempt: number;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly duration_ms: number | null;
  /** Resolved input, secrets already redacted. Never the raw config. */
  readonly input: unknown;
  readonly output: unknown;
  readonly error: StepErrorView | null;
  /** What a branch decided. Null for non-branching steps. */
  readonly next_step_key: string | null;
  readonly http: HttpExchangeView | null;
}

export interface StepErrorView {
  readonly identity: string;
  readonly message: string;
  readonly detail?: string;
}

export interface HttpExchangeView {
  readonly request_method: string;
  readonly request_url: string;
  readonly request_headers: Readonly<Record<string, string>>;
  readonly request_body: unknown;
  readonly response_status: number | null;
  readonly response_headers: Readonly<Record<string, string>>;
  readonly response_body: unknown;
  /** Set when the body was too large to inline and was spilled to object storage. */
  readonly response_body_ref: string | null;
  readonly bytes: number;
  readonly duration_ms: number;
  readonly truncated: boolean;
}

export interface SecretView {
  readonly id: string;
  readonly name: string;
  /** NEVER the value. Not even for the owner: there is no endpoint that returns a plaintext. */
  readonly last_used_at: string | null;
  readonly key_version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ConnectionView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  /** Secret fields replaced with a placeholder. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface NotificationView {
  readonly id: string;
  readonly kind: string;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly read_at: string | null;
  readonly created_at: string;
}

export interface AuditLogView {
  readonly id: string;
  readonly actor_id: string | null;
  readonly actor_name: string | null;
  readonly actor_role: Role | null;
  readonly action: string;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly ip: string | null;
  readonly created_at: string;
}

export interface WorkerView {
  readonly id: string;
  readonly hostname: string;
  readonly role: string;
  readonly started_at: string;
  readonly last_heartbeat_at: string;
  readonly in_flight: number;
  readonly concurrency: number;
  /** Derived from heartbeat age, so the client does not reimplement the staleness rule. */
  readonly healthy: boolean;
}

export interface QueueStatsView {
  readonly queued: number;
  readonly running: number;
  readonly oldest_queued_at: string | null;
  readonly oldest_queued_age_ms: number | null;
  readonly stuck_leases: number;
  readonly scheduled_next_hour: number;
}

export interface DashboardView {
  readonly tasks_total: number;
  readonly tasks_active: number;
  readonly tasks_paused: number;
  readonly runs_today: number;
  readonly runs_succeeded_today: number;
  readonly runs_failed_today: number;
  readonly success_rate_today: number | null;
  readonly p95_duration_ms: number | null;
  readonly queue: QueueStatsView;
  readonly recent_runs: readonly RunView[];
  readonly failing_tasks: readonly TaskView[];
  readonly upcoming: readonly UpcomingFireView[];
}

export interface UpcomingFireView {
  readonly task_id: string;
  readonly task_name: string;
  readonly next_fire_at: string;
  readonly schedule_description: string;
}

export interface AdminOverviewView extends DashboardView {
  readonly users_total: number;
  readonly users_active: number;
  readonly users_suspended: number;
  readonly workers: readonly WorkerView[];
  readonly runs_last_24h: readonly HourBucket[];
}

export interface HourBucket {
  readonly hour: string;
  readonly succeeded: number;
  readonly failed: number;
  readonly other: number;
}
