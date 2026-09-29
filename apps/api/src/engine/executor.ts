import {
  evaluateBoolean,
  evaluate,
  ExprError,
  interpolateValue,
  parse,
  type ExprValue,
} from '@klankish/expr';
import {
  applyRetryAfter,
  computeBackoffMs,
  DEFAULT_RETRY,
  ERROR_CODES,
  isIdempotent,
  newId,
  redact,
  shouldRetry,
  type FailureKind,
  type Step,
  type StepRunStatus,
} from '@klankish/shared';

import { query } from '../db/client.js';
import { env } from '../platform/env.js';
import { subLogger } from '../platform/logger.js';
import { RunContext, type StepResult } from './context.js';
import { queue } from './queue.js';
import { executeHttp, StepError } from './steps/http.js';
import { executeShell } from './steps/shell.js';

/**
 * The DAG executor.
 *
 * One rule governs the shape of this file: **a step's record is persisted BEFORE the next step
 * starts.** That is what makes a crash mid-run inspectable rather than a mystery, and it is why
 * the loop writes to the database at every iteration instead of batching at the end.
 *
 * Execution order per step:
 *   1. evaluate `if` gate            → maybe skip
 *   2. interpolate the config        → resolved input (secrets redacted for storage)
 *   3. execute with a timeout        → result
 *   4. apply capture rules           → vars
 *   5. persist the step_run          → THE RECORD
 *   6. choose the next step          → branch / next / on_error
 */

const log = subLogger('executor');

export interface ExecuteResult {
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
  readonly error?: { identity: string; message: string };
  readonly stepsRun: number;
}

/** Guards against a graph that legitimately validates but loops via retries or long chains. */
const MAX_STEPS_PER_RUN = 1000;

export async function executeRun(ctx: RunContext): Promise<ExecuteResult> {
  const runStart = Date.now();
  const runTimeout = ctx.graph.defaults?.timeout_ms ?? env.RUN_DEFAULT_TIMEOUT_MS;

  let currentKey: string | null = ctx.graph.entry;
  let stepsRun = 0;

  while (currentKey !== null) {
    // --- run-level guards, checked BETWEEN steps ---
    // Cancellation is cooperative for exactly this reason: stopping mid-step would leave a
    // half-written record, which is the thing this product exists to prevent.
    if (await queue.isCancelRequested(ctx.run.id)) {
      log.info({ run_id: ctx.run.id }, 'run cancelled');
      return { status: 'cancelled', stepsRun };
    }

    if (Date.now() - runStart > runTimeout) {
      return {
        status: 'timed_out',
        error: {
          identity: ERROR_CODES.RUN_TIMEOUT,
          message: `The run exceeded its ${runTimeout}ms budget.`,
        },
        stepsRun,
      };
    }

    if (stepsRun >= MAX_STEPS_PER_RUN) {
      return {
        status: 'failed',
        error: {
          identity: ERROR_CODES.GRAPH_HAS_CYCLE,
          message: `The run executed more than ${MAX_STEPS_PER_RUN} steps and was stopped.`,
        },
        stepsRun,
      };
    }

    const step: Step | undefined = ctx.getStep(currentKey);
    if (step === undefined) {
      // Graph validation should have caught this at save time; reaching it means something
      // bypassed validation, so fail loudly rather than silently ending the run.
      return {
        status: 'failed',
        error: {
          identity: ERROR_CODES.GRAPH_UNKNOWN_STEP,
          message: `Step "${currentKey}" does not exist in this task.`,
        },
        stepsRun,
      };
    }

    const outcome = await runStep(step, ctx);
    stepsRun += 1;

    if (outcome.terminal !== undefined) return { ...outcome.terminal, stepsRun };
    currentKey = outcome.next;
  }

  return { status: 'succeeded', stepsRun };
}

interface StepOutcome {
  readonly next: string | null;
  readonly terminal?: { status: 'failed' | 'timed_out'; error: { identity: string; message: string } };
}

