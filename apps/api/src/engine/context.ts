import type { ExprValue } from '@klankish/expr';
import type { Step, TaskGraph } from '@klankish/shared';

import type { RunRow } from './queue.js';

/**
 * The scope a step's expressions and templates evaluate against.
 *
 * Deliberately a plain data object with no methods and no host access: whatever a user writes in
 * `{{ ... }}` can only reach what is placed here.
 */
export interface RunScope extends Record<string, ExprValue> {
  /** Results of completed steps, keyed by step key. */
  steps: Record<string, ExprValue>;
  /** Secrets resolved for this run. Redacted everywhere they are persisted. */
  secrets: Record<string, ExprValue>;
  /** Task-level vars plus anything captured by a `capture` rule or a transform step. */
  vars: Record<string, ExprValue>;
  run: Record<string, ExprValue>;
  task: Record<string, ExprValue>;
  now: Record<string, ExprValue>;
  /** Allow-listed environment only — never `process.env` wholesale. */
  env: Record<string, ExprValue>;
}

/**
 * Environment variables a step may read.
 *
 * An allow-list, not a filter: exposing `process.env` to a user-authored template would hand over
 * DATABASE_URL, JWT_SECRET and ENCRYPTION_KEY in one line.
 */
const EXPOSED_ENV_KEYS = ['NODE_ENV', 'DEPLOY_ENV', 'INSTANCE_NAME'] as const;

export interface StepResult {
  readonly status: 'succeeded' | 'failed' | 'skipped' | 'timed_out';
  readonly output: ExprValue;
  readonly error?: { identity: string; message: string; detail?: string };
  readonly nextStepKey?: string | null;
  /** Populated by http steps for the run record. */
  readonly http?: {
    request_method: string;
    request_url: string;
    request_headers: Record<string, string>;
    request_body: unknown;
    response_status: number | null;
    response_headers: Record<string, string>;
    response_body: unknown;
    bytes: number;
    duration_ms: number;
    truncated: boolean;
  };
}

/**
 * Everything one run needs while executing.
 *
 * `secretValues` is the set of literal secret strings resolved so far. It is what lets redaction
 * catch a secret that has MOVED — interpolated into a URL, or echoed back inside a response body
 * — which name-based redaction alone would miss entirely.
 */
export class RunContext {
  readonly scope: RunScope;
  readonly secretValues = new Set<string>();
  readonly stepsByKey: Map<string, Step>;

  private stepIndex = 0;

  constructor(
    readonly run: RunRow,
    readonly graph: TaskGraph,
    readonly task: { id: string; name: string; owner_id: string },
    secrets: Record<string, string> = {},
  ) {
    this.stepsByKey = new Map(graph.steps.map((s) => [s.key, s]));

    for (const value of Object.values(secrets)) {
      if (value !== '') this.secretValues.add(value);
    }

    const exposedEnv: Record<string, ExprValue> = {};
    for (const key of EXPOSED_ENV_KEYS) {
      const v = process.env[key];
      if (v !== undefined) exposedEnv[key] = v;
    }

    const now = new Date();
    this.scope = {
      steps: {},
      secrets: { ...secrets },
      vars: {
        ...((graph.vars ?? {}) as Record<string, ExprValue>),
        ...(run.vars as Record<string, ExprValue>),
      },
      run: {
        id: run.id,
        attempt: run.attempt,
        trigger: run.trigger,
        scheduled_for: run.scheduled_for,
      },
      task: { id: task.id, name: task.name },
      now: { iso: now.toISOString(), epoch_ms: now.getTime() },
      env: exposedEnv,
    };
  }

  nextIndex(): number {
    const i = this.stepIndex;
    this.stepIndex += 1;
    return i;
  }

  /** Publish a completed step's result so later steps can reference `steps.<key>.output`. */
  recordStep(key: string, result: StepResult): void {
    this.scope.steps[key] = {
      output: result.output,
      status: result.status,
      ...(result.error !== undefined && {
        error: { identity: result.error.identity, message: result.error.message },
      }),
    };
  }

  setVar(name: string, value: ExprValue): void {
    this.scope.vars[name] = value;
  }

  getStep(key: string): Step | undefined {
    return this.stepsByKey.get(key);
  }
}
