import { callFunction, truthy, typeName, type FnContext } from './functions.js';
import { FORBIDDEN_SEGMENTS } from './parser.js';
import {
  DEFAULT_LIMITS,
  ExprError,
  EXPR_ERRORS,
  type EvalLimits,
  type ExprValue,
  type Node,
} from './types.js';

export interface EvalOptions {
  readonly limits?: EvalLimits;
  /** Injected so tests are deterministic and two `now()` calls in one expression agree. */
  readonly nowMs?: number;
  /**
   * When true, a path that resolves to nothing throws `expression_unresolved_path` instead of
   * returning undefined.
   *
   * Default false for expressions (a missing path is usually a legitimate falsy check, e.g.
   * `has(steps.x.output.err)`), but the interpolator turns it ON, because a silent `undefined`
   * substituted into an outbound API call is how you corrupt a downstream system.
   */
  readonly strictPaths?: boolean;
}

/** Cache compiled regexes per evaluation. A `matches` inside a loop should not recompile. */
class RegexCache {
  private readonly map = new Map<string, RegExp>();

  constructor(private readonly limits: EvalLimits) {}

  get(pattern: string): RegExp {
    const hit = this.map.get(pattern);
    if (hit !== undefined) return hit;

    if (pattern.length > this.limits.maxRegexPattern) {
      throw new ExprError(
        EXPR_ERRORS.BAD_REGEX,
        `Pattern is too long (max ${this.limits.maxRegexPattern} characters).`,
      );
    }
    let re: RegExp;
    try {
      // No user-supplied flags: a `g` flag would make `.test()` stateful across calls, which is a
      // genuinely surprising bug source. Anchoring is left to the author.
      re = new RegExp(pattern);
    } catch {
      throw new ExprError(EXPR_ERRORS.BAD_REGEX, `Invalid regular expression: ${pattern}`);
    }
    this.map.set(pattern, re);
    return re;
  }
}

class Evaluator {
  private nodes = 0;
  private readonly limits: EvalLimits;
  private readonly fnCtx: FnContext;
  private readonly regexes: RegexCache;
  private readonly strictPaths: boolean;

  constructor(
    private readonly scope: Readonly<Record<string, ExprValue>>,
    opts: EvalOptions,
  ) {
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.fnCtx = { limits: this.limits, nowMs: opts.nowMs ?? Date.now() };
    this.regexes = new RegexCache(this.limits);
    this.strictPaths = opts.strictPaths ?? false;
  }

