/**
 * @klankish/expr — the expression and interpolation language for task graphs.
 *
 * Zero dependencies, no `eval`, no `new Function`. This package is the only place user-authored
 * input is interpreted, so it is deliberately small, fully unit-tested, and its grammar is frozen
 * in docs/tech-spec.md §6.
 */

export { parse } from './parser.js';
export { tokenize } from './lexer.js';
export { evaluate, type EvalOptions } from './evaluator.js';
export { truthy, FUNCTIONS } from './functions.js';
export {
  interpolateString,
  interpolateValue,
  collectReferences,
  referenceRoot,
  type InterpolateOptions,
} from './interpolate.js';
export {
  ExprError,
  EXPR_ERRORS,
  DEFAULT_LIMITS,
  type ExprErrorIdentity,
  type EvalLimits,
  type ExprValue,
  type Node,
  type PathSeg,
  type BinaryOp,
  type UnaryOp,
} from './types.js';

import { evaluate } from './evaluator.js';
import { truthy } from './functions.js';
import { parse } from './parser.js';
import type { EvalOptions } from './evaluator.js';
import type { ExprValue } from './types.js';

/**
 * Parse + evaluate + coerce to boolean, in one call.
 *
 * This is what `branch`, `assert` and a step's `if` gate use. It exists so those three call sites
 * cannot disagree about what "truthy" means.
 */
export function evaluateBoolean(
  source: string,
  scope: Readonly<Record<string, ExprValue>>,
  opts: EvalOptions = {},
): boolean {
  return truthy(evaluate(parse(source), scope, opts));
}

/**
 * Check an expression compiles, without running it. Used by the API when a task graph is saved, so
 * a syntax error is caught at save time rather than at 3am when the schedule fires.
 */
export function validateExpression(source: string): { ok: true } | { ok: false; error: string } {
  try {
    parse(source);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