async function runStep(step: Step, ctx: RunContext): Promise<StepOutcome> {
  const idx = ctx.nextIndex();
  const stepRunId = newId('step_run');
  const startedAt = new Date();

  // --- 1. the `if` gate ---
  if (step.if !== undefined && step.if !== '') {
    let gate: boolean;
    try {
      gate = evaluateBoolean(step.if, ctx.scope);
    } catch (err) {
      return persistAndDecide(
        step,
        ctx,
        stepRunId,
        idx,
        startedAt,
        null,
        {
          status: 'failed',
          output: null,
          error: {
            identity: ERROR_CODES.INVALID_EXPRESSION,
            message: `The condition on "${step.key}" could not be evaluated.`,
            detail: err instanceof Error ? err.message : String(err),
          },
        },
      );
    }

    if (!gate) {
      // A skipped step is RECORDED, not omitted. "This step did not run, and here is why" is a
      // fact the reader needs; a gap in the timeline is not.
      return persistAndDecide(step, ctx, stepRunId, idx, startedAt, null, {
        status: 'skipped',
        output: null,
      });
    }
  }

  // --- 2. interpolate ---
  let resolved: Record<string, unknown>;
  const usedSecrets: string[] = [];
  try {
    resolved = interpolateValue(
      step as unknown as ExprValue,
      ctx.scope,
      {
        strict: true,
        onSecretUsed: (name, value) => {
          usedSecrets.push(name);
          // Registering the literal value is what lets redaction catch it later wherever it
          // ends up — inside a URL, or echoed back in a response body.
          if (value !== '') ctx.secretValues.add(value);
        },
      },
    ) as Record<string, unknown>;
  } catch (err) {
    const isExpr = err instanceof ExprError;
    return persistAndDecide(step, ctx, stepRunId, idx, startedAt, null, {
      status: 'failed',
      output: null,
      error: {
        identity: isExpr ? ERROR_CODES.INTERPOLATION_FAILED : ERROR_CODES.INVALID_EXPRESSION,
        message: `A value referenced by "${step.key}" could not be resolved.`,
        detail: err instanceof Error ? err.message : String(err),
      },
    });
  }

  // --- 3. execute, with retries ---
  const policy = step.retry ?? ctx.graph.defaults?.retry ?? DEFAULT_RETRY;
  const timeout = step.timeout_ms ?? ctx.graph.defaults?.timeout_ms ?? env.STEP_DEFAULT_TIMEOUT_MS;
  const idempotent = isIdempotent(step);

  let result: StepResult = { status: 'failed', output: null };
  let attempt = 1;

  for (;;) {
    try {
      result = await dispatch(step, resolved, ctx, timeout);
    } catch (err) {
      result = {
        status: 'failed',
        output: null,
        error:
          err instanceof StepError
            ? { identity: err.identity, message: err.message, ...(err.detail !== undefined && { detail: err.detail }) }
            : {
                identity: ERROR_CODES.STEP_FAILED,
                message: `Step "${step.key}" failed.`,
                detail: err instanceof Error ? err.message : String(err),
              },
      };
    }

    if (result.status === 'succeeded' || result.status === 'skipped') break;

    const failureKind = classifyFailure(result);
    if (!shouldRetry({ policy, attempt, idempotent, failure: failureKind })) break;

    let delay = computeBackoffMs({ policy, attempt });
    // Honour an upstream Retry-After when it asks for longer than our own backoff.
    const retryAfter = extractRetryAfter(result);
    if (retryAfter !== null) delay = applyRetryAfter(delay, retryAfter);

    log.info(
      { run_id: ctx.run.id, step: step.key, attempt, delay_ms: delay, kind: failureKind },
      'retrying step',
    );

    await sleep(delay);
    attempt += 1;
  }

  // --- 4. capture rules ---
  if (result.status === 'succeeded' && step.capture !== undefined) {
    // Publish this step's own result first so a capture rule can reference `steps.<key>.output`.
    ctx.recordStep(step.key, result);

    for (const rule of step.capture) {
      try {
        const value = evaluate(parse(rule.from), ctx.scope);
        if (value === undefined && rule.on_missing === 'fail') {
          result = {
            status: 'failed',
            output: result.output,
            error: {
              identity: ERROR_CODES.INTERPOLATION_FAILED,
              message: `Could not capture "${rule.name}": ${rule.from} resolved to nothing.`,
            },
          };
          break;
        }
        ctx.setVar(rule.name, value ?? null);
      } catch (err) {
        result = {
          status: 'failed',
          output: result.output,
          error: {
            identity: ERROR_CODES.INVALID_EXPRESSION,
            message: `Could not capture "${rule.name}".`,
            detail: err instanceof Error ? err.message : String(err),
          },
        };
        break;
      }
    }
  }

  return persistAndDecide(step, ctx, stepRunId, idx, startedAt, resolved, result, attempt);
}