  /**
   * Counted on every node visit. This is the guard against a short expression with an enormous
   * evaluation cost — the budget is on work done, not on source length.
   */
  private tick(): void {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      throw new ExprError(
        EXPR_ERRORS.TOO_COMPLEX,
        `Expression exceeded the evaluation budget of ${this.limits.maxNodes} steps.`,
      );
    }
  }

  eval(n: Node): ExprValue {
    this.tick();

    switch (n.t) {
      case 'lit':
        return n.v;

      case 'path':
        return this.evalPath(n.segs);

      case 'unary': {
        const x = this.eval(n.x);
        if (n.op === '!') return !truthy(x);
        if (typeof x !== 'number') {
          throw new ExprError(
            EXPR_ERRORS.TYPE_ERROR,
            `Cannot negate ${typeName(x)}; expected a number.`,
          );
        }
        return -x;
      }

      case 'call': {
        const args = n.args.map((a) => this.eval(a));
        return callFunction(n.name, args, this.fnCtx);
      }

      case 'bin':
        return this.evalBinary(n);

      default: {
        // Exhaustiveness: if a node type is added and not handled, this fails to compile.
        const never: never = n;
        throw new ExprError(EXPR_ERRORS.SYNTAX, `Unhandled node ${JSON.stringify(never)}.`);
      }
    }
  }

  private evalBinary(n: Extract<Node, { t: 'bin' }>): ExprValue {
    // Short-circuit BEFORE evaluating the right side. This is not just an optimisation: it is what
    // makes `has(x) && x.y > 1` safe to write under strictPaths.
    if (n.op === '&&') {
      const l = this.eval(n.l);
      return truthy(l) ? truthy(this.eval(n.r)) : false;
    }
    if (n.op === '||') {
      const l = this.eval(n.l);
      return truthy(l) ? true : truthy(this.eval(n.r));
    }

    const l = this.eval(n.l);
    const r = this.eval(n.r);

    switch (n.op) {
      case '==':
        return looseEq(l, r);
      case '!=':
        return !looseEq(l, r);

      case '<':
      case '<=':
      case '>':
      case '>=':
        return compare(n.op, l, r);

      case '+': {
        // String concatenation when either side is a string; arithmetic otherwise. Mirrors the
        // intuition of everyone who has written a template, and is the one overload allowed.
        if (typeof l === 'string' || typeof r === 'string') {
          return `${scalarToString(l)}${scalarToString(r)}`;
        }
        return arith('+', l, r);
      }
      case '-':
        return arith('-', l, r);
      case '*':
        return arith('*', l, r);
      case '/':
        return arith('/', l, r);
      case '%':
        return arith('%', l, r);

      case 'in':
        return this.containsValue(r, l);
      case 'contains':
        return this.containsValue(l, r);

      case 'matches': {
        if (typeof l !== 'string') {
          throw new ExprError(
            EXPR_ERRORS.TYPE_ERROR,
            `"matches" expects a string on the left, got ${typeName(l)}.`,
          );
        }
        if (typeof r !== 'string') {
          throw new ExprError(
            EXPR_ERRORS.TYPE_ERROR,
            `"matches" expects a pattern string on the right, got ${typeName(r)}.`,
          );
        }
        if (l.length > this.limits.maxRegexInput) {
          throw new ExprError(
            EXPR_ERRORS.TOO_COMPLEX,
            `Input to "matches" is too long (max ${this.limits.maxRegexInput} characters).`,
          );
        }
        return this.regexes.get(r).test(l);
      }

      default: {
        const never: never = n.op;
        throw new ExprError(EXPR_ERRORS.SYNTAX, `Unknown operator "${String(never)}".`);
      }
    }
  }

  /** `haystack contains needle` — works over strings, arrays and object keys. */
  private containsValue(haystack: ExprValue, needle: ExprValue): boolean {
    if (typeof haystack === 'string') {
      return haystack.includes(scalarToString(needle));
    }
    if (Array.isArray(haystack)) {
      if (haystack.length > this.limits.maxIterations) {
        throw new ExprError(EXPR_ERRORS.TOO_COMPLEX, 'Array is too large to search.');
      }
      for (const v of haystack) {
        this.tick();
        if (looseEq(v, needle)) return true;
      }
      return false;
    }
    if (haystack !== null && haystack !== undefined && typeof haystack === 'object') {
      return Object.prototype.hasOwnProperty.call(haystack, scalarToString(needle));
    }
    if (haystack === null || haystack === undefined) return false;
    throw new ExprError(
      EXPR_ERRORS.TYPE_ERROR,
      `Cannot search inside ${typeName(haystack)}.`,
    );
  }

  private evalPath(segs: readonly import('./types.js').PathSeg[]): ExprValue {
    let cur: ExprValue = this.scope;
    const trail: string[] = [];

    for (const seg of segs) {
      this.tick();

      let key: string;
      if (seg.k === 'prop') {
        key = seg.name;
      } else {
        const idx = this.eval(seg.expr);
        if (typeof idx === 'number') {
          if (!Number.isInteger(idx)) {
            throw new ExprError(
              EXPR_ERRORS.TYPE_ERROR,
              `Array index must be a whole number, got ${idx}.`,
            );
          }
          key = String(idx);
        } else if (typeof idx === 'string') {
          // Computed string indices are checked here; constant ones were caught at parse time.
          if (FORBIDDEN_SEGMENTS.has(idx)) {
            throw new ExprError(
              EXPR_ERRORS.UNSAFE_PATH,
              `"${idx}" is not an accessible property.`,
            );
          }
          key = idx;
        } else {
          throw new ExprError(
            EXPR_ERRORS.TYPE_ERROR,
            `Index must be a number or string, got ${typeName(idx)}.`,
          );
        }
      }

      trail.push(key);

      if (cur === null || cur === undefined) {
        if (this.strictPaths) {
          throw new ExprError(
            EXPR_ERRORS.UNRESOLVED,
            `"${trail.join('.')}" could not be resolved.`,
          );
        }
        return undefined;
      }

      if (typeof cur !== 'object') {
        // Reading a property off a string/number is not an error worth failing a run over unless
        // strict; returning undefined keeps `x.y == null` checks usable.
        if (this.strictPaths) {
          throw new ExprError(
            EXPR_ERRORS.UNRESOLVED,
            `"${trail.join('.')}" is not reachable: ${typeName(cur)} has no properties.`,
          );
        }
        return undefined;
      }

      if (Array.isArray(cur)) {
        // Bind to an explicitly typed local before touching .length or indexing. Reading those
        // straight off the recursive ExprValue union sends TS into a circular `any` inference
        // (TS7022) under noUncheckedIndexedAccess.
        const list: readonly ExprValue[] = cur;
        const i = Number(key);
        if (!Number.isInteger(i)) {
          if (this.strictPaths) {
            throw new ExprError(
              EXPR_ERRORS.UNRESOLVED,
              `"${trail.join('.')}" is not a valid array index.`,
            );
          }
          return undefined;
        }
        // Negative indices count from the end, which is what people expect from `items[-1]`.
        const at = i < 0 ? list.length + i : i;
        // Annotated: indexing the recursive ExprValue union under noUncheckedIndexedAccess makes
        // TS fall back to a circular `any` inference (TS7022) without it.
        const v: ExprValue = list[at];
        if (v === undefined && this.strictPaths) {
          throw new ExprError(
            EXPR_ERRORS.UNRESOLVED,
            `"${trail.join('.')}" is out of range (length ${list.length}).`,
          );
        }
        cur = v;
        continue;
      }

      // Own properties only. An inherited property is never a legitimate target here, and this is
      // the second line of defence behind the parse-time segment check.
      if (!Object.prototype.hasOwnProperty.call(cur, key)) {
        if (this.strictPaths) {
          throw new ExprError(
            EXPR_ERRORS.UNRESOLVED,
            `"${trail.join('.')}" could not be resolved.`,
          );
        }
        return undefined;
      }

      cur = (cur as Record<string, ExprValue>)[key];
    }

    return cur;
  }
}

