import { tokenize, type Token } from './lexer.js';
import { ExprError, EXPR_ERRORS, type BinaryOp, type Node, type PathSeg } from './types.js';

/**
 * Binding powers. Higher binds tighter. Standard precedence, with the three word operators
 * (`in`, `contains`, `matches`) sharing the comparison tier.
 */
const BP: Readonly<Record<string, number>> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
  in: 4,
  contains: 4,
  matches: 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

/**
 * Path segments that would reach the prototype chain are rejected at PARSE time, not evaluation
 * time. Rejecting early means a stored task graph cannot contain such an expression at all, so the
 * guard cannot be bypassed by a later code path that forgets to check.
 */
const FORBIDDEN_SEGMENTS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

const KEYWORD_LITERALS: Readonly<Record<string, boolean | null>> = {
  true: true,
  false: false,
  null: null,
};

class Parser {
  private i = 0;

  constructor(private readonly toks: readonly Token[]) {}

  private peek(): Token {
    const t = this.toks[this.i];
    if (t === undefined) {
      throw new ExprError(EXPR_ERRORS.SYNTAX, 'Unexpected end of expression.');
    }
    return t;
  }

  private next(): Token {
    const t = this.peek();
    this.i += 1;
    return t;
  }

  private expect(kind: Token['kind'], what: string): Token {
    const t = this.peek();
    if (t.kind !== kind) {
      throw new ExprError(
        EXPR_ERRORS.SYNTAX,
        `Expected ${what} but found "${t.text || 'end of expression'}".`,
        t.pos,
      );
    }
    return this.next();
  }

  parse(): Node {
    const n = this.expr(0);
    const t = this.peek();
    if (t.kind !== 'eof') {
      throw new ExprError(EXPR_ERRORS.SYNTAX, `Unexpected "${t.text}" after expression.`, t.pos);
    }
    return n;
  }

  /** Pratt loop: parse a prefix, then absorb infix operators while they bind tightly enough. */
  private expr(minBp: number): Node {
    let left = this.prefix();

    for (;;) {
      const t = this.peek();
      if (t.kind !== 'op') break;
      const bp = BP[t.text];
      if (bp === undefined || bp < minBp) break;
      this.next();
      // All binary operators here are left-associative, hence bp + 1.
      const right = this.expr(bp + 1);
      left = { t: 'bin', op: t.text as BinaryOp, l: left, r: right };
    }

    return left;
  }

  private prefix(): Node {
    const t = this.next();

    switch (t.kind) {
      case 'num':
      case 'str':
        return { t: 'lit', v: t.value ?? null };

      case 'op': {
        if (t.text === '!' || t.text === '-') {
          // Unary binds tighter than every binary operator, so parse at the top tier.
          const x = this.expr(7);
          return { t: 'unary', op: t.text, x };
        }
        throw new ExprError(EXPR_ERRORS.SYNTAX, `Operator "${t.text}" needs a left operand.`, t.pos);
      }

      case 'lparen': {
        const inner = this.expr(0);
        this.expect('rparen', '")"');
        return inner;
      }

      case 'ident': {
        if (t.text in KEYWORD_LITERALS) {
          const v = KEYWORD_LITERALS[t.text];
          return { t: 'lit', v: v === undefined ? null : v };
        }
        // A function call is an identifier immediately followed by "(".
        if (this.peek().kind === 'lparen') {
          this.next();
          const args: Node[] = [];
          if (this.peek().kind !== 'rparen') {
            for (;;) {
              args.push(this.expr(0));
              if (this.peek().kind === 'comma') {
                this.next();
                continue;
              }
              break;
            }
          }
          this.expect('rparen', '")" to close the argument list');
          return { t: 'call', name: t.text, args };
        }
        return { t: 'path', segs: this.pathTail([{ k: 'prop', name: this.checkSeg(t) }]) };
      }

      default:
        throw new ExprError(
          EXPR_ERRORS.SYNTAX,
          `Unexpected "${t.text || 'end of expression'}".`,
          t.pos,
        );
    }
  }

  private checkSeg(t: Token): string {
    if (FORBIDDEN_SEGMENTS.has(t.text)) {
      throw new ExprError(
        EXPR_ERRORS.UNSAFE_PATH,
        `"${t.text}" is not an accessible property.`,
        t.pos,
      );
    }
    return t.text;
  }

  /** Absorb `.prop` and `[expr]` suffixes onto a path. */
  private pathTail(segs: PathSeg[]): PathSeg[] {
    for (;;) {
      const t = this.peek();
      if (t.kind === 'dot') {
        this.next();
        const name = this.peek();
        if (name.kind !== 'ident') {
          throw new ExprError(
            EXPR_ERRORS.SYNTAX,
            `Expected a property name after "." but found "${name.text}".`,
            name.pos,
          );
        }
        this.next();
        segs.push({ k: 'prop', name: this.checkSeg(name) });
        continue;
      }
      if (t.kind === 'lbracket') {
        this.next();
        const idx = this.expr(0);
        this.expect('rbracket', '"]"');
        // A constant string index is checked now; a computed one is checked at evaluation.
        if (idx.t === 'lit' && typeof idx.v === 'string' && FORBIDDEN_SEGMENTS.has(idx.v)) {
          throw new ExprError(EXPR_ERRORS.UNSAFE_PATH, `"${idx.v}" is not an accessible property.`);
        }
        segs.push({ k: 'index', expr: idx });
        continue;
      }
      return segs;
    }
  }
}

/** Parse source into an AST. Throws `ExprError` with a stable identity on bad input. */
export function parse(src: string): Node {
  if (src.length > 4000) {
    throw new ExprError(EXPR_ERRORS.TOO_COMPLEX, 'Expression is too long (max 4000 characters).');
  }
  return new Parser(tokenize(src)).parse();
}

export { FORBIDDEN_SEGMENTS };
