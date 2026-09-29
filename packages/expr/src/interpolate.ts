import { evaluate } from './evaluator.js';
import { parse } from './parser.js';
import { ExprError, EXPR_ERRORS, type EvalLimits, type ExprValue } from './types.js';

/**
 * `{{ ... }}` template interpolation over a read-only scope.
 *
 * Two behaviours, and the distinction matters:
 *
 *   1. A string that is EXACTLY one placeholder returns the extracted value with its type intact.
 *      `"{{ steps.a.output.count }}"` yields the number 42, not the string "42". This is what lets
 *      a captured number go into a JSON body as a number.
 *
 *   2. A placeholder embedded in surrounding text stringifies.
 *      `"count is {{ ... }}"` yields "count is 42".
 *
 * Unresolved paths are an ERROR by default (`strictPaths`), not silent undefined — substituting
 * `undefined` into an outbound API call is how you corrupt a downstream system, and it is exactly
 * the failure this engine exists to make visible.
 */

const PLACEHOLDER = /\{\{([^}]*)\}\}/g;
/** A string that is nothing but one placeholder, so the extracted type can be preserved. */
const SOLE_PLACEHOLDER = /^\s*\{\{([^}]*)\}\}\s*$/;

export interface InterpolateOptions {
  readonly limits?: EvalLimits;
  readonly nowMs?: number;
  /** Default true. Set false only where a missing value is genuinely acceptable. */
  readonly strict?: boolean;
  /**
   * Called with every value pulled from a `secrets.*` path so the caller can record which secrets
   * a step used, and — more importantly — so the engine knows which literal strings must be
   * redacted before the resolved input is persisted.
   */
  readonly onSecretUsed?: (name: string, value: string) => void;
}

/** Cache parsed ASTs across a run: the same template is often interpolated many times. */
const astCache = new Map<string, ReturnType<typeof parse>>();
const AST_CACHE_MAX = 500;

function parseCached(src: string): ReturnType<typeof parse> {
  const hit = astCache.get(src);
  if (hit !== undefined) return hit;
  const ast = parse(src);
  // Crude bound rather than a real LRU: this cache exists to avoid re-parsing within a run, and an
  // unbounded Map keyed by user input is a slow leak in a long-lived worker.
  if (astCache.size >= AST_CACHE_MAX) astCache.clear();
  astCache.set(src, ast);
  return ast;
}

function evalOne(
  src: string,
  scope: Readonly<Record<string, ExprValue>>,
  opts: InterpolateOptions,
): ExprValue {
  const trimmed = src.trim();
  if (trimmed === '') {
    throw new ExprError(EXPR_ERRORS.SYNTAX, 'Empty placeholder: {{ }} has nothing in it.');
  }
  const ast = parseCached(trimmed);
  const value = evaluate(ast, scope, {
    ...(opts.limits !== undefined && { limits: opts.limits }),
    ...(opts.nowMs !== undefined && { nowMs: opts.nowMs }),
    strictPaths: opts.strict ?? true,
  });

  // Report secret usage so the caller can redact. Only a direct `secrets.NAME` read is reported;
  // a secret that has been through a function is no longer the literal value.
  if (opts.onSecretUsed !== undefined && ast.t === 'path') {
    const first = ast.segs[0];
    const second = ast.segs[1];
    if (
      first !== undefined &&
      first.k === 'prop' &&
      first.name === 'secrets' &&
      second !== undefined &&
      second.k === 'prop' &&
      typeof value === 'string'
    ) {
      opts.onSecretUsed(second.name, value);
    }
  }

  return value;
}

function stringify(v: ExprValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v) ?? '';
  return String(v);
}

/** Interpolate a single string. Returns a non-string when the input was one sole placeholder. */
export function interpolateString(
  template: string,
  scope: Readonly<Record<string, ExprValue>>,
  opts: InterpolateOptions = {},
): ExprValue {
  const sole = SOLE_PLACEHOLDER.exec(template);
  if (sole !== null) {
    const inner = sole[1];
    if (inner === undefined) return template;
    return evalOne(inner, scope, opts);
  }

  if (!template.includes('{{')) return template;

  // replace() with a function, rather than manual scanning, so overlapping/adjacent placeholders
  // behave predictably.
  return template.replace(PLACEHOLDER, (_m, inner: string) =>
    stringify(evalOne(inner, scope, opts)),
  );
}

/**
 * Walk any JSON-shaped value and interpolate every string in it, including object KEYS — a header
 * name or query-param name can legitimately be templated.
 *
 * Depth-capped: a deeply nested step config should not be able to blow the stack.
 */
export function interpolateValue(
  value: ExprValue,
  scope: Readonly<Record<string, ExprValue>>,
  opts: InterpolateOptions = {},
  depth = 0,
): ExprValue {
  if (depth > 64) {
    throw new ExprError(EXPR_ERRORS.TOO_COMPLEX, 'Step configuration is nested too deeply.');
  }

  if (typeof value === 'string') return interpolateString(value, scope, opts);

  if (Array.isArray(value)) {
    return value.map((v) => interpolateValue(v, scope, opts, depth + 1));
  }

  if (value !== null && value !== undefined && typeof value === 'object') {
    const out: Record<string, ExprValue> = {};
    for (const [k, v] of Object.entries(value)) {
      const ik = typeof k === 'string' ? interpolateString(k, scope, opts) : k;
      out[stringify(ik)] = interpolateValue(v, scope, opts, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Collect every placeholder expression in a value without evaluating any of them.
 *
 * Used by task-graph validation at save time: it is how the builder can tell you that a step
 * references `steps.fetch_user` when no such step exists, before the task ever runs.
 */
export function collectReferences(value: ExprValue, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER)) {
      const inner = m[1];
      if (inner !== undefined && inner.trim() !== '') out.add(inner.trim());
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectReferences(v, out);
    return out;
  }
  if (value !== null && value !== undefined && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      collectReferences(k, out);
      collectReferences(v, out);
    }
  }
  return out;
}

/**
 * Root path names a reference starts from, e.g. `steps.a.output.x` -> "steps".
 * Returns null when the expression is not a plain path (a call, a comparison, a literal).
 */
export function referenceRoot(expr: string): { root: string; second: string | null } | null {
  try {
    const ast = parse(expr);
    if (ast.t !== 'path') return null;
    const first = ast.segs[0];
    if (first === undefined || first.k !== 'prop') return null;
    const second = ast.segs[1];
    return {
      root: first.name,
      second: second !== undefined && second.k === 'prop' ? second.name : null,
    };
  } catch {
    return null;
  }
}
