import { ExprError, EXPR_ERRORS, type EvalLimits, type ExprValue } from './types.js';

/**
 * The built-in function table.
 *
 * Every function is a pure function of its arguments. None of them touch the host: no I/O, no
 * clock beyond the one `now()` value the evaluator is handed, no filesystem, no network. That
 * property is what makes the evaluator safe to run against user-authored input, so a new function
 * that breaks it does not belong here.
 */

export interface FnContext {
  readonly limits: EvalLimits;
  /** Fixed for the whole evaluation so two `now()` calls in one expression agree. */
  readonly nowMs: number;
}

type Fn = (args: readonly ExprValue[], ctx: FnContext) => ExprValue;

interface FnDef {
  readonly minArgs: number;
  readonly maxArgs: number;
  readonly fn: Fn;
}

const arg = (args: readonly ExprValue[], i: number): ExprValue => args[i];

/** Truthiness rules, shared with the evaluator so `if` gates and `bool()` never disagree. */
export function truthy(v: ExprValue): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true; // a non-null object is truthy
}

function toStr(v: ExprValue, fname: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return '';
  throw new ExprError(EXPR_ERRORS.TYPE_ERROR, `${fname}() expects a string, got ${typeName(v)}.`);
}

export function typeName(v: ExprValue): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export const FUNCTIONS: Readonly<Record<string, FnDef>> = {
  /** Length of a string, array, or object (key count). */
  len: {
    minArgs: 1,
    maxArgs: 1,
    fn: (args) => {
      const v = arg(args, 0);
      if (typeof v === 'string') return v.length;
      if (Array.isArray(v)) return v.length;
      if (v !== null && v !== undefined && typeof v === 'object') return Object.keys(v).length;
      if (v === null || v === undefined) return 0;
      throw new ExprError(EXPR_ERRORS.TYPE_ERROR, `len() expects string, array or object.`);
    },
  },

  lower: { minArgs: 1, maxArgs: 1, fn: (a) => toStr(arg(a, 0), 'lower').toLowerCase() },
  upper: { minArgs: 1, maxArgs: 1, fn: (a) => toStr(arg(a, 0), 'upper').toUpperCase() },
  trim: { minArgs: 1, maxArgs: 1, fn: (a) => toStr(arg(a, 0), 'trim').trim() },

  /**
   * Integer coercion. Returns null rather than NaN on failure, because NaN propagating silently
   * through a comparison is exactly the class of bug this language exists to avoid.
   */
  int: {
    minArgs: 1,
    maxArgs: 1,
    fn: (a) => {
      const v = arg(a, 0);
      if (typeof v === 'number') return Math.trunc(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'string') {
        const n = Number(v.trim());
        return v.trim() !== '' && Number.isFinite(n) ? Math.trunc(n) : null;
      }
      return null;
    },
  },

  float: {
    minArgs: 1,
    maxArgs: 1,
    fn: (a) => {
      const v = arg(a, 0);
      if (typeof v === 'number') return v;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'string') {
        const n = Number(v.trim());
        return v.trim() !== '' && Number.isFinite(n) ? n : null;
      }
      return null;
    },
  },

  bool: { minArgs: 1, maxArgs: 1, fn: (a) => truthy(arg(a, 0)) },

  /** Parse a JSON string. Returns null on malformed input rather than throwing. */
  json: {
    minArgs: 1,
    maxArgs: 1,
    fn: (a) => {
      const s = arg(a, 0);
      if (typeof s !== 'string') {
        throw new ExprError(EXPR_ERRORS.TYPE_ERROR, 'json() expects a string.');
      }
      try {
        return JSON.parse(s) as ExprValue;
      } catch {
        return null;
      }
    },
  },

  /** True when a path resolved to something other than undefined. */
  has: { minArgs: 1, maxArgs: 1, fn: (a) => arg(a, 0) !== undefined && arg(a, 0) !== null },

  /** Epoch milliseconds, fixed for the evaluation. */
  now: { minArgs: 0, maxArgs: 0, fn: (_a, ctx) => ctx.nowMs },

  /** First argument that is neither null nor undefined. */
  coalesce: {
    minArgs: 1,
    maxArgs: 8,
    fn: (args) => {
      for (const v of args) if (v !== null && v !== undefined) return v;
      return null;
    },
  },

  /** `default(x, fallback)` — fallback when x is null, undefined, or empty string. */
  default: {
    minArgs: 2,
    maxArgs: 2,
    fn: (a) => {
      const v = arg(a, 0);
      if (v === null || v === undefined || v === '') return arg(a, 1) ?? null;
      return v;
    },
  },

  abs: {
    minArgs: 1,
    maxArgs: 1,
    fn: (a) => {
      const v = arg(a, 0);
      if (typeof v !== 'number') {
        throw new ExprError(EXPR_ERRORS.TYPE_ERROR, 'abs() expects a number.');
      }
      return Math.abs(v);
    },
  },

  round: {
    minArgs: 1,
    maxArgs: 1,
    fn: (a) => {
      const v = arg(a, 0);
      if (typeof v !== 'number') {
        throw new ExprError(EXPR_ERRORS.TYPE_ERROR, 'round() expects a number.');
      }
      return Math.round(v);
    },
  },

  min: {
    minArgs: 2,
    maxArgs: 8,
    fn: (args) => {
      const nums = args.map((v) => {
        if (typeof v !== 'number') {
          throw new ExprError(EXPR_ERRORS.TYPE_ERROR, 'min() expects numbers.');
        }
        return v;
      });
      return Math.min(...nums);
    },
  },

  max: {
    minArgs: 2,
    maxArgs: 8,
    fn: (args) => {
      const nums = args.map((v) => {
        if (typeof v !== 'number') {
          throw new ExprError(EXPR_ERRORS.TYPE_ERROR, 'max() expects numbers.');
        }
        return v;
      });
      return Math.max(...nums);
    },
  },

  /** Split a string. Capped to keep a pathological input from producing a huge array. */
  split: {
    minArgs: 2,
    maxArgs: 2,
    fn: (a, ctx) => {
      const s = toStr(arg(a, 0), 'split');
      const sep = toStr(arg(a, 1), 'split');
      const parts = s.split(sep);
      if (parts.length > ctx.limits.maxIterations) {
        throw new ExprError(EXPR_ERRORS.TOO_COMPLEX, 'split() produced too many parts.');
      }
      return parts;
    },
  },

  join: {
    minArgs: 2,
    maxArgs: 2,
    fn: (a) => {
      const arr = arg(a, 0);
      if (!Array.isArray(arr)) {
        throw new ExprError(EXPR_ERRORS.TYPE_ERROR, 'join() expects an array.');
      }
      const sep = toStr(arg(a, 1), 'join');
      return arr.map((v) => (v === null || v === undefined ? '' : String(v))).join(sep);
    },
  },

  /** ISO 8601 from epoch ms, or from `now()` when called with no argument. */
  iso: {
    minArgs: 0,
    maxArgs: 1,
    fn: (a, ctx) => {
      const ms = a.length === 0 ? ctx.nowMs : arg(a, 0);
      if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw new ExprError(EXPR_ERRORS.TYPE_ERROR, 'iso() expects epoch milliseconds.');
      }
      return new Date(ms).toISOString();
    },
  },
};

export function callFunction(name: string, args: readonly ExprValue[], ctx: FnContext): ExprValue {
  const def = FUNCTIONS[name];
  if (def === undefined) {
    throw new ExprError(EXPR_ERRORS.UNKNOWN_FUNCTION, `Unknown function "${name}".`);
  }
  if (args.length < def.minArgs || args.length > def.maxArgs) {
    const expected =
      def.minArgs === def.maxArgs
        ? `${def.minArgs}`
        : `${def.minArgs}–${def.maxArgs}`;
    throw new ExprError(
      EXPR_ERRORS.BAD_ARITY,
      `${name}() expects ${expected} argument(s), got ${args.length}.`,
    );
  }
  return def.fn(args, ctx);
}