function scalarToString(v: ExprValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v) ?? '';
  return String(v);
}

/**
 * Equality. Deliberately NOT JavaScript's `==`: no string/number coercion, because
 * `"0" == 0` being true is a footgun in a rules language. null and undefined are treated as the
 * same absence, which is the one coercion that earns its place — a missing JSON key and an
 * explicit null mean the same thing to the person writing the rule.
 */
function looseEq(a: ExprValue, b: ExprValue): boolean {
  const aNil = a === null || a === undefined;
  const bNil = b === null || b === undefined;
  if (aNil || bNil) return aNil && bNil;

  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (typeof a === 'object') {
    // Structural comparison via canonical JSON. Adequate for the shapes this language sees
    // (parsed JSON), and avoids shipping a deep-equal dependency.
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b as ExprValue));
  }
  return a === b;
}

function sortKeys(v: ExprValue): ExprValue {
  if (Array.isArray(v)) {
    // Annotated explicitly: passing `sortKeys` by reference to `.map` inside its own body makes
    // TS unable to infer the element type (TS7022, circular initializer).
    const arr: ExprValue[] = v.map((el: ExprValue): ExprValue => sortKeys(el));
    return arr;
  }
  if (v !== null && v !== undefined && typeof v === 'object') {
    const out: Record<string, ExprValue> = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortKeys((v as Record<string, ExprValue>)[k]);
    }
    return out;
  }
  return v;
}

function compare(op: '<' | '<=' | '>' | '>=', l: ExprValue, r: ExprValue): boolean {
  // Numbers compare numerically; strings lexicographically. Mixed types are an error rather than
  // a silent coercion, because `"10" < 9` being true has cost people real money.
  if (typeof l === 'number' && typeof r === 'number') {
    return op === '<' ? l < r : op === '<=' ? l <= r : op === '>' ? l > r : l >= r;
  }
  if (typeof l === 'string' && typeof r === 'string') {
    return op === '<' ? l < r : op === '<=' ? l <= r : op === '>' ? l > r : l >= r;
  }
  throw new ExprError(
    EXPR_ERRORS.TYPE_ERROR,
    `Cannot compare ${typeName(l)} with ${typeName(r)} using "${op}".`,
  );
}

function arith(op: '+' | '-' | '*' | '/' | '%', l: ExprValue, r: ExprValue): number {
  if (typeof l !== 'number' || typeof r !== 'number') {
    throw new ExprError(
      EXPR_ERRORS.TYPE_ERROR,
      `Cannot apply "${op}" to ${typeName(l)} and ${typeName(r)}.`,
    );
  }
  switch (op) {
    case '+':
      return l + r;
    case '-':
      return l - r;
    case '*':
      return l * r;
    case '/':
      if (r === 0) throw new ExprError(EXPR_ERRORS.TYPE_ERROR, 'Division by zero.');
      return l / r;
    case '%':
      if (r === 0) throw new ExprError(EXPR_ERRORS.TYPE_ERROR, 'Modulo by zero.');
      return l % r;
    default: {
      const never: never = op;
      throw new ExprError(EXPR_ERRORS.SYNTAX, `Unknown operator ${String(never)}.`);
    }
  }
}

/** Evaluate a parsed AST against a scope. Pure: no I/O, no host access. */
export function evaluate(
  ast: Node,
  scope: Readonly<Record<string, ExprValue>>,
  opts: EvalOptions = {},
): ExprValue {
  return new Evaluator(scope, opts).eval(ast);
}
