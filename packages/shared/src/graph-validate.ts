import { collectReferences, referenceRoot, validateExpression } from '@klankish/expr';

import { ERROR_CODES, type ErrorCode } from './errors.js';
import { outgoingTargets, type Step, type TaskGraph } from './graph.js';

/**
 * Task graph validation, run at SAVE time.
 *
 * The whole point is that a broken task is rejected when someone is looking at the screen, rather
 * than at 3am when the schedule fires and the only evidence is a failed run.
 *
 * Errors block the save. Warnings do not — an unreachable step is usually work in progress, and
 * refusing to save it would make the builder hostile to use.
 */

export interface GraphIssue {
  readonly code: ErrorCode;
  readonly message: string;
  /** Which step it concerns, when it concerns one. */
  readonly step_key?: string;
  readonly field?: string;
}

export interface GraphValidation {
  readonly ok: boolean;
  readonly errors: readonly GraphIssue[];
  readonly warnings: readonly GraphIssue[];
}

const STEP_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_STEPS = 200;

/** Scope roots a step expression may legitimately start from. */
const VALID_ROOTS = new Set(['steps', 'secrets', 'vars', 'run', 'task', 'now', 'env']);

export function validateGraph(
  graph: TaskGraph,
  opts: { readonly knownSecrets?: ReadonlySet<string> } = {},
): GraphValidation {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];

  if (!Array.isArray(graph.steps) || graph.steps.length === 0) {
    return {
      ok: false,
      errors: [{ code: ERROR_CODES.GRAPH_EMPTY, message: 'This task has no steps yet.' }],
      warnings: [],
    };
  }

  if (graph.steps.length > MAX_STEPS) {
    errors.push({
      code: ERROR_CODES.GRAPH_TOO_LARGE,
      message: `A task may have at most ${MAX_STEPS} steps (this one has ${graph.steps.length}).`,
    });
  }

  // --- keys: unique and well-formed ---
  const byKey = new Map<string, Step>();
  for (const step of graph.steps) {
    if (!STEP_KEY_RE.test(step.key)) {
      errors.push({
        code: ERROR_CODES.VALIDATION_ERROR,
        message:
          'A step key must be lowercase letters, numbers, dashes or underscores (max 64).',
        step_key: step.key,
        field: 'key',
      });
      continue;
    }
    if (byKey.has(step.key)) {
      errors.push({
        code: ERROR_CODES.GRAPH_DUPLICATE_KEY,
        message: `Two steps share the key "${step.key}". Keys must be unique.`,
        step_key: step.key,
        field: 'key',
      });
      continue;
    }
    byKey.set(step.key, step);
  }

  // --- entry exists ---
  if (typeof graph.entry !== 'string' || graph.entry === '') {
    errors.push({
      code: ERROR_CODES.GRAPH_NO_ENTRY,
      message: 'This task has no starting step.',
      field: 'entry',
    });
  } else if (!byKey.has(graph.entry)) {
    errors.push({
      code: ERROR_CODES.GRAPH_UNKNOWN_STEP,
      message: `The starting step "${graph.entry}" does not exist.`,
      field: 'entry',
    });
  }

  // --- every target resolves ---
  for (const step of byKey.values()) {
    for (const target of outgoingTargets(step)) {
      if (!byKey.has(target)) {
        errors.push({
          code: ERROR_CODES.GRAPH_UNKNOWN_STEP,
          message: `Step "${step.key}" points at "${target}", which does not exist.`,
          step_key: step.key,
        });
      }
    }
  }

  // --- expressions parse ---
  for (const step of byKey.values()) {
    for (const { expr, field } of expressionsOf(step)) {
      const res = validateExpression(expr);
      if (!res.ok) {
        errors.push({
          code: ERROR_CODES.INVALID_EXPRESSION,
          message: `In "${step.key}" (${field}): ${res.error}`,
          step_key: step.key,
          field,
        });
      }
    }
  }

  // --- interpolation references point somewhere real ---
  // This is the check that earns its keep: a typo'd step name in a template is otherwise invisible
  // until the run fails.
  for (const step of byKey.values()) {
    for (const ref of collectReferences(step as unknown as Parameters<typeof collectReferences>[0])) {
      const parsed = validateExpression(ref);
      if (!parsed.ok) {
        errors.push({
          code: ERROR_CODES.INVALID_EXPRESSION,
          message: `In "${step.key}": {{ ${ref} }} could not be parsed — ${parsed.error}`,
          step_key: step.key,
        });
        continue;
      }

      const root = referenceRoot(ref);
      if (root === null) continue; // a call or comparison, not a plain path

      if (!VALID_ROOTS.has(root.root)) {
        errors.push({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: `In "${step.key}": "${root.root}" is not something a step can read. Use one of: ${[...VALID_ROOTS].join(', ')}.`,
          step_key: step.key,
        });
        continue;
      }

      if (root.root === 'steps' && root.second !== null && !byKey.has(root.second)) {
        errors.push({
          code: ERROR_CODES.GRAPH_UNKNOWN_STEP,
          message: `In "${step.key}": references step "${root.second}", which does not exist.`,
          step_key: step.key,
        });
      }

      if (
        root.root === 'secrets' &&
        root.second !== null &&
        opts.knownSecrets !== undefined &&
        !opts.knownSecrets.has(root.second)
      ) {
        errors.push({
          code: ERROR_CODES.SECRET_NOT_FOUND,
          message: `In "${step.key}": no secret named "${root.second}".`,
          step_key: step.key,
        });
      }
    }
  }

  // --- cycles ---
  // Iterative DFS with an explicit stack. Recursion would be shorter, but a 200-step adversarial
  // graph should not be able to blow the call stack in the API process.
  const cycle = findCycle(byKey);
  if (cycle !== null) {
    errors.push({
      code: ERROR_CODES.GRAPH_HAS_CYCLE,
      message: `These steps loop back on themselves and would never finish: ${cycle.join(' → ')}.`,
      step_key: cycle[0] ?? '',
    });
  }

  // --- reachability (warning only) ---
  if (byKey.has(graph.entry)) {
    const reached = reachableFrom(graph.entry, byKey);
    for (const key of byKey.keys()) {
      if (!reached.has(key)) {
        warnings.push({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: `Step "${key}" can never be reached from the start.`,
          step_key: key,
        });
      }
    }
  }

  // --- per-kind checks ---
  for (const step of byKey.values()) {
    validateStepShape(step, errors, warnings);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Every expression a step carries, with the field it came from (for error messages). */
function expressionsOf(step: Step): Array<{ expr: string; field: string }> {
  const out: Array<{ expr: string; field: string }> = [];

  if (typeof step.if === 'string' && step.if !== '') out.push({ expr: step.if, field: 'if' });

  for (const rule of step.capture ?? []) {
    out.push({ expr: rule.from, field: `capture.${rule.name}` });
  }

  switch (step.kind) {
    case 'branch':
      step.cases.forEach((c, i) => out.push({ expr: c.when, field: `cases[${i}].when` }));
      break;
    case 'transform':
      for (const [name, expr] of Object.entries(step.set)) {
        out.push({ expr, field: `set.${name}` });
      }
      break;
    case 'assert':
      out.push({ expr: step.condition, field: 'condition' });
      break;
    case 'delay':
      if (typeof step.ms === 'string') out.push({ expr: step.ms, field: 'ms' });
      break;
    default:
      break;
  }

  return out;
}

function validateStepShape(step: Step, errors: GraphIssue[], warnings: GraphIssue[]): void {
  const bad = (message: string, field?: string): void => {
    errors.push({
      code: ERROR_CODES.VALIDATION_ERROR,
      message: `Step "${step.key}": ${message}`,
      step_key: step.key,
      ...(field !== undefined && { field }),
    });
  };

  if (step.timeout_ms !== undefined && (step.timeout_ms <= 0 || step.timeout_ms > 3_600_000)) {
    bad('timeout must be between 1ms and 1 hour.', 'timeout_ms');
  }

  if (step.retry !== undefined) {
    const r = step.retry;
    if (r.max_attempts < 1 || r.max_attempts > 20) {
      bad('retry attempts must be between 1 and 20.', 'retry.max_attempts');
    }
    if (r.base_ms < 0 || r.max_ms < r.base_ms) {
      bad('retry base delay must be positive and no greater than the max delay.', 'retry');
    }
  }

  switch (step.kind) {
    case 'http': {
      if (step.url.trim() === '') bad('a URL is required.', 'url');
      // A URL containing a placeholder can only be checked at run time, so only validate the
      // literal case here.
      if (!step.url.includes('{{')) {
        try {
          const u = new URL(step.url);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            bad('only http and https URLs are allowed.', 'url');
          }
        } catch {
          bad('that URL is not valid.', 'url');
        }
      }
      if (step.max_redirects !== undefined && (step.max_redirects < 0 || step.max_redirects > 10)) {
        bad('redirects must be between 0 and 10.', 'max_redirects');
      }
      break;
    }

    case 'branch': {
      if (step.cases.length === 0) bad('a branch needs at least one condition.', 'cases');
      if (step.otherwise === undefined) {
        warnings.push({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: `Step "${step.key}": no "otherwise" — the run stops if no condition matches.`,
          step_key: step.key,
          field: 'otherwise',
        });
      }
      break;
    }

    case 'shell': {
      if (step.command.length === 0) bad('a command is required.', 'command');
      const bin = step.command[0];
      if (bin !== undefined && bin.trim() === '') bad('the command cannot be blank.', 'command');
      break;
    }

    case 'email': {
      if (step.to.length === 0) bad('at least one recipient is required.', 'to');
      if (step.subject.trim() === '') bad('a subject is required.', 'subject');
      if (step.text === undefined && step.html === undefined) {
        bad('either text or html content is required.', 'text');
      }
      break;
    }

    case 'transform': {
      if (Object.keys(step.set).length === 0) bad('nothing to set.', 'set');
      break;
    }

    case 'delay': {
      if (typeof step.ms === 'number' && (step.ms < 0 || step.ms > 86_400_000)) {
        bad('a delay must be between 0 and 24 hours.', 'ms');
      }
      break;
    }

    case 'storage_put': {
      if (step.object_key.trim() === '') bad('a storage key is required.', 'object_key');
      break;
    }

    case 'storage_get': {
      if (step.object_key.trim() === '') bad('a storage key is required.', 'object_key');
      break;
    }

    case 'subtask': {
      if (step.task_id.trim() === '') bad('a task must be chosen.', 'task_id');
      break;
    }

    case 'webhook': {
      if (step.endpoint.trim() === '') bad('an endpoint is required.', 'endpoint');
      if (step.event.trim() === '') bad('an event name is required.', 'event');
      break;
    }

    case 'assert':
    case 'noop':
      break;

    default: {
      const never: never = step;
      void never;
      break;
    }
  }
}