/** Dispatch to the right handler. Exhaustive: a new kind fails to compile until handled. */
async function dispatch(
  step: Step,
  resolved: Record<string, unknown>,
  ctx: RunContext,
  timeout: number,
): Promise<StepResult> {
  switch (step.kind) {
    case 'noop':
      return { status: 'succeeded', output: null };

    case 'http':
      return executeHttp(step, resolved, ctx, timeout);

    case 'shell':
      return executeShell(step, resolved, timeout);

    case 'delay': {
      const raw = resolved['ms'] ?? step.ms;
      const ms = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
      if (!Number.isFinite(ms) || ms < 0) {
        throw new StepError(ERROR_CODES.VALIDATION_ERROR, `"${String(raw)}" is not a valid delay.`);
      }
      // Capped at the step timeout so a delay cannot outlive the lease that protects the run.
      await sleep(Math.min(ms, timeout));
      return { status: 'succeeded', output: { waited_ms: Math.min(ms, timeout) } };
    }

    case 'branch': {
      for (const [i, branchCase] of step.cases.entries()) {
        let matched: boolean;
        try {
          matched = evaluateBoolean(branchCase.when, ctx.scope);
        } catch (err) {
          throw new StepError(
            ERROR_CODES.INVALID_EXPRESSION,
            `Condition ${i + 1} on "${step.key}" could not be evaluated.`,
            err instanceof Error ? err.message : String(err),
          );
        }
        if (matched) {
          // Recording WHICH condition matched, not just where it went, is what makes a branch
          // debuggable months later.
          return {
            status: 'succeeded',
            output: { matched: true, case_index: i, condition: branchCase.when },
            nextStepKey: branchCase.goto,
          };
        }
      }
      return {
        status: 'succeeded',
        output: { matched: false },
        nextStepKey: step.otherwise ?? null,
      };
    }

    case 'transform': {
      const out: Record<string, ExprValue> = {};
      for (const [name, expression] of Object.entries(step.set)) {
        try {
          const value = evaluate(parse(expression), ctx.scope);
          out[name] = value ?? null;
          ctx.setVar(name, value ?? null);
        } catch (err) {
          throw new StepError(
            ERROR_CODES.INVALID_EXPRESSION,
            `Could not compute "${name}" in step "${step.key}".`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return { status: 'succeeded', output: out };
    }

    case 'assert': {
      let held: boolean;
      try {
        held = evaluateBoolean(step.condition, ctx.scope);
      } catch (err) {
        throw new StepError(
          ERROR_CODES.INVALID_EXPRESSION,
          `The assertion in "${step.key}" could not be evaluated.`,
          err instanceof Error ? err.message : String(err),
        );
      }
      if (!held) {
        return {
          status: 'failed',
          output: { held: false, condition: step.condition },
          error: {
            identity: ERROR_CODES.ASSERTION_FAILED,
            message: step.message ?? `The check in "${step.key}" did not hold.`,
            detail: step.condition,
          },
        };
      }
      return { status: 'succeeded', output: { held: true } };
    }

    // These need integrations that land in the next phase. Failing with a truthful identity beats
    // pretending to succeed.
    case 'email':
    case 'storage_put':
    case 'storage_get':
    case 'webhook':
    case 'subtask':
      throw new StepError(
        ERROR_CODES.STEP_FAILED,
        `Steps of kind "${step.kind}" are not available yet on this instance.`,
      );

    default: {
      const never: never = step;
      throw new StepError(
        ERROR_CODES.STEP_FAILED,
        `Unknown step kind: ${JSON.stringify(never)}`,
      );
    }
  }
}

/**
 * Persist the step_run, then decide where to go next.
 *
 * Both halves live together because the ordering matters: the record is written FIRST, so a crash
 * immediately afterwards still leaves a complete account of what happened.
 */
async function persistAndDecide(
  step: Step,
  ctx: RunContext,
  stepRunId: string,
  idx: number,
  startedAt: Date,
  resolvedInput: Record<string, unknown> | null,
  result: StepResult,
  attempt = 1,
): Promise<StepOutcome> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  if (result.status !== 'skipped') ctx.recordStep(step.key, result);

  // Decide the next step BEFORE writing, so `next_step_key` lands in the same row.
  let next: string | null;
  let terminal: StepOutcome['terminal'];

  if (result.status === 'succeeded' || result.status === 'skipped') {
    next = result.nextStepKey !== undefined ? result.nextStepKey : (step.next ?? null);
  } else {
    const onError = step.on_error ?? 'fail';
    if (onError === 'continue') {
      next = step.next ?? null;
    } else if (typeof onError === 'object') {
      next = onError.goto;
    } else {
      next = null;
      terminal = {
        status: result.status === 'timed_out' ? 'timed_out' : 'failed',
        error: {
          identity: result.error?.identity ?? ERROR_CODES.STEP_FAILED,
          message: result.error?.message ?? `Step "${step.key}" failed.`,
        },
      };
    }
  }

  const dbStatus: StepRunStatus =
    result.status === 'succeeded'
      ? 'succeeded'
      : result.status === 'skipped'
        ? 'skipped'
        : result.status === 'timed_out'
          ? 'timed_out'
          : 'failed';

  // Redaction, by name AND by value, applied to everything that touches the database.
  const redactOpts = { values: ctx.secretValues };

  await query(
    `INSERT INTO step_runs (
       id, run_id, idx, step_key, step_name, step_kind, status, attempt,
       started_at, finished_at, duration_ms, input, output, error, next_step_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      stepRunId,
      ctx.run.id,
      idx,
      step.key,
      step.name ?? null,
      step.kind,
      dbStatus,
      attempt,
      startedAt.toISOString(),
      finishedAt.toISOString(),
      durationMs,
      resolvedInput === null ? null : JSON.stringify(redact(resolvedInput, redactOpts)),
      result.output === undefined ? null : JSON.stringify(redact(result.output, redactOpts)),
      result.error === undefined ? null : JSON.stringify(redact(result.error, redactOpts)),
      next,
    ],
  );

  if (result.http !== undefined) {
    await query(
      `INSERT INTO http_exchanges (
         id, step_run_id, request_method, request_url, request_headers, request_body,
         response_status, response_headers, response_body_inline, bytes, truncated, duration_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        newId('http_exchange'),
        stepRunId,
        result.http.request_method,
        result.http.request_url,
        JSON.stringify(result.http.request_headers),
        JSON.stringify(redact(result.http.request_body, redactOpts)),
        result.http.response_status,
        JSON.stringify(redact(result.http.response_headers, redactOpts)),
        JSON.stringify(redact(result.http.response_body, redactOpts)),
        result.http.bytes,
        result.http.truncated,
        result.http.duration_ms,
      ],
    );
  }

  return terminal === undefined ? { next } : { next: null, terminal };
}

/** Map a failure to a retry class. The distinction that matters is ambiguity, not severity. */
function classifyFailure(result: StepResult): FailureKind {
  if (result.status === 'timed_out') return 'timeout';

  const identity = result.error?.identity;
  switch (identity) {
    case ERROR_CODES.ASSERTION_FAILED:
    case ERROR_CODES.INVALID_EXPRESSION:
    case ERROR_CODES.INTERPOLATION_FAILED:
    case ERROR_CODES.VALIDATION_ERROR:
    case ERROR_CODES.SHELL_DISABLED:
    case ERROR_CODES.SHELL_BINARY_NOT_ALLOWED:
    case ERROR_CODES.SHELL_PATH_ESCAPE:
    case ERROR_CODES.HTTP_BLOCKED_TARGET:
      // Identical input would fail identically. Retrying only wastes time.
      return 'deterministic';
    case ERROR_CODES.STEP_TIMEOUT:
      return 'timeout';
    default:
      break;
  }

  const status = (result.output as { status?: number } | null)?.status;
  if (typeof status === 'number') {
    if (status === 429 || status === 503) return 'throttled';
    if (status >= 500) return 'server';
    if (status >= 400) return 'client';
  }

  // No HTTP status at all usually means the connection never completed, which is safely
  // replayable even for a non-idempotent step.
  return 'network';
}

function extractRetryAfter(result: StepResult): number | null {
  const headers = result.http?.response_headers;
  if (headers === undefined) return null;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
