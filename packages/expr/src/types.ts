/**
 * AST for the Klankish expression language.
 *
 * Deliberately small. The grammar is frozen in docs/tech-spec.md §6 — additions need a written
 * reason, because this is the one place user-authored input is interpreted, and every new node
 * type is new attack surface.
 *
 * There is no `eval`, no `new Function`, and no dependency anywhere in this package.
 */

export type Node =
  | { readonly t: 'lit'; readonly v: string | number | boolean | null }
  | { readonly t: 'path'; readonly segs: readonly PathSeg[] }
  | { readonly t: 'unary'; readonly op: UnaryOp; readonly x: Node }
  | { readonly t: 'bin'; readonly op: BinaryOp; readonly l: Node; readonly r: Node }
  | { readonly t: 'call'; readonly name: string; readonly args: readonly Node[] };

/**
 * A path segment is either a static property name or a computed index.
 *
 * Computed indices (`items[i]`, `items[len(x) - 1]`) are why this is a tagged union rather than a
 * plain string array: the index is itself an expression and must be evaluated in scope.
 */
export type PathSeg =
  | { readonly k: 'prop'; readonly name: string }
  | { readonly k: 'index'; readonly expr: Node };

export type UnaryOp = '!' | '-';

export type BinaryOp =
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | '&&'
  | '||'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | 'in'
  | 'contains'
  | 'matches';

/** Values an expression can produce. Deliberately JSON-shaped — no functions, no symbols. */
export type ExprValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly ExprValue[]
  | { readonly [k: string]: ExprValue };

export interface EvalLimits {
  /** Max AST nodes visited. Guards against a small expression with a huge evaluation cost. */
  readonly maxNodes: number;
  /** Max characters of any string a regex is tested against. */
  readonly maxRegexInput: number;
  /** Max characters in a regex pattern. */
  readonly maxRegexPattern: number;
  /** Max elements walked by `in` / `contains` over an array. */
  readonly maxIterations: number;
}

export const DEFAULT_LIMITS: EvalLimits = {
  maxNodes: 10_000,
  maxRegexInput: 100_000,
  maxRegexPattern: 500,
  maxIterations: 100_000,
};

/**
 * Failure identities. These are stable strings: they surface to the user as the reason a step
 * failed, and the API branches on them, so renaming one is a breaking change.
 */
export const EXPR_ERRORS = {
  SYNTAX: 'expression_syntax_error',
  UNKNOWN_FUNCTION: 'expression_unknown_function',
  BAD_ARITY: 'expression_bad_arity',
  UNSAFE_PATH: 'expression_unsafe_path',
  TOO_COMPLEX: 'expression_too_complex',
  BAD_REGEX: 'expression_bad_regex',
  TYPE_ERROR: 'expression_type_error',
  UNRESOLVED: 'expression_unresolved_path',
} as const;

export type ExprErrorIdentity = (typeof EXPR_ERRORS)[keyof typeof EXPR_ERRORS];

export class ExprError extends Error {
  constructor(
    readonly identity: ExprErrorIdentity,
    message: string,
    readonly position?: number,
  ) {
    super(message);
    this.name = 'ExprError';
  }
}