/** Iterative DFS returning the first cycle found as a readable path, or null. */
function findCycle(byKey: ReadonlyMap<string, Step>): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const k of byKey.keys()) colour.set(k, WHITE);

  for (const start of byKey.keys()) {
    if (colour.get(start) !== WHITE) continue;

    const path: string[] = [];
    const stack: Array<{ key: string; targets: string[]; i: number }> = [];

    const push = (key: string): void => {
      colour.set(key, GREY);
      path.push(key);
      const step = byKey.get(key);
      stack.push({
        key,
        targets: step === undefined ? [] : outgoingTargets(step).filter((t) => byKey.has(t)),
        i: 0,
      });
    };

    push(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      if (frame.i >= frame.targets.length) {
        colour.set(frame.key, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      const next = frame.targets[frame.i];
      frame.i += 1;
      if (next === undefined) continue;

      const c = colour.get(next);
      if (c === GREY) {
        // Found it. Trim the path to start at the repeated node so the message reads as a loop.
        const from = path.indexOf(next);
        return [...path.slice(from), next];
      }
      if (c === WHITE) push(next);
    }
  }

  return null;
}

function reachableFrom(entry: string, byKey: ReadonlyMap<string, Step>): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    const step = byKey.get(key);
    if (step === undefined) continue;
    for (const t of outgoingTargets(step)) {
      if (!seen.has(t)) queue.push(t);
    }
  }
  return seen;
}
